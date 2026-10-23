import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KIND_DIR, PLUGINS } from "@nema/shared";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { createWorkspace, repoPath } from "../src/workspaces.js";
import { addMessage, addReportMessage, postUserMessage } from "../src/messages.js";
import { claimNextTask, finishTask, listTaskChanges } from "../src/tasks.js";
import { EventBus, type HubEvent } from "../src/events.js";
import { roomRoutes } from "../src/roomApi.js";
import { DaemonRpcError, type DaemonRpc } from "../src/daemonRpc.js";
import { Hono } from "hono";

let db: Db;
let dataDir: string;
let wsA: string;
let wsB: string;
let events: EventBus;
let app: Hono<any>;
const daemonCalls: { method: string; params: unknown; timeoutMs?: number }[] = [];
let daemonCall: (method: string, params: unknown) => Promise<unknown> = async (method) => {
  throw new Error(`unexpected daemon call ${method}`);
};
const daemon: DaemonRpc = {
  call(method, params, timeoutMs) {
    daemonCalls.push({ method, params, timeoutMs });
    return daemonCall(method, params);
  },
};

beforeEach(async () => {
  daemonCalls.length = 0;
  daemonCall = async (method) => {
    throw new Error(`unexpected daemon call ${method}`);
  };
  const deps = await makeHubDeps();
  db = deps.db;
  dataDir = deps.dataDir;
  events = new EventBus();
  wsA = (await createWorkspace(db, deps.dataDir, "A")).id;
  wsB = (await createWorkspace(db, deps.dataDir, "B")).id;
  app = new Hono().route("/room", roomRoutes({ db, dataDir: deps.dataDir, events, daemon }));
});
afterAll(cleanupHubDeps);

async function runningTaskFor(ws: string) {
  const m = await postUserMessage(db, ws, "memo");
  const t = await claimNextTask(db, "d1");
  expect(t?.workspaceId).toBe(ws);
  return { runToken: t!.runToken!, taskId: t!.id, messageId: m.message.id };
}
const req = (method: string, path: string, token?: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const upsert = (o: Record<string, unknown>) => ({ kind: "requirement", title: "T", body: "b", reason: "r", basis: "stated", ...o });

function decisionGuardError(id: string): string {
  return `改写已定决策 ${id} 需要用户消息作为依据（basis 为 stated 或 decided，且 sourceMessages 含用户消息）。若只是推断，请不要改它，改为新建一条 question 询问用户。`;
}

function entryPath(ws: string, kind: keyof typeof KIND_DIR, id: string): string {
  return path.join(repoPath(dataDir, ws), KIND_DIR[kind], `${id}.md`);
}

async function seedActiveDecision(token: string, messageId: string): Promise<void> {
  const created = await req("POST", "/room/entries", token, upsert({
    kind: "decision",
    title: "ship it",
    body: "original",
    basis: "decided",
    sourceMessages: [messageId],
  }));
  expect(created.status).toBe(200);
}

describe("room api", () => {
  test("token scopes all access to its own workspace", async () => {
    const ta = await runningTaskFor(wsA);
    const tb = await runningTaskFor(wsB);
    const r = await req("POST", "/room/entries", ta.runToken, upsert({ title: "A 的秘密需求", sourceMessages: [ta.messageId] }));
    expect(r.status).toBe(200);
    expect(((await (await req("GET", "/room/entries", ta.runToken)).json()) as any).entries).toHaveLength(1);
    const asB = await req("GET", "/room/entries", tb.runToken);
    expect(((await asB.json()) as any).entries).toEqual([]);
    expect((await req("GET", "/room/entries/R-1", tb.runToken)).status).toBe(404);
    expect((await req("GET", "/room/entries/R-1", ta.runToken)).status).toBe(200);
  });

  test("finished task token → 401", async () => {
    const t = await runningTaskFor(wsA);
    await finishTask(db, t.taskId, { ok: true });
    expect((await req("GET", "/room/entries", t.runToken)).status).toBe(401);
  });

  test("missing or garbage token → 401", async () => {
    expect((await req("GET", "/room/entries")).status).toBe(401);
    expect((await req("GET", "/room/entries", "garbage")).status).toBe(401);
    expect((await req("POST", "/room/entries", "garbage", upsert({}))).status).toBe(401);
    expect((await req("GET", "/room/entries/R-1")).status).toBe(401);
  });

  test("empty sourceMessages or another workspace's message → 400", async () => {
    const ta = await runningTaskFor(wsA);
    const other = await postUserMessage(db, wsB, "b memo");
    const e1 = await req("POST", "/room/entries", ta.runToken, upsert({ sourceMessages: [] }));
    expect(e1.status).toBe(400);
    expect(((await e1.json()) as any).error).toContain("sourceMessages");
    expect((await req("POST", "/room/entries", ta.runToken, upsert({ sourceMessages: [other.message.id] }))).status).toBe(400);
    expect((await req("POST", "/room/entries", ta.runToken, upsert({ sourceMessages: ["m_nope"] }))).status).toBe(400);
    const e2 = await req("POST", "/room/entries", ta.runToken, upsert({ title: "", sourceMessages: [ta.messageId] }));
    expect(e2.status).toBe(400);
    expect(((await e2.json()) as any).error).toContain("title");
  });

  test("upsert indexes, records task change and emits knowledge.changed", async () => {
    const t = await runningTaskFor(wsA);
    const seen: HubEvent[] = [];
    events.subscribe(wsA, (e) => seen.push(e));
    const r = await req("POST", "/room/entries", t.runToken, upsert({ title: "导出", sourceMessages: [t.messageId] }));
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.entry.id).toBe("R-1");
    expect(j.commit).toMatch(/^[0-9a-f]+$/);
    expect(seen).toEqual([{ type: "knowledge.changed", entryId: "R-1" }]);
    expect(await listTaskChanges(db, t.taskId)).toEqual([{ entryId: "R-1", kind: "requirement", title: "导出", op: "add" }]);
    const idx = await db.query(`select entry_id, title from entry_index where workspace_id = $1`, [wsA]);
    expect(idx).toEqual([{ entry_id: "R-1", title: "导出" }]);
  });

  test("update of unknown id → 404", async () => {
    const t = await runningTaskFor(wsA);
    const r = await req("POST", "/room/entries", t.runToken, upsert({ id: "R-7", sourceMessages: [t.messageId] }));
    expect(r.status).toBe(404);
  });

  test("bookkeeping failure after commit still returns 200 and the entry is committed", async () => {
    const t = await runningTaskFor(wsA);
    await db.query("drop table task_changes");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await req("POST", "/room/entries", t.runToken, upsert({ title: "kept", sourceMessages: [t.messageId] }));
    spy.mockRestore();
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.id).toBe("R-1");
    expect(((await (await req("GET", "/room/entries/R-1", t.runToken)).json()) as any).entry.title).toBe("kept");
  });

  test("rejects an upsert without basis", async () => {
    const t = await runningTaskFor(wsA);
    const { basis: _basis, ...body } = upsert({ sourceMessages: [t.messageId] });
    const r = await req("POST", "/room/entries", t.runToken, body);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("basis: required (stated | decided | inferred)");
  });

  test("rejects a quote whose message is not cited", async () => {
    const t = await runningTaskFor(wsA);
    const other = await postUserMessage(db, wsA, "other memo");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      sourceMessages: [t.messageId],
      quotes: [{ messageId: other.message.id, text: "other memo" }],
    }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe(`quotes: message ${other.message.id} is not in sourceMessages`);
  });

  test("rejects a quote that is not verbatim, including collapsed whitespace", async () => {
    const t = await runningTaskFor(wsA);
    const content = "先流式\n\n  后面再说多轮 **别动** tool";
    const m = await postUserMessage(db, wsA, content);
    const ok = await req("POST", "/room/entries", t.runToken, upsert({
      sourceMessages: [m.message.id],
      quotes: [{ messageId: m.message.id, text: "后面再说多轮 **别动**" }],
    }));
    expect(ok.status).toBe(200);
    const bad = await req("POST", "/room/entries", t.runToken, upsert({
      title: "other",
      sourceMessages: [m.message.id],
      quotes: [{ messageId: m.message.id, text: "先流式 后面再说多轮" }],
    }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe(`quotes: text must be copied verbatim from message ${m.message.id}`);
  });

  test("blocks an inferred rewrite of an active decision's body", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const file = entryPath(wsA, "decision", "D-1");
    const before = await readFile(file);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "rewritten",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toBe(decisionGuardError("D-1"));
    expect(await readFile(file)).toEqual(before);
  });

  test("blocks an inferred status-only change of an active decision to superseded", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const file = entryPath(wsA, "decision", "D-1");
    const before = await readFile(file);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "original",
      status: "superseded",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toBe(decisionGuardError("D-1"));
    expect(await readFile(file)).toEqual(before);
  });

  test("blocks a stated rewrite whose only source is an agent message", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const agent = await addMessage(db, wsA, "agent", "rewrite the decision");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "rewritten",
      basis: "stated",
      sourceMessages: [agent.id],
    }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toBe(decisionGuardError("D-1"));
  });

  test("allows a decided rewrite citing a user message", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "new body",
      basis: "decided",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.body).toBe("new body");
  });

  test("does not guard requirements or a superseded decision", async () => {
    const t = await runningTaskFor(wsA);
    const reqCreated = await req("POST", "/room/entries", t.runToken, upsert({
      title: "req",
      body: "old",
      sourceMessages: [t.messageId],
    }));
    expect(reqCreated.status).toBe(200);
    const reqUpdated = await req("POST", "/room/entries", t.runToken, upsert({
      id: "R-1",
      title: "req",
      body: "new",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(reqUpdated.status).toBe(200);
    expect(((await reqUpdated.json()) as any).entry.body).toBe("new");

    const superseded = await req("POST", "/room/entries", t.runToken, upsert({
      kind: "decision",
      title: "old call",
      body: "old",
      status: "superseded",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(superseded.status).toBe(200);
    const rewritten = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "old call",
      body: "rewritten anyway",
      status: "superseded",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(rewritten.status).toBe(200);
    expect(((await rewritten.json()) as any).entry.body).toBe("rewritten anyway");
  });

  test("does not guard a related-only update of an active decision", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "original",
      related: ["R-1"],
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(200);
    const saved = (await r.json()) as any;
    // A related-only update must not downgrade the user's decision to inferred.
    expect(saved.entry.basis).toBe("decided");
    expect(saved.entry.related).toEqual(["R-1"]);
    expect(saved.entry.body).toBe("original");
    expect(saved.entry.status).toBe("active");
  });
});

describe("decision basis changes", () => {
  async function seedInferredDecision(token: string, messageId: string): Promise<void> {
    const created = await req("POST", "/room/entries", token, upsert({
      kind: "decision",
      title: "guess",
      body: "original",
      basis: "inferred",
      sourceMessages: [messageId],
    }));
    expect(created.status).toBe(200);
  }

  test("blocks upgrading an inferred active decision to decided without a user message", async () => {
    const t = await runningTaskFor(wsA);
    await seedInferredDecision(t.runToken, t.messageId);
    const file = entryPath(wsA, "decision", "D-1");
    const before = await readFile(file);
    const agent = await addMessage(db, wsA, "agent", "I think this was decided");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "guess",
      body: "original",
      related: ["R-1"],
      basis: "decided",
      sourceMessages: [agent.id],
    }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toBe(decisionGuardError("D-1"));
    expect(await readFile(file)).toEqual(before);
  });

  test("allows upgrading an inferred active decision when a user message is cited", async () => {
    const t = await runningTaskFor(wsA);
    await seedInferredDecision(t.runToken, t.messageId);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "guess",
      body: "original",
      basis: "decided",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.basis).toBe("decided");
  });
});

const codeFunctionNames = PLUGINS.find((plugin) => plugin.id === "code")!.functions.filter((fn) => fn.readOnly).map((fn) => fn.name);
const WORKPACKAGE_NAMES = PLUGINS.find((plugin) => plugin.id === "superpowers")!.functions.map((fn) => fn.name);

let repoSeq = 0;
async function insertRepo(workspaceId: string, label: string, remoteUrl: string | null = null) {
  repoSeq += 1;
  const id = `repo_${label}`;
  const storedPath = `/repos/${workspaceId}/${label}`;
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url, created_at)
     values ($1, $2, $3, $4, $5, 'main', $7, $8, $6)`,
    [id, workspaceId, storedPath, `${storedPath}/.git`, label, new Date(Date.UTC(2026, 0, repoSeq)).toISOString(), remoteUrl !== null, remoteUrl],
  );
  return { id, label, path: storedPath, mainBranch: "main" };
}

type PluginCallRow = { task_id: string; name: string; args_summary: string; ok: boolean; result_bytes: number; ms: number };

describe("room plugins", () => {
  test("a disabled function is not offered and calling it is 403", async () => {
    const repo = await insertRepo(wsA, "api");
    await db.query(
      `insert into workspace_plugins (workspace_id, plugin_id, enabled, disabled_functions)
       values ($1, 'code', true, ARRAY['code__read'])`,
      [wsA],
    );
    const t = await runningTaskFor(wsA);
    const listed = await req("GET", "/room/plugins", t.runToken);
    expect(listed.status).toBe(200);
    const tools = ((await listed.json()) as { tools: { name: string; parameters: { properties: { repo: { description: string } } } }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([...codeFunctionNames.filter((name) => name !== "code__read"), "diagram__save", "diagram__read", ...WORKPACKAGE_NAMES]);
    expect(tools[0]?.parameters.properties.repo.description).toBe(`${repo.id} (${repo.label})`);
    const call = await req("POST", "/room/plugins/code__read", t.runToken, { repo: repo.id, path: "a.ts" });
    expect(call.status).toBe(403);
    expect(((await call.json()) as { error: string }).error).toBe("函数 code__read 未在本 workspace 开启");
    expect(daemonCalls).toEqual([]);
    expect(await db.query("select 1 from plugin_calls")).toEqual([]);
  });

  test("a call with another workspace's repo id is 400 and never reaches the daemon", async () => {
    await insertRepo(wsA, "api");
    const other = await insertRepo(wsB, "web");
    const t = await runningTaskFor(wsA);
    const r = await req("POST", "/room/plugins/code__search", t.runToken, { repo: other.id, query: "x" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe(`repo 不是本 workspace 绑定的仓库：${other.id}`);
    expect(daemonCalls).toEqual([]);
    const rows = await db.query<PluginCallRow>("select task_id, name, args_summary, ok, result_bytes, ms from plugin_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: t.taskId, name: "code__search", ok: false, result_bytes: 0 });
    expect(rows[0]!.args_summary).toContain(other.id);
  });

  test("a call is forwarded with the resolved repo and recorded in plugin_calls", async () => {
    const repo = await insertRepo(wsA, "api");
    const t = await runningTaskFor(wsA);
    const args = { repo: repo.id, query: "login" };
    const result = { hits: ["a"] };
    daemonCall = async () => result;
    const r = await req("POST", "/room/plugins/code__search", t.runToken, args);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ result });
    expect(daemonCalls).toEqual([
      {
        method: "plugin.call",
        params: {
          name: "code__search",
          args,
          repo: { workspaceId: wsA, repoId: repo.id, path: repo.path, mainBranch: repo.mainBranch },
        },
        // A cold call may build the graphify index first, which takes minutes on a real repo.
        timeoutMs: 300_000,
      },
    ]);
    const rows = await db.query<PluginCallRow>("select task_id, name, args_summary, ok, result_bytes, ms from plugin_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task_id: t.taskId,
      name: "code__search",
      args_summary: JSON.stringify(args),
      ok: true,
      result_bytes: Buffer.byteLength(JSON.stringify(result)),
    });
    expect(Number.isInteger(rows[0]!.ms)).toBe(true);
    expect(rows[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  test("plugin_calls keeps the first 200 chars of the JSON args", async () => {
    const repo = await insertRepo(wsA, "api");
    const t = await runningTaskFor(wsA);
    const args = { repo: repo.id, query: "q".repeat(300) };
    daemonCall = async () => "ok";
    const r = await req("POST", "/room/plugins/code__search", t.runToken, args);
    expect(r.status).toBe(200);
    const [row] = await db.query<{ args_summary: string }>("select args_summary from plugin_calls");
    expect(row!.args_summary).toBe(JSON.stringify(args).slice(0, 200));
    expect(row!.args_summary).toHaveLength(200);
  });

  test("daemon offline gives 503 with daemon 未连接", async () => {
    const repo = await insertRepo(wsA, "api");
    const t = await runningTaskFor(wsA);
    for (const message of ["daemon 未连接", "daemon 已断开", "daemon 响应超时"]) {
      daemonCall = async () => {
        throw new DaemonRpcError(message);
      };
      const r = await req("POST", "/room/plugins/code__search", t.runToken, { repo: repo.id, query: "q" });
      expect(r.status).toBe(503);
      expect(((await r.json()) as { error: string }).error).toBe(message);
    }
    const rows = await db.query<{ ok: boolean; result_bytes: number }>("select ok, result_bytes from plugin_calls order by id");
    expect(rows).toEqual([
      { ok: false, result_bytes: 0 },
      { ok: false, result_bytes: 0 },
      { ok: false, result_bytes: 0 },
    ]);
    expect(daemonCalls.map((call) => call.method)).toEqual(["plugin.call", "plugin.call", "plugin.call"]);
  });

  test("a rejected call is recorded in plugin_calls and never reaches the daemon", async () => {
    await insertRepo(wsA, "api", "git@github.com:acme/api.git");
    await insertRepo(wsB, "web", "https://github.com/acme/web");
    await db.query(`insert into workspace_plugins (workspace_id, plugin_id, enabled, disabled_functions) values ($1, 'github', true, '{}')`, [wsA]);
    const t = await runningTaskFor(wsA);
    const other = await req("POST", "/room/plugins/github__list_issues", t.runToken, { owner: "acme", repo: "web" });
    expect(other.status).toBe(400);
    expect(((await other.json()) as { error: string }).error).toBe("只能访问本 workspace 绑定仓库的 GitHub：acme/web");
    const search = await req("POST", "/room/plugins/github__search_issues", t.runToken, { query: "is:open login" });
    expect(search.status).toBe(400);
    expect(((await search.json()) as { error: string }).error).toBe("搜索必须且只能限定为本 workspace 绑定的仓库（repo:owner/name）");
    expect(daemonCalls).toEqual([]);
    const rows = await db.query<PluginCallRow>("select task_id, name, args_summary, ok, result_bytes, ms from plugin_calls order by id");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ task_id: t.taskId, name: "github__list_issues", ok: false, result_bytes: 0 });
    expect(rows[1]).toMatchObject({ task_id: t.taskId, name: "github__search_issues", ok: false, result_bytes: 0 });
  });

  test("an allowed GitHub call is forwarded with no repo payload", async () => {
    await insertRepo(wsA, "api", "https://github.com/Acme/API.git");
    await db.query(`insert into workspace_plugins (workspace_id, plugin_id, enabled, disabled_functions) values ($1, 'github', true, '{}')`, [wsA]);
    const t = await runningTaskFor(wsA);
    const args = { owner: "acme", repo: "api", pullNumber: 3, method: "get" };
    daemonCall = async () => "PR #3";
    const r = await req("POST", "/room/plugins/github__pull_request_read", t.runToken, args);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ result: "PR #3" });
    expect(daemonCalls).toEqual([{ method: "plugin.call", params: { name: "github__pull_request_read", args }, timeoutMs: 90_000 }]);
    const rows = await db.query<PluginCallRow>("select task_id, name, args_summary, ok, result_bytes, ms from plugin_calls");
    expect(rows).toEqual([expect.objectContaining({ name: "github__pull_request_read", ok: true, result_bytes: Buffer.byteLength(JSON.stringify("PR #3")) })]);
  });

  test("a daemon error is 502 and recorded", async () => {
    const repo = await insertRepo(wsA, "api");
    const t = await runningTaskFor(wsA);
    daemonCall = async () => {
      throw new DaemonRpcError("graphify 失败");
    };
    const r = await req("POST", "/room/plugins/code__search", t.runToken, { repo: repo.id, query: "q" });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toBe("graphify 失败");
    const rows = await db.query<{ ok: boolean; result_bytes: number }>("select ok, result_bytes from plugin_calls");
    expect(rows).toEqual([{ ok: false, result_bytes: 0 }]);
  });
});

describe("implementation rules", () => {
  const check = {
    commitsExist: true,
    missingCommits: [],
    onMain: "yes" as const,
    filesOk: true,
    untouchedFiles: [],
    touchedFiles: [],
    checkedAt: "2026-10-23T10:01:00.000Z",
    mainSha: "2".repeat(40),
  };
  const reportInput = {
    agent: "claude-code",
    gitCommonDir: "/real/a/.git",
    summary: "实现了流式输出",
    entries: ["R-1"],
    commits: ["abcdef1"],
    files: ["src/a.ts"],
  };
  const impl = (status: string, evidence: Record<string, unknown> = {}) => ({
    status,
    evidence: { reportMessageId: null, commits: [], inferred: false, note: null, confirmedBy: null, ...evidence },
  });
  const VERIFIED_NEEDS_REPORT = "实现状态 verified 需要一条核实通过的上报作为证据（evidence.reportMessageId）。";

  test("the Agent cannot set verified without a passing report, nor for inferred evidence, nor set confirmedBy", async () => {
    const t = await runningTaskFor(wsA);
    const failing = await addReportMessage(db, wsA, "未合入", { report: reportInput, check: { ...check, onMain: "not-yet" } });
    const other = await addReportMessage(db, wsB, "别的 workspace", { report: reportInput, check });
    const passing = await addReportMessage(db, wsA, "通过", { report: reportInput, check });
    const cases: [Record<string, unknown>, string][] = [
      [impl("verified"), VERIFIED_NEEDS_REPORT],
      [impl("verified", { reportMessageId: failing.id, commits: ["abcdef1"] }), VERIFIED_NEEDS_REPORT],
      [impl("verified", { reportMessageId: other.id, commits: ["abcdef1"] }), VERIFIED_NEEDS_REPORT],
      [impl("verified", { reportMessageId: t.messageId }), VERIFIED_NEEDS_REPORT],
      [impl("verified", { reportMessageId: passing.id, commits: ["1234567"] }), VERIFIED_NEEDS_REPORT],
      [impl("verified", { reportMessageId: passing.id, commits: ["abcdef1"], inferred: true }), "代码推断的实现只能由用户确认为 verified。"],
      [impl("reported", { inferred: true, confirmedBy: "user" }), "confirmedBy 只能由用户确认设置。"],
    ];
    for (const [implementation, error] of cases) {
      const r = await req("POST", "/room/entries", t.runToken, upsert({ sourceMessages: [t.messageId], implementation }));
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toBe(error);
    }
    expect(((await (await req("GET", "/room/entries", t.runToken)).json()) as any).entries).toEqual([]);
  });

  test("the Agent can set verified citing a passing report", async () => {
    const t = await runningTaskFor(wsA);
    const passing = await addReportMessage(db, wsA, "通过", { report: reportInput, check });
    const implementation = impl("verified", { reportMessageId: passing.id, commits: ["abcdef1"] });
    const r = await req("POST", "/room/entries", t.runToken, upsert({ sourceMessages: [t.messageId, passing.id], implementation }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.implementation).toEqual(implementation);
    const inferred = impl("reported", { commits: ["abcdef1"], inferred: true });
    const r2 = await req("POST", "/room/entries", t.runToken, upsert({ sourceMessages: [t.messageId], basis: "inferred", implementation: inferred }));
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as any).entry.implementation).toEqual(inferred);
  });
});
