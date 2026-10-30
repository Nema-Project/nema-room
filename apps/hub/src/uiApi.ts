import { sourceEvidenceEntries, sourceEvidenceSummary } from "./sourceFreshness.js";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z, ZodError } from "zod";
import { KnowledgeStore, blameParagraphs, git, history, versionAt, parseCommitMessage } from "@nema/knowledge";
import { KNOWLEDGE_LANGUAGES, UpsertEntryInput, kindFromId, canonicalJson, parseSkillSource, safeRepoPath } from "@nema/shared";
import { entryContentHash, refsHash, relatedSnapshotHash } from "./evidencePayload.js";
import { insertEvidenceEvent, consumeEvidenceEvent, reconcileUnconsumedEventsLocked, payloadHashFor, type EvidenceEventInput } from "./evidenceEvents.js";
import type { Entry } from "@nema/shared";
import type { CommitMeta } from "@nema/knowledge";
import type { Db } from "./db/db.js";
import { DaemonRpcError, type DaemonRpc } from "./daemonRpc.js";
import type { EventBus, HubEvent } from "./events.js";
import { indexEntry, timeline, withDiagramStatus } from "./entryIndex.js";
import { ArchivedWorkspaceError, ARCHIVED_MESSAGE, editUserMessage, getMessage, listMessageVersions, listMessages, MessageOpError, postSystemTask, postUserMessage, searchMessages } from "./messages.js";
import { vendoredArchify, type Archify } from "./diagrams.js";
import { posix, win32 } from "node:path";
import { PluginError, attachExtension, daemonHttpStatus, discoverExtensions, listExtensions, repairExtension, pluginsForUi, cancelExtensionInstall, extensionInstallStatus, installExtension, removeExtension, resolveExtensionSource, retryExtensionInstall, setExtensionUse, setPluginState, workspacePluginState } from "./plugins.js";
import { WorkPackageError, approveWorkPackage, confirmWorkPackageTask, dropWorkPackage, regenerateWorkPackage, requestWorkPackage, retryBlockedPackages, userSaveWorkPackageDoc } from "./workpackages.js";
import { RepoError, bindRepo, getRepo, listIndexing, listRepos, previewRepo, syncBoundRepos, unbindRepo, updateRepo } from "./repos.js";
import { getRunningTask, listQueuedTasks, toUiTask } from "./tasks.js";
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, repoPath, updateWorkspace } from "./workspaces.js";
import { attentionCounts, ensureThread, getThread, listThreads, markThreadRead, nextAttentionResult } from "./threads.js";
import { listThreadMessages } from "./messages.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

export type UiDeps = {
  db: Db;
  dataDir: string;
  nemaHome?: string;
  events: EventBus;
  daemonStatus: () => boolean;
  daemon: DaemonRpc;
  /** Diagram rendering; defaults to the vendored archify. Tests inject a fake. */
  archify?: Archify;
  ownedHelpers?: OwnedHelperScope;
};

/** Rendered diagram HTML runs archify's inline script only; it may not load or send anything. */
export const DIAGRAM_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'none'";
const DIAGRAM_HTML = /^(G-[1-9]\d*)\.html$/;
const DIAGRAM_CACHE_MAX = 32;

const PING_MS = 25_000;

const CreateWorkspaceBody = z.object({ name: z.string().trim().min(1, "must not be empty") });
// Strict on purpose: a body carrying anything but `useState` is a client mistake, and silently
// dropping an `install` field would look like the route accepted an install request.
const SetExtensionUseBody = z.strictObject({ useState: z.enum(["enabled", "disabled"]) });
const ResolveExtensionSourceBody = z.strictObject({ source: z.string() });
const InstallExtensionBody = z.strictObject({
  source: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/, "must be a 40-character commit"),
  // Same rule as the daemon, so a traversal or a Windows device name is a 400 here, not a 502 later.
  path: z.string().refine((value) => value === "." || safeRepoPath(value), "must be `.` or a safe folder inside the repository"),
});
// The folder is on the daemon's computer, which may be Windows while the hub runs elsewhere, so
// either kind of absolute path is accepted here and the daemon makes the real check. The path is
// not trimmed: a folder name may begin or end with a space, and trimming would name another folder.
const AttachExtensionBody = z.strictObject({
  path: z.string().refine((value) => posix.isAbsolute(value) || win32.isAbsolute(value), "must be an absolute folder path"),
});
const PatchWorkspaceBody = z.object({
  name: z.string().trim().min(1, "must not be empty").optional(),
  confidential: z.boolean().optional(),
  knowledgeLanguage: z.enum(KNOWLEDGE_LANGUAGES).optional(),
  archived: z.boolean().optional(),
});
const PostMessageBody = z.object({
  content: z.string().refine((s) => s.trim() !== "", "must not be empty"),
  quoteMessageId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
});
const PreviewRepoBody = z.object({ path: z.string().min(1) });
const BindRepoBody = z.object({
  path: z.string().min(1),
  label: z.string().trim().min(1),
  mainBranch: z.string().trim().min(1).optional(),
});
const PatchRepoBody = z.object({
  label: z.string().trim().min(1).optional(),
  mainBranch: z.string().trim().min(1).optional(),
});
const PatchPluginBody = z.object({
  enabled: z.boolean().optional(),
  disabledFunctions: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

class HttpError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

function workspaceError(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === "invalid workspace id") throw new HttpError(400, msg);
  if (msg === "workspace is busy") throw new HttpError(409, msg);
  if (msg.startsWith("workspace not found:")) throw new HttpError(404, msg);
  throw e;
}

function zodMessage(e: ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; ");
}

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
  const p = schema.safeParse(raw);
  if (!p.success) throw new HttpError(400, `invalid request: ${zodMessage(p.error)}`);
  return p.data;
}

function directoryChoice(result: unknown): string | null {
  if (!result || typeof result !== "object" || !("path" in result)) throw new Error("invalid pick");
  const picked = (result as { path: unknown }).path;
  if (picked === null) return null;
  if (typeof picked !== "string" || !picked.trim() || picked.length > 4096 || picked.includes("\0") || /[\r\n]/.test(picked)) throw new Error("invalid pick");
  return picked;
}

export function uiRoutes(deps: UiDeps): Hono {
  const { db, dataDir, events } = deps;
  const app = new Hono();

  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    if (e instanceof ArchivedWorkspaceError) return c.json({ error: e.message }, 409);
    if (e instanceof WorkPackageError) return c.json({ error: e.message }, e.status);
    if (e instanceof RepoError) return c.json({ error: e.message }, e.status);
    if (e instanceof PluginError) return c.json({ error: e.message }, e.status);
    if (e instanceof ZodError) return c.json({ error: `invalid request: ${zodMessage(e)}` }, 400);
    console.error("ui api error", e);
    return c.json({ error: "internal error" }, 500);
  });

  const store = (ws: string) => new KnowledgeStore(repoPath(dataDir, ws), deps.ownedHelpers);

  app.get("/daemon/status", (c) => c.json({ connected: deps.daemonStatus() }));

  // The dialog runs in the host daemon: a hub inside Docker cannot see repository directories.
  app.post("/pick-directory", async (c) => {
    try {
      const result = await deps.daemon.call("dialog.pickDirectory", {}, 10 * 60 * 1000);
      return c.json({ path: directoryChoice(result) });
    } catch (error) {
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, daemonHttpStatus(error.message));
      throw error;
    }
  });

  app.get("/plugins", async (c) => {
    try {
      return c.json(pluginsForUi(await deps.daemon.call("plugins.status", {})));
    } catch (error) {
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, daemonHttpStatus(error.message));
      throw error;
    }
  });

  app.get("/extensions", async (c) => {
    try {
      return c.json(await listExtensions(deps.daemon, deps.nemaHome));
    } catch (error) {
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, daemonHttpStatus(error.message));
      throw error;
    }
  });

  // Only the use state is writable from this route. Installing keeps its own staging rules and is
  // not reachable here; removing has its own verb, so a PATCH carrying one is a client mistake.
  app.patch("/extensions/:id", async (c) => {
    const { useState } = await body(c, SetExtensionUseBody);
    try {
      return c.json(await setExtensionUse(deps.daemon, c.req.param("id"), useState));
    } catch (error) {
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, daemonHttpStatus(error.message));
      throw error;
    }
  });

  // Removal deletes a managed extension's directory or detaches an external one; the daemon decides
  // which, and refuses a bundled extension outright.
  app.delete("/extensions/:id", async (c) => {
    try {
      return c.json(await removeExtension(deps.daemon, c.req.param("id")));
    } catch (error) {
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, daemonHttpStatus(error.message));
      throw error;
    }
  });

  // Preview only: which commit a GitHub or skills.sh source points at and which skills it holds.
  // Nothing is installed, so a source the parser refuses never reaches the daemon or the network.
  app.post("/extensions/resolve", async (c) => {
    const { source } = await body(c, ResolveExtensionSourceBody);
    const trimmed = source.trim();
    try {
      parseSkillSource(trimmed);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "unsupported extension source");
    }
    try {
      return c.json(await resolveExtensionSource(deps.daemon, trimmed));
    } catch (error) {
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, daemonHttpStatus(error.message));
      throw error;
    }
  });

  // Install the skill a preview showed: the request names the commit and folder, so the daemon never
  // picks a newer commit than the one the person saw.
  app.post("/extensions/install", async (c) => {
    const { source, commit, path } = await body(c, InstallExtensionBody);
    const trimmed = source.trim();
    try {
      parseSkillSource(trimmed);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "unsupported extension source");
    }
    try {
      return c.json(await installExtension(deps.daemon, { source: trimmed, commit, path }));
    } catch (error) {
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, daemonHttpStatus(error.message));
      throw error;
    }
  });

  const installRoute = (call: (daemon: DaemonRpc, id: string) => Promise<Record<string, unknown>>) => async (c: Context) => {
    try {
      return c.json(await call(deps.daemon, c.req.param("id")!));
    } catch (error) {
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, daemonHttpStatus(error.message));
      throw error;
    }
  };
  app.get("/extensions/:id/install", installRoute(extensionInstallStatus));
  app.post("/extensions/:id/install/cancel", installRoute(cancelExtensionInstall));
  app.post("/extensions/:id/install/retry", installRoute(retryExtensionInstall));

  app.get("/extensions/discover", async (c) => {
    try {
      return c.json(await discoverExtensions(deps.daemon));
    } catch (error) {
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, daemonHttpStatus(error.message));
      throw error;
    }
  });

  // Attach by reference: the daemon records the folder's real path and copies nothing.
  app.post("/extensions/attach", async (c) => {
    const { path: folder } = await body(c, AttachExtensionBody);
    try {
      return c.json(await attachExtension(deps.daemon, folder));
    } catch (error) {
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, daemonHttpStatus(error.message));
      throw error;
    }
  });

  app.post("/extensions/:id/repair", installRoute(repairExtension));

  app.get("/workspaces", async (c) => {
    const [list, counts] = await Promise.all([listWorkspaces(db), attentionCounts(db, dataDir)]);
    return c.json(list.map((w) => ({ ...w, attention: counts[w.id] ?? 0, archived: w.archivedAt != null })));
  });

  app.post("/workspaces", async (c) => {
    const { name } = await body(c, CreateWorkspaceBody);
    const created = await createWorkspace(db, dataDir, name, deps.ownedHelpers);
    return c.json({ ...created, archived: created.archivedAt != null });
  });

  app.use("/workspaces/:id/*", async (c, next) => {
    // Hono's `:id/*` also matches `/workspaces/:id` itself. Leave that path to its own handler
    // so DELETE can reject a bad id with 400 before the not-found check.
    const sub = new URL(c.req.url).pathname.replace(/^\/api\/workspaces\/[^/]+/, "");
    if (sub !== "") {
      const id = c.req.param("id")!;
      if (!(await getWorkspace(db, id))) throw new HttpError(404, `workspace not found: ${id}`);
    }
    await next();
  });

  app.patch("/workspaces/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await getWorkspace(db, id))) throw new HttpError(404, `workspace not found: ${id}`);
    const patch = await body(c, PatchWorkspaceBody);
    const clean: Parameters<typeof updateWorkspace>[2] = {};
    if (patch.name !== undefined) clean.name = patch.name;
    if (patch.confidential !== undefined) clean.confidential = patch.confidential;
    if (patch.knowledgeLanguage !== undefined) clean.knowledgeLanguage = patch.knowledgeLanguage;
    if (patch.archived !== undefined) clean.archived = patch.archived;
    try {
      const updated = await updateWorkspace(db, id, clean);
      if (clean.archived === false) {
        // Queued tasks were parked while archived; announce them so the dispatcher picks them up.
        for (const t of await listQueuedTasks(db, id)) events.emit(id, { type: "task.updated", task: toUiTask(t) });
      }
      // Archiving stops watching this workspace's repos; unarchiving resumes it.
      if (clean.archived !== undefined) await syncBoundRepos(db, deps.daemon);
      return c.json({ ...updated, archived: updated.archivedAt != null });
    } catch (e) {
      workspaceError(e);
    }
  });

  app.delete("/workspaces/:id", async (c) => {
    const id = c.req.param("id")!;
    try {
      await deleteWorkspace(db, dataDir, id, deps.nemaHome);
    } catch (e) {
      workspaceError(e);
    }
    // Tells a connected daemon to remove its isolation dir for this workspace.
    events.emit(id, { type: "workspace.deleted", workspaceId: id });
    return c.body(null, 204);
  });

  app.get("/workspaces/:id/repos", async (c) => c.json(await listRepos(db, c.req.param("id")!)));

  app.post("/workspaces/:id/repos/preview", async (c) => {
    const input = await body(c, PreviewRepoBody);
    return c.json(await previewRepo(db, deps.daemon, c.req.param("id")!, input.path));
  });

  app.post("/workspaces/:id/repos", async (c) => {
    const id = c.req.param("id")!;
    const input = await body(c, BindRepoBody);
    return c.json(await bindRepo(db, deps.daemon, id, input, events));
  });

  app.patch("/workspaces/:id/repos/:repoId", async (c) => {
    const id = c.req.param("id")!;
    const repoId = c.req.param("repoId")!;
    const current = await getRepo(db, repoId);
    if (!current || current.workspaceId !== id) throw new RepoError(404, `找不到仓库：${repoId}`);
    return c.json(await updateRepo(db, repoId, await body(c, PatchRepoBody), deps.daemon));
  });

  app.get("/workspaces/:id/plugins", async (c) => c.json(await workspacePluginState(db, c.req.param("id")!)));

  app.patch("/workspaces/:id/plugins/:pluginId", async (c) => {
    const patch = await body(c, PatchPluginBody);
    return c.json(await setPluginState(db, c.req.param("id")!, c.req.param("pluginId")!, patch));
  });

  app.delete("/workspaces/:id/repos/:repoId", async (c) => {
    const id = c.req.param("id")!;
    const repoId = c.req.param("repoId")!;
    const current = await getRepo(db, repoId);
    if (!current || current.workspaceId !== id) throw new RepoError(404, `找不到仓库：${repoId}`);
    await unbindRepo(db, deps.daemon, repoId);
    return c.body(null, 204);
  });

  app.get("/workspaces/:id/messages", async (c) => c.json(await listMessages(db, c.req.param("id")!)));

  app.get("/workspaces/:id/messages/search", async (c) => c.json(await searchMessages(db, c.req.param("id")!, c.req.query("q") ?? "")));

  app.get("/workspaces/:id/messages/:messageId", async (c) => {
    const message = await getMessage(db, c.req.param("messageId")!);
    if (!message || message.workspaceId !== c.req.param("id")) throw new HttpError(404, "message not found");
    return c.json(message);
  });

  app.get("/workspaces/:id/threads", async (c) => c.json(await listThreads(db, c.req.param("id")!)));

  app.get("/workspaces/:id/threads/:tid/messages", async (c) => {
    const workspaceId = c.req.param("id")!;
    const thread = await getThread(db, c.req.param("tid")!);
    if (!thread || thread.workspaceId !== workspaceId) throw new HttpError(404, "thread not found");
    const anchor = await getMessage(db, thread.id);
    if (!anchor) throw new HttpError(404, "thread not found");
    return c.json({ thread, anchor, messages: await listThreadMessages(db, thread.id) });
  });

  app.post("/workspaces/:id/threads", async (c) => {
    const workspaceId = c.req.param("id")!;
    const { content, quoteMessageId } = await body(c, PostMessageBody);
    if ((await getWorkspace(db, workspaceId))?.archivedAt) throw new HttpError(409, ARCHIVED_MESSAGE);
    try {
      const created = await db.tx(async (t) => {
        const posted = await postUserMessage(t, workspaceId, content, { quoteMessageId });
        const title = Array.from(content.split(/\r?\n/, 1)[0]!.trim()).slice(0, 80).join("") || "新追问";
        const thread = await ensureThread(t, posted.message.id, title, "user");
        return { ...posted, thread };
      });
      const task = toUiTask(created.task);
      events.emit(workspaceId, { type: "message.created", message: created.message });
      events.emit(workspaceId, { type: "task.updated", task });
      events.emit(workspaceId, { type: "thread.updated", thread: created.thread });
      return c.json({ message: created.message, thread: created.thread, task });
    } catch (e) {
      if (e instanceof MessageOpError) throw new HttpError(e.status, e.message);
      if (e instanceof ArchivedWorkspaceError) throw new HttpError(409, e.message);
      throw e;
    }
  });

  app.post("/workspaces/:id/threads/:tid/messages", async (c) => {
    const workspaceId = c.req.param("id")!;
    const threadId = c.req.param("tid")!;
    const { content, quoteMessageId } = await body(c, PostMessageBody);
    if ((await getWorkspace(db, workspaceId))?.archivedAt) throw new HttpError(409, ARCHIVED_MESSAGE);
    try {
      const { message, task: created } = await postUserMessage(db, workspaceId, content, { quoteMessageId, threadId });
      const task = toUiTask(created);
      events.emit(workspaceId, { type: "message.created", message });
      events.emit(workspaceId, { type: "task.updated", task });
      const thread = await getThread(db, threadId);
      if (thread) events.emit(workspaceId, { type: "thread.updated", thread });
      return c.json({ message, task });
    } catch (e) {
      if (e instanceof MessageOpError) throw new HttpError(e.status, e.message);
      if (e instanceof ArchivedWorkspaceError) throw new HttpError(409, e.message);
      throw e;
    }
  });

  app.post("/workspaces/:id/threads/:tid/read", async (c) => {
    const workspaceId = c.req.param("id")!;
    const threadId = c.req.param("tid")!;
    const { throughSeq } = await body(c, z.object({ throughSeq: z.number().int().positive() }).strict());
    const thread = await getThread(db, threadId);
    if (!thread || thread.workspaceId !== workspaceId) throw new HttpError(400, "thread not in this workspace");
    try {
      await markThreadRead(db, threadId, throughSeq);
    } catch (e) {
      if (e instanceof MessageOpError) throw new HttpError(e.status, e.message);
      throw e;
    }
    const updated = await getThread(db, threadId);
    if (updated) events.emit(workspaceId, { type: "thread.updated", thread: updated });
    return c.body(null, 204);
  });

  app.get("/workspaces/:id/attention/next", async (c) => {
    const workspaceId = c.req.param("id")!;
    const result = await nextAttentionResult(db, dataDir, workspaceId);
    if (result.card && result.threadId) {
      if (result.anchor) events.emit(workspaceId, { type: "message.created", message: result.anchor });
      events.emit(workspaceId, { type: "message.created", message: result.card });
      const thread = await getThread(db, result.threadId);
      if (thread) events.emit(workspaceId, { type: "thread.updated", thread });
    }
    return c.json(result.threadId ? { threadId: result.threadId } : null);
  });

  app.get("/workspaces/:id/messages/:messageId/versions", async (c) => {
    const message = await getMessage(db, c.req.param("messageId")!);
    if (!message || message.workspaceId !== c.req.param("id")) throw new HttpError(404, "message not found");
    return c.json(await listMessageVersions(db, message.id));
  });

  app.patch("/workspaces/:id/messages/:messageId", async (c) => {
    const id = c.req.param("id")!;
    const { content } = await body(c, PostMessageBody);
    try {
      const { message, task: created } = await editUserMessage(db, id, c.req.param("messageId")!, content);
      const task = toUiTask(created);
      events.emit(id, { type: "message.updated", message });
      events.emit(id, { type: "task.updated", task });
      return c.json({ message, task });
    } catch (e) {
      if (e instanceof MessageOpError) throw new HttpError(e.status, e.message);
      if (e instanceof ArchivedWorkspaceError) throw new HttpError(409, e.message);
      throw e;
    }
  });

  app.get("/workspaces/:id/tasks/active", async (c) => {
    const id = c.req.param("id")!;
    const running = await getRunningTask(db, id);
    return c.json({ running: running ? toUiTask(running) : null, indexing: listIndexing(id) });
  });

  app.post("/workspaces/:id/messages", async (c) => {
    const id = c.req.param("id");
    const { content, quoteMessageId, threadId } = await body(c, PostMessageBody);
    if ((await getWorkspace(db, id))?.archivedAt) throw new HttpError(409, ARCHIVED_MESSAGE);
    let message, created;
    try {
      ({ message, task: created } = await postUserMessage(db, id, content, { quoteMessageId, threadId }));
    } catch (e) {
      if (e instanceof MessageOpError) throw new HttpError(e.status, e.message);
      throw e;
    }
    const task = toUiTask(created);
    events.emit(id, { type: "message.created", message });
    events.emit(id, { type: "task.updated", task });
    return c.json({ message, task });
  });

  app.post("/workspaces/:id/workpackages", async (c) => {
    const id = c.req.param("id")!;
    const input = await body(
      c,
      z.object({ requirements: z.array(z.string().regex(/^R-[1-9]\d*$/)).min(1), title: z.string().min(1).max(200).optional() }).strict(),
    );
    const ws = await getWorkspace(db, id);
    if (!ws) throw new HttpError(404, `workspace not found: ${id}`);
    if (ws.archivedAt) throw new HttpError(409, ARCHIVED_MESSAGE);
    const { entry } = await requestWorkPackage(db, dataDir, events, id, input, undefined, deps.ownedHelpers);
    return c.json(entry);
  });

  const wpDeps = { db, dataDir, events, daemon: deps.daemon, ownedHelpers: deps.ownedHelpers };
  const wpWorkspace = async (c: Context) => {
    const id = c.req.param("id")!;
    const ws = await getWorkspace(db, id);
    if (!ws) throw new HttpError(404, `workspace not found: ${id}`);
    if (ws.archivedAt) throw new HttpError(409, ARCHIVED_MESSAGE);
    return { id, wid: c.req.param("wid")! };
  };

  app.get("/workspaces/:id/workpackages/:wid", async (c) => {
    const wp = await store(c.req.param("id")!).readWorkPackage(c.req.param("wid")!);
    if (!wp) throw new HttpError(404, `找不到开发包 ${c.req.param("wid")}`);
    return c.json(wp);
  });
  app.post("/workspaces/:id/workpackages/:wid/approve", async (c) => {
    const { id, wid } = await wpWorkspace(c);
    return c.json(await approveWorkPackage(wpDeps, id, wid));
  });
  app.put("/workspaces/:id/workpackages/:wid/:which{spec|plan}", async (c) => {
    const { id, wid } = await wpWorkspace(c);
    const { markdown } = await body(c, z.object({ markdown: z.string() }).strict());
    return c.json(await userSaveWorkPackageDoc(wpDeps, id, wid, c.req.param("which") as "spec" | "plan", markdown));
  });
  app.post("/workspaces/:id/workpackages/:wid/regenerate", async (c) => {
    const { id, wid } = await wpWorkspace(c);
    await regenerateWorkPackage(wpDeps, id, wid);
    return c.json({ ok: true });
  });
  app.post("/workspaces/:id/workpackages/:wid/tasks/:n/confirm", async (c) => {
    const { id, wid } = await wpWorkspace(c);
    const n = Number(c.req.param("n"));
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "任务编号无效");
    return c.json(await confirmWorkPackageTask(wpDeps, id, wid, n));
  });
  app.post("/workspaces/:id/workpackages/:wid/drop", async (c) => {
    const { id, wid } = await wpWorkspace(c);
    return c.json(await dropWorkPackage(wpDeps, id, wid));
  });

  /** ids of entries added by the workspace's most recent done task. */
  async function newEntryIds(ws: string): Promise<Set<string>> {
    const rows = await db.query<{ entry_id: string }>(
      `select entry_id from task_changes
       where op = 'add' and task_id = (select id from tasks where workspace_id = $1 and status = 'done' order by seq desc limit 1)`,
      [ws],
    );
    return new Set(rows.map((r) => r.entry_id));
  }

  app.get("/workspaces/:id/entries", async (c) => {
    const ws = c.req.param("id");
    const [list, fresh] = await Promise.all([sourceEvidenceEntries(db, ws, await store(ws).listEntries()), newEntryIds(ws)]);
    return c.json((await withDiagramStatus(db, ws, list.map(sourceEvidenceSummary))).map((e) => ({ ...e, isNew: fresh.has(e.id) })));
  });

  app.get("/workspaces/:id/timeline", async (c) => c.json(await timeline(db, dataDir, c.req.param("id")!, deps.ownedHelpers)));

  const requireEntry = async (ws: string, eid: string) => {
    const entry = await store(ws).get(eid);
    if (!entry) throw new HttpError(404, `entry not found: ${eid}`);
    return entry;
  };

  app.get("/workspaces/:id/entries/:eid", async (c) => {
    const ws = c.req.param("id")!, eid = c.req.param("eid")!;
    const entry = (await sourceEvidenceEntries(db, ws, await store(ws).listEntries())).find(e => e.id === eid);
    if (!entry) throw new HttpError(404, `entry not found: ${eid}`);
    return c.json(entry);
  });

  app.post("/workspaces/:id/entries/:eid/withdraw", async (c) => {
    const workspaceId = c.req.param("id")!;
    const entryId = c.req.param("eid")!;
    await requireEntry(workspaceId, entryId);
    const { entry } = await store(workspaceId).withdraw(entryId, { author: "user" });
    await indexEntry(db, workspaceId, entry);
    events.emit(workspaceId, { type: "knowledge.changed", entryId: entry.id });
    return c.json(entry);
  });

  // Runs inside the store's existing repository lock; never calls a locking store method.
  const confirmation = (ws: string, mode: "put" | "confirm") => {
    const meta: CommitMeta = { author: "user", evidenceEventIds: [], uiAction: mode === "confirm" ? "confirm" : "edit" };
    const pending: { id: string; payloadHash: string }[] = [];
    return {
      meta,
      prepare: async (entry: Entry, existing: Entry | null): Promise<string | void> => {
        await reconcileUnconsumedEventsLocked(db, dataDir, ws, entry.id);
        const common = { workspaceId: ws, entryId: entry.id, contentHash: entryContentHash(entry), refsHash: refsHash(entry),
          revision: entry.sourceSnapshot?.revision ?? null, snapshotHash: await relatedSnapshotHash(entry, (id) => store(ws).get(id)) };
        const promote: EvidenceEventInput = { ...common, kind: "promote_basis", targetBasis: entry.basis as "stated" | "decided" };
        const revision: EvidenceEventInput | null = entry.sourceSnapshot ? { ...common, kind: "confirm_revision", snapshotHash: entry.sourceSnapshot.contentHash } : null;
        const kinds: EvidenceEventInput[] = mode === "put" || existing?.basis === null || existing?.basis === "inferred" ? [promote] : [];
        if (mode === "confirm" && revision) kinds.push(revision);
        if (!kinds.length) kinds.push({ ...common, kind: "confirm_entry" });
        const consumed = async (input: EvidenceEventInput): Promise<string | undefined> => {
          const rows = await db.query<{ consumed_commit: string }>(
            "select consumed_commit from evidence_events where workspace_id = $1 and payload_hash = $2 and consumed_commit is not null order by consumed_at desc limit 1",
            [ws, payloadHashFor(input)]);
          return rows[0]?.consumed_commit;
        };
        const commits = await Promise.all(kinds.map(consumed));
        // Only a promotion made by a prior confirm substitutes for confirm_entry on replay.
        // A snapshot always needs its own matching confirm_revision event.
        if (kinds.length === 1 && kinds[0]!.kind === "confirm_entry" && !commits[0]) {
          const promoted = await consumed(promote);
          if (promoted) {
            try {
              const message = await git(repoPath(dataDir, ws), ["show", "-s", "--format=%B", promoted]);
              if (parseCommitMessage(message).uiAction === "confirm") commits[0] = promoted;
            } catch {
              // A DB-only restore may name a commit absent from this repository; it cannot prove replay.
            }
          }
        }
        // The evidence hash excludes metadata such as URL and related; replay must preserve those edits too.
        const persisted = (value: Entry) => canonicalJson(JSON.parse(JSON.stringify({ ...value, confirmedAt: null })));
        if (commits.every(Boolean) && existing && persisted(existing) === persisted(entry)) {
          Object.assign(entry, existing);
          return commits[0]!;
        }
        await db.tx(async (tx) => {
          for (const input of kinds) {
            const event = await insertEvidenceEvent(tx, input);
            pending.push(event);
            meta.evidenceEventIds!.push(event.id);
          }
        });
      },
      consume: async (commit: string) => {
        for (const event of pending) {
          if (!await consumeEvidenceEvent(db, ws, event.id, event.payloadHash, commit)) throw new Error("确认事件消费失败");
        }
      },
    };
  };

  app.put("/workspaces/:id/entries/:eid", async (c) => {
    const ws = c.req.param("id");
    const eid = c.req.param("eid");
    const raw = await body(c, z.record(z.string(), z.unknown()));
    const parsed = UpsertEntryInput.safeParse({ ...raw, id: eid });
    if (!parsed.success) throw new HttpError(400, `invalid entry: ${zodMessage(parsed.error)}`);
    await requireEntry(ws, eid);
    // The client does not choose basis or confirmed. A user edit is a confirmation.
    // Implementation is kept as stored: the user changes it only through the implementation confirm.
    const { implementation: _implementation, ...edit } = parsed.data;
    const audit = confirmation(ws, "put");
    const { entry, commit } = await store(ws).upsert(
      { ...edit, basis: parsed.data.kind === "decision" ? "decided" : "stated", confirmed: true },
      audit.meta, undefined, audit.prepare, audit.consume,
    );
    // The commit is durable; bookkeeping failures must not fail the request.
    try {
      await indexEntry(db, ws, entry, deps.ownedHelpers);
      events.emit(ws, { type: "knowledge.changed", entryId: entry.id });
    } catch (e) {
      console.error(`ui upsert: post-commit bookkeeping failed for ${entry.id} (commit ${commit})`, e);
    }
    await retryBlockedPackages(db, dataDir, events, ws, entry, "user", deps.ownedHelpers);
    return c.json(entry);
  });

  app.post("/workspaces/:id/entries/:eid/confirm", async (c) => {
    const ws = c.req.param("id")!;
    const eid = c.req.param("eid")!;
    await body(c, z.object({}));
    await requireEntry(ws, eid);
    const audit = confirmation(ws, "confirm");
    const { entry, commit } = await store(ws).confirm(eid, audit.meta, audit.prepare, audit.consume);
    try {
      await indexEntry(db, ws, entry, deps.ownedHelpers);
      events.emit(ws, { type: "knowledge.changed", entryId: entry.id });
    } catch (e) {
      console.error(`ui confirm: post-commit bookkeeping failed for ${entry.id} (commit ${commit})`, e);
    }
    return c.json(entry);
  });

  app.post("/workspaces/:id/entries/:eid/implementation/confirm", async (c) => {
    const ws = c.req.param("id")!;
    const eid = c.req.param("eid")!;
    await body(c, z.object({}));
    const current = await requireEntry(ws, eid);
    const status = current.implementation?.status;
    if (status !== "reported" && status !== "mismatch") throw new HttpError(409, "只能确认已上报或有出入的实现");
    const { entry, commit } = await store(ws).confirmImplementation(eid, { author: "user" });
    try {
      await indexEntry(db, ws, entry, deps.ownedHelpers);
      events.emit(ws, { type: "knowledge.changed", entryId: entry.id });
    } catch (e) {
      console.error(`ui implementation confirm: post-commit bookkeeping failed for ${entry.id} (commit ${commit})`, e);
    }
    return c.json(entry);
  });

  app.get("/workspaces/:id/entries/:eid/history", async (c) => {
    const ws = c.req.param("id")!;
    const eid = c.req.param("eid")!;
    await requireEntry(ws, eid);
    return c.json(await history(repoPath(dataDir, ws), eid, deps.ownedHelpers));
  });

  app.get("/workspaces/:id/entries/:eid/versions/:commit", async (c) => {
    const ws = c.req.param("id")!;
    const eid = c.req.param("eid")!;
    const commit = c.req.param("commit")!;
    if (!kindFromId(eid) || !/^[0-9a-f]{4,64}$/i.test(commit)) throw new HttpError(404, "version not found");
    try {
      return c.json(await versionAt(repoPath(dataDir, ws), eid, commit, deps.ownedHelpers));
    } catch {
      throw new HttpError(404, `version not found: ${eid}@${commit}`);
    }
  });

  app.get("/workspaces/:id/entries/:eid/why", async (c) => {
    const ws = c.req.param("id")!;
    const eid = c.req.param("eid")!;
    await requireEntry(ws, eid);
    return c.json(await blameParagraphs(repoPath(dataDir, ws), eid, deps.ownedHelpers));
  });

  const requireDiagram = async (ws: string, gid: string) => {
    const entry = kindFromId(gid) === "diagram" ? await store(ws).get(gid) : null;
    if (!entry?.diagram) throw new HttpError(404, `diagram not found: ${gid}`);
    return { ...entry, diagram: entry.diagram };
  };

  app.post("/workspaces/:id/diagrams/:gid/update", async (c) => {
    const ws = c.req.param("id")!;
    const gid = c.req.param("gid")!;
    await body(c, z.object({}));
    const { diagram } = await requireDiagram(ws, gid);
    const since = diagram.sourceCommits[diagram.repoId] ?? Object.values(diagram.sourceCommits)[0] ?? "（未记录）";
    const { message, task: created } = await postSystemTask(
      db,
      ws,
      `用户要求更新代码图 ${gid}：用 diagram__read 读旧图，用 code__changes 看自 ${since} 以来的改动，只改受影响的节点和连线，再用 diagram__save（带 id）保存。`,
    );
    const task = toUiTask(created);
    events.emit(ws, { type: "message.created", message });
    events.emit(ws, { type: "task.updated", task });
    return c.json({ message, task });
  });

  // Rendered HTML keyed by workspace, diagram, type and the commit of its json. Never written to git.
  const diagramHtml = new Map<string, string>();
  const archify = deps.archify ?? vendoredArchify;

  app.get("/workspaces/:id/diagrams/:file", async (c) => {
    c.header("Content-Security-Policy", DIAGRAM_CSP);
    c.header("X-Content-Type-Options", "nosniff");
    const ws = c.req.param("id")!;
    const gid = DIAGRAM_HTML.exec(c.req.param("file")!)?.[1];
    const entry = gid ? await store(ws).get(gid) : null;
    if (!gid || !entry?.diagram) return c.json({ error: `diagram not found: ${c.req.param("file")}` }, 404);
    const dir = repoPath(dataDir, ws);
    const rel = `diagrams/${gid}.json`;
    const commit = (await git(dir, ["log", "-1", "--format=%H", "--", rel], deps.ownedHelpers)).trim();
    if (commit === "") return c.json({ error: `diagram not found: ${gid}` }, 404);
    const key = `${ws}:${gid}:${entry.diagram.type}:${commit}`;
    let html = diagramHtml.get(key);
    if (html === undefined) {
      // Read the json at that commit, so the cache key always matches what was rendered.
      const spec: unknown = JSON.parse(await git(dir, ["show", `${commit}:${rel}`], deps.ownedHelpers));
      html = await archify.renderDiagram(entry.diagram.type, spec);
      diagramHtml.set(key, html);
      if (diagramHtml.size > DIAGRAM_CACHE_MAX) diagramHtml.delete(diagramHtml.keys().next().value!);
    }
    return c.html(html);
  });

  app.get("/workspaces/:id/events", (c) => {
    const ws = c.req.param("id")!;
    return streamSSE(c, async (stream) => {
      const queue: HubEvent[] = [];
      let wake: (() => void) | null = null;
      const push = (e: HubEvent) => {
        queue.push(e);
        wake?.();
      };
      const unsubWs = events.subscribe(ws, push);
      const unsubAll = events.subscribeAll((w, e) => {
        if (w === "") push(e); // global events only; workspace events arrive via subscribe()
      });
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubWs();
        unsubAll();
        wake?.();
      };
      stream.onAbort(close);
      try {
        while (!closed) {
          while (queue.length > 0) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
          if (closed) break;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const pinged = await new Promise<boolean>((resolve) => {
            wake = () => resolve(false);
            timer = setTimeout(() => resolve(true), PING_MS);
          });
          clearTimeout(timer);
          wake = null;
          if (pinged && !closed) await stream.write(": ping\n\n");
        }
      } finally {
        close();
      }
    });
  });

  return app;
}
