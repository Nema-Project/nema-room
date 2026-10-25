import { Hono } from "hono";
import { ZodError } from "zod";
import { KnowledgeStore } from "@nema/knowledge";
import { UpsertEntryInput, pluginFunction, reportPassed, type GetEntryResponse, type Implementation, type ReportMessageMeta, type ListEntriesResponse, type UpsertEntryResponse } from "@nema/shared";
import type { Db } from "./db/db.js";
import { DaemonRpcError, INDEX_RPC_TIMEOUT_MS, type DaemonRpc } from "./daemonRpc.js";
import { callHubFunction, vendoredArchify, type Archify } from "./diagrams.js";
import type { EventBus } from "./events.js";
import { indexEntry } from "./entryIndex.js";
import { checkGithubCall, githubTargets } from "./githubScope.js";
import { daemonHttpStatus, enabledPluginTools, recordPluginCall } from "./plugins.js";
import { findRepoForWorkspace, listRepos } from "./repos.js";
import { recordTaskChange, resolveRunToken } from "./tasks.js";
import { repoPath } from "./workspaces.js";
import { retryBlockedPackages } from "./workpackages.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

/** The daemon gives each GitHub call 60 s; waiting longer lets its own error arrive instead of a hub timeout. */
const GITHUB_RPC_TIMEOUT_MS = 90_000;

type Auth = { taskId: string; workspaceId: string };

export function roomRoutes(deps: {
  db: Db;
  dataDir: string;
  events: EventBus;
  daemon: DaemonRpc;
  /** Defaults to the vendored archify. */
  archify?: Archify;
  ownedHelpers?: OwnedHelperScope;
}): Hono<{ Variables: { auth: Auth } }> {
  const { db, dataDir, events, daemon } = deps;
  const archify = deps.archify ?? vendoredArchify;
  const app = new Hono<{ Variables: { auth: Auth } }>();

  app.use("*", async (c, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    const auth = m ? await resolveRunToken(db, m[1]!) : null;
    if (!auth) return c.json({ error: "missing or invalid run token" }, 401);
    c.set("auth", auth);
    await next();
  });

  const store = (ws: string) => new KnowledgeStore(repoPath(dataDir, ws), deps.ownedHelpers);

  app.get("/entries", async (c) => {
    const body: ListEntriesResponse = { entries: await store(c.get("auth").workspaceId).list() };
    return c.json(body);
  });

  app.get("/entries/:id", async (c) => {
    const entry = await store(c.get("auth").workspaceId).get(c.req.param("id"));
    if (!entry) return c.json({ error: `entry not found: ${c.req.param("id")}` }, 404);
    const body: GetEntryResponse = { entry };
    return c.json(body);
  });

  app.post("/entries", async (c) => {
    const { taskId, workspaceId } = c.get("auth");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    const parsed = UpsertEntryInput.safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
      return c.json({ error: `invalid entry: ${msg}` }, 400);
    }
    const input = parsed.data;
    if (input.sourceMessages.length === 0) {
      return c.json({ error: "sourceMessages: at least one source message id is required" }, 400);
    }
    const ids = [...new Set(input.sourceMessages)];
    const found = await db.query<{ id: string; role: string; content: string }>(
      `select id, role, content from messages where workspace_id = $1 and id = any($2::text[])`,
      [workspaceId, ids],
    );
    const have = new Set(found.map((r) => r.id));
    const bad = ids.filter((i) => !have.has(i));
    if (bad.length > 0) {
      return c.json({ error: `sourceMessages: unknown message id(s) in this workspace: ${bad.join(", ")}` }, 400);
    }
    if (input.basis === undefined) {
      return c.json({ error: "basis: required (stated | decided | inferred)" }, 400);
    }
    const byId = new Map(found.map((r) => [r.id, r]));
    for (const quote of input.quotes ?? []) {
      if (!input.sourceMessages.includes(quote.messageId)) {
        return c.json({ error: `quotes: message ${quote.messageId} is not in sourceMessages` }, 400);
      }
      // Exact substring: do not trim, collapse whitespace, or normalize Markdown.
      const message = byId.get(quote.messageId);
      if (!message || !message.content.includes(quote.text)) {
        return c.json({ error: `quotes: text must be copied verbatim from message ${quote.messageId}` }, 400);
      }
    }
    if (input.implementation !== undefined) {
      const refused = await implementationRefusal(db, workspaceId, input.implementation);
      if (refused) return c.json({ error: refused }, 409);
    }
    const ks = store(workspaceId);
    const existing = input.id !== undefined ? await ks.get(input.id) : null;
    if (input.id !== undefined && !existing) {
      return c.json({ error: `entry not found: ${input.id}` }, 404);
    }
    let toSave = input;
    if (existing && existing.kind === "decision" && existing.status === "active") {
      const leavesActive = input.status !== undefined && input.status !== "active";
      const rewrites = leavesActive || input.title !== existing.title || input.body !== existing.body;
      const userBasis = input.basis === "stated" || input.basis === "decided";
      const citesUser = input.sourceMessages.some((id) => byId.get(id)?.role === "user");
      // Raising the basis claims the user said or decided it, so it needs the same evidence as a rewrite.
      const raisesBasis = userBasis && input.basis !== existing.basis;
      if (!rewrites && !userBasis) {
        // A related-only update never downgrades the decision's basis.
        toSave = { ...input, basis: existing.basis ?? undefined };
      }
      if ((rewrites || raisesBasis) && (!userBasis || !citesUser)) {
        return c.json(
          {
            error: `改写已定决策 ${existing.id} 需要用户消息作为依据（basis 为 stated 或 decided，且 sourceMessages 含用户消息）。若只是推断，请不要改它，改为新建一条 question 询问用户。`,
          },
          409,
        );
      }
    }
    let result;
    try {
      result = await ks.upsert(toSave, { author: "agent", taskId });
    } catch (e) {
      if (e instanceof ZodError) {
        const msg = e.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
        return c.json({ error: `invalid entry: ${msg}` }, 400);
      }
      console.error("room upsert failed", e);
      return c.json({ error: "internal error while saving entry" }, 500);
    }
    const { entry, commit, op } = result;
    // The commit is durable; failures below must not make the Agent retry (duplicate entry).
    try {
      await indexEntry(db, workspaceId, entry, deps.ownedHelpers);
      await recordTaskChange(db, taskId, { entryId: entry.id, kind: entry.kind, title: entry.title, op });
      events.emit(workspaceId, { type: "knowledge.changed", entryId: entry.id });
    } catch (e) {
      console.error(`room upsert: post-commit bookkeeping failed for ${entry.id} (commit ${commit})`, e);
    }
    await retryBlockedPackages(db, dataDir, events, workspaceId, entry, "agent", deps.ownedHelpers);
    const body: UpsertEntryResponse = { entry, commit };
    return c.json(body);
  });

  app.get("/plugins", async (c) => c.json({ tools: await enabledPluginTools(db, c.get("auth").workspaceId) }));

  app.post("/plugins/:name", async (c) => {
    const { taskId, workspaceId } = c.get("auth");
    const name = c.req.param("name");
    const tools = await enabledPluginTools(db, workspaceId);
    // Check 1. A miss is not a call: no plugin_calls row, and the daemon is not contacted.
    if (!tools.some((tool) => tool.name === name)) return c.json({ error: `函数 ${name} 未在本 workspace 开启` }, 403);

    const started = Date.now();
    let raw = "";
    try {
      raw = await c.req.text();
    } catch {
      raw = "";
    }
    let args: unknown;
    try {
      args = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      args = undefined;
    }
    const summary = raw.slice(0, 200);
    let recorded = false;
    const record = async (ok: boolean, resultBytes: number) => {
      if (recorded) return;
      await recordPluginCall(db, { taskId, name, argsSummary: summary, ok, resultBytes, ms: Date.now() - started });
      recorded = true;
    };

    try {
      if (pluginFunction(name)?.plugin.runsOn === "hub") {
        const outcome = await callHubFunction({ db, dataDir, events, archify, daemon, ownedHelpers: deps.ownedHelpers }, { taskId, workspaceId }, name, args);
        if (outcome.status !== 200) {
          await record(false, 0);
          return c.json({ error: outcome.error }, outcome.status);
        }
        const encoded = JSON.stringify(outcome.result);
        await record(outcome.ok, encoded === undefined ? 0 : Buffer.byteLength(encoded));
        return c.json({ result: outcome.result });
      }
      if (pluginFunction(name)?.plugin.scope === "github") {
        // No repo id here: the target is owner/repo (or a search's repo: qualifier), checked against the
        // GitHub remotes of this workspace's bound repos before anything reaches the daemon.
        const callArgs = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
        const check = checkGithubCall(name, callArgs, githubTargets(await listRepos(db, workspaceId)));
        if (!check.ok) {
          await record(false, 0);
          return c.json({ error: check.error }, 400);
        }
        const result = await daemon.call("plugin.call", { name, args: check.args ?? callArgs }, GITHUB_RPC_TIMEOUT_MS);
        const encoded = JSON.stringify(result);
        await record(true, encoded === undefined ? 0 : Buffer.byteLength(encoded));
        return c.json({ result });
      }
      const repoRef = stringRepo(args);
      const repo = repoRef !== undefined ? await findRepoForWorkspace(db, workspaceId, repoRef) : null;
      if (!repo) {
        await record(false, 0);
        return c.json({ error: `repo 不是本 workspace 绑定的仓库：${repoRef ?? badRepoValue(args)}` }, 400);
      }
      const result = await daemon.call("plugin.call", {
        name,
        args,
        repo: { workspaceId: repo.workspaceId, repoId: repo.id, path: repo.path, mainBranch: repo.mainBranch },
      }, INDEX_RPC_TIMEOUT_MS);
      const encoded = JSON.stringify(result);
      await record(true, encoded === undefined ? 0 : Buffer.byteLength(encoded));
      return c.json({ result });
    } catch (error) {
      // Check 1 already passed, including when lookup or the daemon call throws.
      if (!recorded) await record(false, 0);
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, daemonHttpStatus(error.message));
      throw error;
    }
  });

  return app;
}

function stringRepo(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const repo = (args as Record<string, unknown>).repo;
  return typeof repo === "string" ? repo : undefined;
}

function badRepoValue(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args) || !("repo" in args)) return "";
  return JSON.stringify((args as Record<string, unknown>).repo) ?? "";
}

export const VERIFIED_NEEDS_REPORT = "实现状态 verified 需要一条核实通过的上报作为证据（evidence.reportMessageId）。";
export const INFERRED_NOT_VERIFIED = "代码推断的实现只能由用户确认为 verified。";
export const CONFIRMED_BY_USER_ONLY = "confirmedBy 只能由用户确认设置。";

/** Same commit when one sha is a prefix of the other (reports may use abbreviated shas). */
function sameCommit(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Why the Agent may not save this implementation, or null when it may. `verified` needs a `report` message
 * of this workspace whose stored check passed, and every cited commit must be one of that report's commits.
 */
async function implementationRefusal(db: Db, workspaceId: string, impl: Implementation): Promise<string | null> {
  const ev = impl.evidence;
  if (ev.confirmedBy !== null) return CONFIRMED_BY_USER_ONLY;
  if (impl.status !== "verified") return null;
  if (ev.inferred) return INFERRED_NOT_VERIFIED;
  if (ev.reportMessageId === null) return VERIFIED_NEEDS_REPORT;
  const rows = await db.query<{ meta: ReportMessageMeta | null }>(
    `select meta from messages where id = $1 and workspace_id = $2 and role = 'report'`,
    [ev.reportMessageId, workspaceId],
  );
  const meta = rows[0]?.meta;
  if (!meta?.check || !reportPassed(meta.check)) return VERIFIED_NEEDS_REPORT;
  const reported = meta.report.commits;
  if (!ev.commits.every((sha) => sha !== "" && reported.some((r) => sameCommit(r, sha)))) return VERIFIED_NEEDS_REPORT;
  return null;
}
