import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { KnowledgeStore, git, history } from "@nema/knowledge";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { DaemonRpcError, type DaemonRpc } from "../src/daemonRpc.js";
import type { DiagramType } from "../src/archify.js";
import { onRepoMoved } from "../src/diagrams.js";
import { timeline } from "../src/entryIndex.js";
import { EventBus } from "../src/events.js";
import { postUserMessage } from "../src/messages.js";
import { roomRoutes } from "../src/roomApi.js";
import { claimNextTask } from "../src/tasks.js";
import { createWorkspace, repoPath } from "../src/workspaces.js";

let db: Db;
let dataDir: string;
let events: EventBus;
let wsA: string;
let wsB: string;
let room: Hono<any>;
let emitted: { ws: string; event: unknown }[];
const daemonCalls: unknown[] = [];
const daemon: DaemonRpc = {
  async call(method, params) {
    daemonCalls.push({ method, params });
    throw new DaemonRpcError("daemon 未连接");
  },
};
const validated: { type: DiagramType; spec: unknown }[] = [];
const archify = {
  async validateDiagram(type: DiagramType, spec: unknown): Promise<{ ok: true } | { ok: false; diagnostics: string }> {
    validated.push({ type, spec });
    if (spec && typeof spec === "object" && "bad" in spec) return { ok: false, diagnostics: "- [error E_NODE] node hub has no label" };
    return { ok: true };
  },
  async renderDiagram(): Promise<string> {
    return "<html></html>";
  },
};

beforeEach(async () => {
  daemonCalls.length = 0;
  validated.length = 0;
  const deps = await makeHubDeps();
  db = deps.db;
  dataDir = deps.dataDir;
  events = new EventBus();
  emitted = [];
  events.subscribeAll((ws, event) => {
    if (event.type === "knowledge.changed") emitted.push({ ws, event });
  });
  wsA = (await createWorkspace(db, dataDir, "A")).id;
  wsB = (await createWorkspace(db, dataDir, "B")).id;
  room = new Hono().route("/room", roomRoutes({ db, dataDir, events, daemon, archify }));
});
afterAll(cleanupHubDeps);

async function insertRepo(workspaceId: string, label: string, sha: string | null = "sha_main_1") {
  const id = `repo_${workspaceId}_${label}`;
  const path = `/repos/${workspaceId}/${label}`;
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, last_main_sha, created_at)
     values ($1, $2, $3, $4, $5, 'main', false, $6, $7)`,
    [id, workspaceId, path, `${path}/.git`, label, sha, new Date().toISOString()],
  );
  return { id, label };
}

async function runningTask(workspaceId = wsA) {
  await postUserMessage(db, workspaceId, "画一张架构图");
  const task = await claimNextTask(db, "d1");
  expect(task?.workspaceId).toBe(workspaceId);
  return { runToken: task!.runToken!, taskId: task!.id, messageId: task!.messageId };
}

const roomReq = (method: string, path: string, token: string, body?: unknown) =>
  room.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const SPEC = { title: "Nema", nodes: [{ id: "hub", label: "Hub" }] };
const saveArgs = (repo: string, extra: Record<string, unknown> = {}) => ({
  repo,
  type: "architecture",
  title: "系统架构",
  summary: "hub 与 web 的关系",
  spec: SPEC,
  nodePaths: { hub: ["apps/hub/src"] },
  ...extra,
});

const callRows = () => db.query<{ name: string; ok: boolean }>(`select name, ok from plugin_calls order by id`);

describe("diagram plugin", () => {
  test("diagram__save with invalid spec returns ok:false diagnostics and writes nothing", async () => {
    const repo = await insertRepo(wsA, "api");
    const task = await runningTask();
    const store = new KnowledgeStore(repoPath(dataDir, wsA));
    const head = (await git(repoPath(dataDir, wsA), ["rev-parse", "HEAD"])).trim();
    const res = await roomReq("POST", "/room/plugins/diagram__save", task.runToken, saveArgs(repo.label, { spec: { bad: true } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { ok: false, diagnostics: "- [error E_NODE] node hub has no label" } });
    expect(validated).toEqual([{ type: "architecture", spec: { bad: true } }]);
    expect((await git(repoPath(dataDir, wsA), ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await store.list()).toEqual([]);
    expect(await db.query("select 1 from entry_index")).toEqual([]);
    expect(emitted).toEqual([]);
    expect(await callRows()).toEqual([{ name: "diagram__save", ok: false }]);
    expect(daemonCalls).toEqual([]);
  });

  test("diagram__save with a valid spec creates G-1 with sourceCommits from lastMainSha and the task message as source", async () => {
    const repo = await insertRepo(wsA, "api", "c0ffee");
    const task = await runningTask();
    const res = await roomReq("POST", "/room/plugins/diagram__save", task.runToken, saveArgs(repo.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { ok: true, id: "G-1" } });
    const store = new KnowledgeStore(repoPath(dataDir, wsA));
    expect(await store.get("G-1")).toMatchObject({
      kind: "diagram",
      title: "系统架构",
      body: "hub 与 web 的关系",
      status: "active",
      sourceMessages: [task.messageId],
      diagram: { repoId: repo.id, type: "architecture", sourceCommits: { [repo.id]: "c0ffee" }, nodePaths: { hub: ["apps/hub/src"] } },
    });
    expect(await store.readDiagramSpec("G-1")).toEqual(SPEC);
    expect((await history(repoPath(dataDir, wsA), "G-1"))[0]).toMatchObject({
      op: "add",
      reason: "画图：系统架构",
      author: "agent",
      taskId: task.taskId,
      sourceMessages: [task.messageId],
    });
    expect(await db.query("select entry_id, kind from entry_index where workspace_id = $1", [wsA])).toEqual([{ entry_id: "G-1", kind: "diagram" }]);
    expect(emitted).toEqual([{ ws: wsA, event: { type: "knowledge.changed", entryId: "G-1" } }]);
    expect(await callRows()).toEqual([{ name: "diagram__save", ok: true }]);

    const read = await roomReq("POST", "/room/plugins/diagram__read", task.runToken, { id: "G-1" });
    expect(read.status).toBe(200);
    const body = (await read.json()) as { result: { entry: { id: string; kind: string }; spec: unknown } };
    expect(body.result.entry).toMatchObject({ id: "G-1", kind: "diagram" });
    expect(body.result.spec).toEqual(SPEC);
    expect(await callRows()).toEqual([
      { name: "diagram__save", ok: true },
      { name: "diagram__read", ok: true },
    ]);
    expect(daemonCalls).toEqual([]);
  });

  test("diagram__save with id updates G-1 in place", async () => {
    const repo = await insertRepo(wsA, "api");
    const task = await runningTask();
    expect((await roomReq("POST", "/room/plugins/diagram__save", task.runToken, saveArgs(repo.label))).status).toBe(200);
    const spec2 = { title: "Nema v2", nodes: [] };
    const res = await roomReq(
      "POST",
      "/room/plugins/diagram__save",
      task.runToken,
      saveArgs(repo.label, { id: "G-1", title: "系统架构 v2", spec: spec2, nodePaths: {} }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { ok: true, id: "G-1" } });
    const store = new KnowledgeStore(repoPath(dataDir, wsA));
    expect((await store.list()).map((e) => e.id)).toEqual(["G-1"]);
    expect(await store.get("G-1")).toMatchObject({ title: "系统架构 v2", diagram: { nodePaths: {} } });
    expect(await store.readDiagramSpec("G-1")).toEqual(spec2);
    expect((await history(repoPath(dataDir, wsA), "G-1"))[0]).toMatchObject({ op: "update", reason: "画图：系统架构 v2" });

    const missing = await roomReq("POST", "/room/plugins/diagram__save", task.runToken, saveArgs(repo.label, { id: "G-7" }));
    expect(missing.status).toBe(404);
  });

  test("diagram__save for another workspace's repo is 400", async () => {
    await insertRepo(wsA, "api");
    const other = await insertRepo(wsB, "secret");
    const task = await runningTask();
    const res = await roomReq("POST", "/room/plugins/diagram__save", task.runToken, saveArgs(other.id));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(other.id);
    expect(validated).toEqual([]);
    expect(await new KnowledgeStore(repoPath(dataDir, wsA)).list()).toEqual([]);
    expect(await new KnowledgeStore(repoPath(dataDir, wsB)).list()).toEqual([]);
    expect(await callRows()).toEqual([{ name: "diagram__save", ok: false }]);
  });

  test("diagram__read is 404 for an id that is not a diagram in this workspace", async () => {
    const repoB = await insertRepo(wsB, "api");
    const taskB = await runningTask(wsB);
    expect((await roomReq("POST", "/room/plugins/diagram__save", taskB.runToken, saveArgs(repoB.label))).status).toBe(200);
    await insertRepo(wsA, "api");
    const task = await runningTask();
    for (const id of ["G-1", "R-1", "nope"]) {
      const res = await roomReq("POST", "/room/plugins/diagram__read", task.runToken, { id });
      expect(res.status).toBe(404);
    }
  });

  test("diagram functions are offered when the workspace has a repo, and never sent to the daemon", async () => {
    const none = await runningTask();
    const before = (await (await roomReq("GET", "/room/plugins", none.runToken)).json()) as { tools: { name: string }[] };
    expect(before.tools.map((t) => t.name)).not.toContain("diagram__save");
    const denied = await roomReq("POST", "/room/plugins/diagram__read", none.runToken, { id: "G-1" });
    expect(denied.status).toBe(403);

    const repo = await insertRepo(wsA, "api");
    const after = (await (await roomReq("GET", "/room/plugins", none.runToken)).json()) as {
      tools: { name: string; parameters: { properties: Record<string, { description?: string }> } }[];
    };
    const names = after.tools.map((t) => t.name);
    expect(names).toContain("diagram__save");
    expect(names).toContain("diagram__read");
    const save = after.tools.find((t) => t.name === "diagram__save")!;
    expect(save.parameters.properties.repo?.description).toBe(`${repo.id} (${repo.label})`);

    expect((await roomReq("POST", "/room/plugins/diagram__save", none.runToken, saveArgs(repo.label))).status).toBe(200);
    expect((await roomReq("POST", "/room/plugins/diagram__read", none.runToken, { id: "G-1" })).status).toBe(200);
    expect(daemonCalls).toEqual([]);
  });
});

describe("stale diagrams", () => {
  type Changes = { status: string; path: string }[] | Error;
  function fakeDaemon(changes: Changes) {
    const calls: { method: string; params: unknown }[] = [];
    const rpc: DaemonRpc = {
      async call(method, params) {
        calls.push({ method, params });
        if (changes instanceof Error) throw changes;
        return changes;
      },
    };
    return { rpc, calls };
  }

  async function staleOf(workspaceId = wsA): Promise<Record<string, boolean | undefined>> {
    const rows = await timeline(db, dataDir, workspaceId);
    return Object.fromEntries(rows.map((e) => [e.id, (e as { stale?: boolean }).stale]));
  }

  /** api: G-1 covers apps/hub/src, G-2 covers apps/web. web: G-3 covers apps/hub/src. */
  async function threeDiagrams() {
    const api = await insertRepo(wsA, "api", "sha_api_1");
    const web = await insertRepo(wsA, "web", "sha_web_1");
    const task = await runningTask();
    const save = async (repo: string, nodePaths: Record<string, string[]>) => {
      const res = await roomReq("POST", "/room/plugins/diagram__save", task.runToken, saveArgs(repo, { nodePaths }));
      expect(res.status).toBe(200);
    };
    await save(api.id, { hub: ["apps/hub/src"] });
    await save(api.id, { web: ["apps/web/"] });
    await save(web.id, { hub: ["apps/hub/src"] });
    emitted.length = 0;
    return { api, web, task };
  }

  test("a move touching a node path marks only that repo's covering diagrams stale", async () => {
    const { api } = await threeDiagrams();
    const daemon = fakeDaemon([{ status: "M", path: "apps/hub/src/server.ts" }]);
    await onRepoMoved(db, dataDir, daemon.rpc, events, { repoId: api.id, to: "sha_api_2" });

    expect(await staleOf()).toEqual({ "G-1": true, "G-2": false, "G-3": false });
    expect(emitted).toEqual([{ ws: wsA, event: { type: "knowledge.changed", entryId: "G-1" } }]);
    expect(daemon.calls.length).toBeGreaterThan(0);
    for (const call of daemon.calls) {
      expect(call).toEqual({
        method: "repo.changes",
        params: { workspaceId: wsA, repoId: api.id, path: `/repos/${wsA}/api`, mainBranch: "main", from: "sha_api_1", to: "sha_api_2" },
      });
    }
    expect(await db.query("select entry_id, stale, checked_sha from diagram_status where workspace_id = $1 order by entry_id", [wsA])).toEqual([
      { entry_id: "G-1", stale: true, checked_sha: "sha_api_2" },
      { entry_id: "G-2", stale: false, checked_sha: "sha_api_2" },
      { entry_id: "G-3", stale: false, checked_sha: "sha_web_1" },
    ]);

    // The same move again changes nothing, so nothing is announced.
    await onRepoMoved(db, dataDir, daemon.rpc, events, { repoId: api.id, to: "sha_api_2" });
    expect(emitted).toHaveLength(1);
  });

  test("a move touching no node path marks nothing", async () => {
    const { api } = await threeDiagrams();
    const daemon = fakeDaemon([
      { status: "M", path: "README.md" },
      { status: "A", path: "apps/hub/srcx/other.ts" },
      { status: "M", path: "apps/webapp/page.tsx" },
    ]);
    await onRepoMoved(db, dataDir, daemon.rpc, events, { repoId: api.id, to: "sha_api_2" });
    expect(await staleOf()).toEqual({ "G-1": false, "G-2": false, "G-3": false });
    expect(emitted).toEqual([]);
  });

  test("saving the diagram again clears stale", async () => {
    const { api, task } = await threeDiagrams();
    await onRepoMoved(db, dataDir, fakeDaemon([{ status: "D", path: "apps/hub/src" }]).rpc, events, { repoId: api.id, to: "sha_api_2" });
    expect((await staleOf())["G-1"]).toBe(true);
    await db.query("update workspace_repos set last_main_sha = 'sha_api_2' where id = $1", [api.id]);

    const res = await roomReq("POST", "/room/plugins/diagram__save", task.runToken, saveArgs(api.id, { id: "G-1" }));
    expect(res.status).toBe(200);
    expect((await staleOf())["G-1"]).toBe(false);
    expect(await db.query("select stale, checked_sha from diagram_status where workspace_id = $1 and entry_id = 'G-1'", [wsA])).toEqual([
      { stale: false, checked_sha: "sha_api_2" },
    ]);
  });

  test("a daemon error leaves stale unchanged", async () => {
    const { api } = await threeDiagrams();
    await onRepoMoved(db, dataDir, fakeDaemon([{ status: "M", path: "apps/hub/src/a.ts" }]).rpc, events, { repoId: api.id, to: "sha_api_2" });
    emitted.length = 0;
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      await onRepoMoved(db, dataDir, fakeDaemon(new DaemonRpcError("daemon 未连接")).rpc, events, { repoId: api.id, to: "sha_api_3" });
    } finally {
      console.error = original;
    }
    expect(await staleOf()).toEqual({ "G-1": true, "G-2": false, "G-3": false });
    expect(await db.query("select entry_id, checked_sha from diagram_status where workspace_id = $1 and entry_id in ('G-1', 'G-2') order by entry_id", [wsA])).toEqual([
      { entry_id: "G-1", checked_sha: "sha_api_2" },
      { entry_id: "G-2", checked_sha: "sha_api_2" },
    ]);
    expect(emitted).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
