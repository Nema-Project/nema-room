import { z, ZodError } from "zod";
import { KnowledgeStore } from "@nema/knowledge";
import { DIAGRAM_TYPES, kindFromId } from "@nema/shared";
import { renderDiagram, validateDiagram } from "./archify.js";
import type { DaemonRpc } from "./daemonRpc.js";
import type { Db } from "./db/db.js";
import type { EventBus } from "./events.js";
import { indexEntry } from "./entryIndex.js";
import { findRepoForWorkspace, getRepo } from "./repos.js";
import { getTask, recordTaskChange } from "./tasks.js";
import { repoPath } from "./workspaces.js";
import { callWorkPackageFunction } from "./workpackages.js";

/** Diagram validation and rendering. Tests inject a fake; the hub uses the vendored archify. */
export type Archify = {
  validateDiagram: typeof validateDiagram;
  renderDiagram: typeof renderDiagram;
};

export const vendoredArchify: Archify = { validateDiagram, renderDiagram };

export type DiagramDeps = { db: Db; dataDir: string; events: EventBus; archify: Archify; daemon?: DaemonRpc };

/** What the Room route sends back: `{ result }` on 200, `{ error }` otherwise. `ok` feeds `plugin_calls`. */
export type HubCallOutcome =
  | { status: 200; result: unknown; ok: boolean }
  | { status: 400 | 404; error: string };

const DIAGRAM_ID = /^G-[1-9]\d*$/;

const SaveArgs = z
  .object({
    repo: z.string(),
    type: z.enum(DIAGRAM_TYPES),
    title: z.string().min(1).max(200),
    summary: z.string(),
    spec: z.record(z.string(), z.unknown()),
    nodePaths: z.record(z.string(), z.array(z.string())),
    id: z.string().regex(DIAGRAM_ID).optional(),
  })
  .strict();

const ReadArgs = z.object({ id: z.string() }).strict();

function issues(e: ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ");
}

function argsObject(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/** Answer a `runsOn: "hub"` plugin function. These calls never reach the daemon. */
export async function callHubFunction(
  deps: DiagramDeps,
  auth: { taskId: string; workspaceId: string },
  name: string,
  args: unknown,
): Promise<HubCallOutcome> {
  if (name === "diagram__save") return saveDiagram(deps, auth, args);
  if (name === "diagram__read") return readDiagram(deps, auth.workspaceId, args);
  if (name.startsWith("workpackage__")) {
    if (!deps.daemon) return { status: 404, error: `未知函数 ${name}` };
    return callWorkPackageFunction({ db: deps.db, dataDir: deps.dataDir, events: deps.events, daemon: deps.daemon }, auth, name, args);
  }
  return { status: 404, error: `未知函数 ${name}` };
}

async function saveDiagram(deps: DiagramDeps, auth: { taskId: string; workspaceId: string }, args: unknown): Promise<HubCallOutcome> {
  const { db, dataDir, events, archify } = deps;
  const { taskId, workspaceId } = auth;
  const repoRef = argsObject(args).repo;
  const repo = typeof repoRef === "string" ? await findRepoForWorkspace(db, workspaceId, repoRef) : null;
  if (!repo) {
    return { status: 400, error: `repo 不是本 workspace 绑定的仓库：${typeof repoRef === "string" ? repoRef : (JSON.stringify(repoRef) ?? "")}` };
  }
  const parsed = SaveArgs.safeParse(args);
  if (!parsed.success) return { status: 400, error: `参数无效：${issues(parsed.error)}` };
  const input = parsed.data;

  const store = new KnowledgeStore(repoPath(dataDir, workspaceId));
  if (input.id !== undefined && (await store.get(input.id)) === null) {
    return { status: 404, error: `找不到图：${input.id}` };
  }

  // Diagnostics go back as an ordinary result so the Agent can fix the spec and retry. Nothing is written.
  const checked = await archify.validateDiagram(input.type, input.spec);
  if (!checked.ok) return { status: 200, result: { ok: false, diagnostics: checked.diagnostics }, ok: false };

  const task = await getTask(db, taskId);
  let saved;
  try {
    saved = await store.writeDiagram(
      {
        ...(input.id !== undefined ? { id: input.id } : {}),
        title: input.title,
        body: input.summary,
        diagram: {
          repoId: repo.id,
          type: input.type,
          // ponytail: a repo whose main sha is not known yet records no commit; Task 6 then cannot flag it stale.
          sourceCommits: repo.lastMainSha !== null ? { [repo.id]: repo.lastMainSha } : {},
          nodePaths: input.nodePaths,
        },
        spec: input.spec,
        reason: `画图：${input.title}`,
        sourceMessages: task ? [task.messageId] : [],
      },
      { author: "agent", taskId },
    );
  } catch (e) {
    if (e instanceof ZodError) return { status: 400, error: `参数无效：${issues(e)}` };
    throw e;
  }
  const { entry, commit, op } = saved;
  // The commit is durable; failures below must not make the Agent retry (duplicate diagram).
  try {
    await indexEntry(db, workspaceId, entry);
    // A fresh drawing matches the code it was drawn from.
    await setDiagramStatus(db, workspaceId, entry.id, false, repo.lastMainSha);
    await recordTaskChange(db, taskId, { entryId: entry.id, kind: entry.kind, title: entry.title, op });
    events.emit(workspaceId, { type: "knowledge.changed", entryId: entry.id });
  } catch (e) {
    console.error(`diagram__save: post-commit bookkeeping failed for ${entry.id} (commit ${commit})`, e);
  }
  return { status: 200, result: { ok: true, id: entry.id }, ok: true };
}

async function readDiagram(deps: DiagramDeps, workspaceId: string, args: unknown): Promise<HubCallOutcome> {
  const parsed = ReadArgs.safeParse(args);
  if (!parsed.success) return { status: 400, error: `参数无效：${issues(parsed.error)}` };
  const { id } = parsed.data;
  const store = new KnowledgeStore(repoPath(deps.dataDir, workspaceId));
  const entry = kindFromId(id) === "diagram" ? await store.get(id) : null;
  if (!entry) return { status: 404, error: `找不到图：${id}` };
  return { status: 200, result: { entry, spec: await store.readDiagramSpec(id) }, ok: true };
}

async function setDiagramStatus(db: Db, workspaceId: string, entryId: string, stale: boolean, checkedSha: string | null): Promise<void> {
  await db.query(
    `insert into diagram_status (workspace_id, entry_id, stale, checked_sha) values ($1, $2, $3, $4)
     on conflict (workspace_id, entry_id) do update set stale = excluded.stale, checked_sha = excluded.checked_sha`,
    [workspaceId, entryId, stale, checkedSha],
  );
}

/** `a/b` covers `a/b` and `a/b/c`, not `a/bc`. An empty path (or `.`) covers the whole repo. */
function covers(nodePath: string, changed: string): boolean {
  const base = nodePath.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (base === "" || base === ".") return true;
  return changed === base || changed.startsWith(`${base}/`);
}

function changedPaths(result: unknown): string[] {
  if (!Array.isArray(result)) throw new Error("invalid repo.changes result");
  return result.map((row) => {
    const p = (row as { path?: unknown } | null)?.path;
    if (typeof p !== "string") throw new Error("invalid repo.changes result");
    return p;
  });
}

/**
 * After main moves, flags each active diagram of that repo whose node paths the move touched since the
 * diagram was drawn. A daemon error leaves the status as it was. Never redraws anything.
 */
export async function onRepoMoved(
  db: Db,
  dataDir: string,
  daemon: DaemonRpc,
  events: EventBus,
  move: { repoId: string; to: string },
): Promise<void> {
  const repo = await getRepo(db, move.repoId);
  if (!repo) return;
  const rows = await db.query<{ entry_id: string }>(
    `select entry_id from entry_index where workspace_id = $1 and kind = 'diagram' and status = 'active' order by entry_id`,
    [repo.workspaceId],
  );
  const store = new KnowledgeStore(repoPath(dataDir, repo.workspaceId));
  // Diagrams drawn at the same commit share one diff.
  const diffs = new Map<string, Promise<string[]>>();
  for (const { entry_id: entryId } of rows) {
    const entry = await store.get(entryId);
    const meta = entry?.diagram;
    if (!meta || meta.repoId !== repo.id) continue;
    const from = meta.sourceCommits[repo.id];
    if (from === undefined) continue; // drawn before main's sha was known: nothing to compare against
    let diff = diffs.get(from);
    if (!diff) {
      diff = daemon
        .call("repo.changes", {
          workspaceId: repo.workspaceId,
          repoId: repo.id,
          path: repo.path,
          mainBranch: repo.mainBranch,
          from,
          to: move.to,
        })
        .then(changedPaths);
      diffs.set(from, diff);
    }
    let changed: string[];
    try {
      changed = await diff;
    } catch (error) {
      console.error(`repo.changes failed for ${entryId} (${repo.id} ${from}..${move.to})`, error);
      continue;
    }
    const nodePaths = Object.values(meta.nodePaths).flat();
    const stale = changed.some((p) => nodePaths.some((n) => covers(n, p)));
    const before = await db.query<{ stale: boolean }>(
      `select stale from diagram_status where workspace_id = $1 and entry_id = $2`,
      [repo.workspaceId, entryId],
    );
    await setDiagramStatus(db, repo.workspaceId, entryId, stale, move.to);
    if ((before[0]?.stale ?? false) !== stale) events.emit(repo.workspaceId, { type: "knowledge.changed", entryId });
  }
}
