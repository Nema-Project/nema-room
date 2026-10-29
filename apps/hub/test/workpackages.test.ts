import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { KnowledgeStore } from "@nema/knowledge";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { DaemonRpcError, type DaemonRpc } from "../src/daemonRpc.js";
import { EventBus } from "../src/events.js";
import { addReportMessage, postUserMessage } from "../src/messages.js";
import { WorkPackageError, applyReportToWorkPackage, requestWorkPackage, retryBlockedPackages } from "../src/workpackages.js";
import { bundledExtensions, type ReportCheck, type WpTask } from "@nema/shared";
import { setPluginState } from "../src/plugins.js";
import { roomRoutes } from "../src/roomApi.js";
import { uiRoutes } from "../src/uiApi.js";
import { git } from "@nema/knowledge";
import { claimNextTask } from "../src/tasks.js";
import { createWorkspace, repoPath } from "../src/workspaces.js";

let db: Db;
let dataDir: string;
let ws: string;
let room: Hono<any>;
const daemonCalls: { method: string; params: any }[] = [];
/**
 * Offering a tool asks the daemon which extensions the install switched off before anything else.
 * These assertions are about the calls the work-package path itself makes.
 */
const otherCalls = () => daemonCalls.filter((call) => call.method !== "extensions.list");
let missing: string[] = [];
const daemon: DaemonRpc = {
  async call(method, params: any) {
    daemonCalls.push({ method, params });
    if (method === "repo.exists") return { missing: (params.paths as string[]).filter((p) => missing.includes(p)) };
    // The tool list asks which extensions the install switched off.
    if (method === "extensions.list") return bundledExtensions();
    throw new DaemonRpcError("daemon 未连接");
  },
};

beforeEach(async () => {
  daemonCalls.length = 0;
  missing = [];
  const deps = await makeHubDeps();
  db = deps.db;
  dataDir = deps.dataDir;
  ws = (await createWorkspace(db, dataDir, "A")).id;
  room = new Hono().route("/room", roomRoutes({ db, dataDir, events: new EventBus(), daemon }));
});
afterAll(cleanupHubDeps);

async function insertRepo(label: string) {
  const id = `repo_${ws}_${label}`;
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, last_main_sha, created_at)
     values ($1, $2, $3, $4, $5, 'main', false, 'sha1', $6)`,
    [id, ws, `/repos/${label}`, `/repos/${label}/.git`, label, new Date().toISOString()],
  );
  return id;
}

async function runToken() {
  await postUserMessage(db, ws, "写开发包");
  const task = await claimNextTask(db, "d1");
  return task!.runToken!;
}

const store = () => new KnowledgeStore(repoPath(dataDir, ws));
const call = async (token: string, name: string, body: unknown) => {
  const res = await room.request(`/room/plugins/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
};

async function newPackage() {
  const repoId = await insertRepo("api");
  return store().createWorkPackage({ title: "包", requirements: ["R-1"], repos: [repoId], reason: "r", sourceMessages: [] }, { author: "user" });
}

const GOOD_SPEC = "## 意图与原因\n\nx\n\n## 已定的做法\n\n- 用队列 [D-1]\n- 推出来的 [推断]\n\n## 验收标准\n\n- ok\n";
const plan = (line: string) => `### 任务 1：做事\n${line}\n- 满足：R-1\n\n步骤略。\n`;

describe("superpowers plugin", () => {
  test("save_spec with an unmarked decision line returns ok:false listing it and writes nothing", async () => {
    const wp = await newPackage();
    const token = await runToken();
    const head = (await store().readWorkPackage(wp.id))!;
    const res = await call(token, "workpackage__save_spec", { id: wp.id, markdown: "## 已定的做法\n\n- 没有标记的做法\n" });
    expect(res.status).toBe(200);
    expect(res.json.result.ok).toBe(false);
    expect(res.json.result.error).toContain("- 没有标记的做法");
    expect((await store().readWorkPackage(wp.id))!.spec).toBeNull();
    expect(head.spec).toBeNull();
    const ok = await call(token, "workpackage__save_spec", { id: wp.id, markdown: GOOD_SPEC });
    expect(ok.json).toEqual({ result: { ok: true } });
    expect((await store().readWorkPackage(wp.id))!.spec).toBe(GOOD_SPEC);
  });

  test("save_plan with a modify path missing on main is refused; the same path as 新建 passes; an unknown label is refused", async () => {
    const wp = await newPackage();
    const token = await runToken();
    missing = ["src/x.ts"];
    const refused = await call(token, "workpackage__save_plan", { id: wp.id, markdown: plan("- 修改：api:src/x.ts") });
    expect(refused.status).toBe(200);
    expect(refused.json.result.ok).toBe(false);
    expect(refused.json.result.error).toContain("以下文件在主分支上不存在（新文件请写「新建」）");
    expect(refused.json.result.error).toContain("- 修改：api:src/x.ts");
    expect((await store().readWorkPackage(wp.id))!.plan).toBeNull();

    const created = await call(token, "workpackage__save_plan", { id: wp.id, markdown: plan("- 新建：api:src/x.ts") });
    expect(created.json).toEqual({ result: { ok: true } });

    const unknown = await call(token, "workpackage__save_plan", { id: wp.id, markdown: plan("- 修改：web:src/x.ts") });
    expect(unknown.json.result.ok).toBe(false);
    expect(unknown.json.result.error).toContain("未知仓库 web");
  });

  test("save_plan stores parsed tasks as pending", async () => {
    const wp = await newPackage();
    const token = await runToken();
    const res = await call(token, "workpackage__save_plan", { id: wp.id, markdown: plan("- 修改：api:src/a.ts") });
    expect(res.json).toEqual({ result: { ok: true } });
    expect(otherCalls().map((c) => c.method)).toEqual(["repo.exists"]);
    expect(otherCalls()[0]!.params).toMatchObject({ repoId: wp.workpackage!.repos[0], paths: ["src/a.ts"] });
    const saved = (await store().readWorkPackage(wp.id))!;
    expect(saved.entry.workpackage!.tasks).toEqual([
      {
        n: 1,
        title: "做事",
        satisfies: ["R-1"],
        files: [{ op: "modify", repo: "api", path: "src/a.ts" }],
        status: "pending",
        inferred: false,
        reportMessageId: null,
        confirmedBy: null,
      },
    ]);
  });

  test("a save after approval resets the package to draft", async () => {
    const wp = await newPackage();
    const token = await runToken();
    await store().setWorkPackageMeta(wp.id, { status: "approved", approvedAt: "2026-10-23T00:00:00.000Z", approvedCommit: "abc" }, "approve", { author: "user" });
    expect((await store().get(wp.id))!.status).toBe("approved");
    await call(token, "workpackage__save_spec", { id: wp.id, markdown: GOOD_SPEC });
    const after = (await store().get(wp.id))!;
    expect(after.status).toBe("draft");
    expect(after.workpackage).toMatchObject({ approvedAt: null, approvedCommit: null });
  });

  test("block requires an open question of this workspace", async () => {
    const wp = await newPackage();
    const token = await runToken();
    const none = await call(token, "workpackage__block", { id: wp.id, questionId: "Q-1" });
    expect(none.json.result.ok).toBe(false);
    expect((await store().get(wp.id))!.workpackage!.blockedOn).toBeNull();
    await store().upsert({ kind: "question", title: "q", body: "b", reason: "r", sourceMessages: [], priority: 1 } as never, { author: "agent" });
    const ok = await call(token, "workpackage__block", { id: wp.id, questionId: "Q-1" });
    expect(ok.json).toEqual({ result: { ok: true } });
    expect((await store().get(wp.id))!.workpackage!.blockedOn).toBe("Q-1");
    await store().upsert({ id: "Q-1", kind: "question", title: "q", body: "b", reason: "r", sourceMessages: [], status: "resolved", priority: 1 } as never, { author: "agent" });
    const resolved = await call(token, "workpackage__block", { id: wp.id, questionId: "Q-1" });
    expect(resolved.json.result.ok).toBe(false);
  });

  test("mark_task_inferred only moves pending to reported+inferred", async () => {
    const wp = await newPackage();
    const token = await runToken();
    await call(token, "workpackage__save_plan", { id: wp.id, markdown: plan("- 新建：api:src/a.ts") });
    const ok = await call(token, "workpackage__mark_task_inferred", { id: wp.id, task: 1, commits: ["abc1234"] });
    expect(ok.json).toEqual({ result: { ok: true } });
    expect((await store().get(wp.id))!.workpackage!.tasks[0]).toMatchObject({ status: "reported", inferred: true, reportMessageId: null });
    const again = await call(token, "workpackage__mark_task_inferred", { id: wp.id, task: 1, commits: ["abc1234"] });
    expect(again.json.result.ok).toBe(false);
    const nothing = await call(token, "workpackage__mark_task_inferred", { id: wp.id, task: 9, commits: ["abc1234"] });
    expect(nothing.json.result.ok).toBe(false);
  });

  test("read returns entry, spec, plan and the rules; unknown or non-package ids are 404", async () => {
    const wp = await newPackage();
    const token = await runToken();
    const res = await call(token, "workpackage__read", { id: wp.id });
    expect(res.status).toBe(200);
    expect(res.json.result.entry.id).toBe(wp.id);
    expect(res.json.result.spec).toBeNull();
    expect(res.json.result.rules.spec).toContain("## 已定的做法");
    expect(res.json.result.rules.plan).toContain("### 任务");
    const bodies: Record<string, object> = {
      workpackage__read: { id: "W-9" },
      workpackage__save_spec: { id: "W-9", markdown: "x" },
      workpackage__save_plan: { id: "W-9", markdown: "x" },
      workpackage__block: { id: "W-9", questionId: "Q-1" },
      workpackage__mark_task_inferred: { id: "W-9", task: 1, commits: ["a"] },
    };
    for (const [name, body] of Object.entries(bodies)) {
      const miss = await call(token, name, body);
      expect(miss.status).toBe(404);
      expect(miss.json.error).toBe("找不到开发包 W-9");
    }
    const notWp = await call(token, "workpackage__read", { id: "R-1" });
    expect(notWp.status).toBe(404);
  });

  test("the functions are not offered when the plugin is off", async () => {
    const wp = await newPackage();
    const token = await runToken();
    const listed = await room.request("/room/plugins", { headers: { authorization: `Bearer ${token}` } });
    const names = ((await listed.json()) as any).tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["workpackage__read", "workpackage__save_spec", "workpackage__request"]));
    await setPluginState(db, ws, "superpowers", { enabled: false });
    const off = await room.request("/room/plugins", { headers: { authorization: `Bearer ${token}` } });
    expect(((await off.json()) as any).tools.map((t: any) => t.name).filter((n: string) => n.startsWith("workpackage__"))).toEqual([]);
    const res = await call(token, "workpackage__read", { id: wp.id });
    expect(res.status).toBe(403);
  });
});

describe("generation request", () => {
  async function activeRequirement(title = "需求一") {
    const { entry } = await store().upsert(
      { kind: "requirement", title, body: "b", status: "active", reason: "r", sourceMessages: [], basis: "stated" } as never,
      { author: "user" },
    );
    return entry;
  }
  const tasks = () => db.query<{ kind: string; status: string; content: string }>(`select t.kind, t.status, m.content from tasks t join messages m on m.id = t.message_id where t.workspace_id = $1 order by t.seq`, [ws]);

  test("request creates W-1 and queues one workpackage task", async () => {
    const req = await activeRequirement();
    await insertRepo("api");
    const { entry } = await requestWorkPackage(db, dataDir, new EventBus(), ws, { requirements: [req.id] });
    expect(entry.id).toBe("W-1");
    expect(entry.title).toBe("需求一");
    expect(entry.status).toBe("draft");
    expect(await tasks()).toEqual([{ kind: "workpackage", status: "queued", content: `为 W-1 生成开发包，覆盖 ${req.id}。` }]);
  });

  test("request is refused with no repo, with a non-active requirement, and with superpowers off", async () => {
    const req = await activeRequirement();
    const events = new EventBus();
    const refusal = async (input: { requirements: string[] }) => {
      try {
        await requestWorkPackage(db, dataDir, events, ws, input);
      } catch (e) {
        return e as WorkPackageError;
      }
      throw new Error("expected a refusal");
    };
    const noRepo = await refusal({ requirements: [req.id] });
    expect([noRepo.status, noRepo.message]).toEqual([409, "请先绑定代码仓库"]);
    await insertRepo("api");
    const missing = await refusal({ requirements: ["R-9"] });
    expect(missing.status).toBe(400);
    const { entry: decision } = await store().upsert({ kind: "decision", title: "d", body: "b", status: "active", reason: "r", sourceMessages: [], basis: "decided" } as never, { author: "user" });
    expect((await refusal({ requirements: [decision.id] })).status).toBe(400);
    await setPluginState(db, ws, "superpowers", { enabled: false });
    const off = await refusal({ requirements: [req.id] });
    expect([off.status, off.message]).toEqual([409, "superpowers 插件已关闭"]);
    expect(await tasks()).toEqual([]);
    expect((await store().list()).filter((e) => e.kind === "workpackage")).toEqual([]);
  });

  test("resolving the blocking question re-queues generation once", async () => {
    const req = await activeRequirement();
    await insertRepo("api");
    const events = new EventBus();
    const { entry: wp } = await requestWorkPackage(db, dataDir, events, ws, { requirements: [req.id] });
    const { entry: q } = await store().upsert(
      { kind: "question", title: "谁审批", body: "b", status: "open", priority: 1, reason: "r", sourceMessages: [], basis: "inferred" } as never,
      { author: "agent" },
    );
    await store().setWorkPackageMeta(wp.id, { blockedOn: q.id }, "blocked", { author: "agent" });
    const resolve = async () => {
      const { entry } = await store().upsert({ id: q.id, kind: "question", title: "谁审批", body: "经理", status: "resolved", priority: 1, reason: "r", sourceMessages: [], basis: "decided" } as never, { author: "user" });
      await retryBlockedPackages(db, dataDir, events, ws, entry, "user");
    };
    expect((await tasks()).length).toBe(1);
    await resolve();
    expect((await store().get(wp.id))!.workpackage!.blockedOn).toBeNull();
    const after = await tasks();
    expect(after.length).toBe(2);
    expect(after[1]).toMatchObject({ kind: "workpackage", content: `为 ${wp.id} 生成开发包，覆盖 ${req.id}。` });
    await resolve();
    expect((await tasks()).length).toBe(2);
  });
});

describe("approve, edit, regenerate, drop", () => {
  const ui = () => new Hono().route("/api", uiRoutes({ db, dataDir, events: new EventBus(), daemonStatus: () => true, daemon }));
  const send = async (method: string, url: string, body?: unknown) => {
    const res = await ui().request(`/api/workspaces/${ws}/workpackages/${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const head = async () => (await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim();
  async function packageWithDocs() {
    const wp = await newPackage();
    await store().writeWorkPackageDoc(wp.id, "spec", GOOD_SPEC, {}, "s", [], { author: "user" });
    await store().writeWorkPackageDoc(wp.id, "plan", plan("- 新建：api:src/a.ts"), {}, "p", [], { author: "user" });
    return wp;
  }

  test("approve needs spec and plan and records the commit", async () => {
    const wp = await newPackage();
    const refused = await send("POST", `${wp.id}/approve`);
    expect([refused.status, refused.json.error]).toEqual([409, "开发包还没有 spec 和 plan"]);
    await store().writeWorkPackageDoc(wp.id, "spec", GOOD_SPEC, {}, "s", [], { author: "user" });
    expect((await send("POST", `${wp.id}/approve`)).status).toBe(409);
    await store().writeWorkPackageDoc(wp.id, "plan", plan("- 新建：api:src/a.ts"), {}, "p", [], { author: "user" });
    const before = await head();
    const ok = await send("POST", `${wp.id}/approve`);
    expect(ok.status).toBe(200);
    const meta = (await store().get(wp.id))!;
    expect(meta.status).toBe("approved");
    expect(meta.workpackage!.approvedCommit).toBe(before);
    expect(meta.workpackage!.approvedAt).not.toBeNull();
    expect((await send("POST", `${wp.id}/approve`)).status).toBe(409);
    const got = await send("GET", wp.id);
    expect(got.json.spec).toBe(GOOD_SPEC);
    expect(got.json.entry.id).toBe(wp.id);
  });

  test("editing an approved plan resets to draft and approving again records the new commit", async () => {
    const wp = await packageWithDocs();
    await send("POST", `${wp.id}/approve`);
    const first = (await store().get(wp.id))!.workpackage!.approvedCommit;
    const bad = await send("PUT", `${wp.id}/plan`, { markdown: "没有任务" });
    expect(bad.status).toBe(400);
    expect((await store().get(wp.id))!.status).toBe("approved");
    missing = ["src/x.ts"];
    expect((await send("PUT", `${wp.id}/plan`, { markdown: plan("- 修改：api:src/x.ts") })).status).toBe(400);
    const ok = await send("PUT", `${wp.id}/plan`, { markdown: plan("- 新建：api:src/b.ts") });
    expect(ok.status).toBe(200);
    const edited = (await store().get(wp.id))!;
    expect(edited.status).toBe("draft");
    expect(edited.workpackage!.approvedCommit).toBeNull();
    expect(edited.workpackage!.tasks.length).toBe(1);
    expect((await send("PUT", `${wp.id}/spec`, { markdown: GOOD_SPEC + "\n追加\n" })).status).toBe(200);
    const beforeSecond = await head();
    expect((await send("POST", `${wp.id}/approve`)).status).toBe(200);
    const second = (await store().get(wp.id))!.workpackage!.approvedCommit;
    expect(second).toBe(beforeSecond);
    expect(second).not.toBe(first);
  });

  test("regenerate on done is 409; otherwise it queues generation", async () => {
    const wp = await packageWithDocs();
    const ok = await send("POST", `${wp.id}/regenerate`);
    expect(ok.status).toBe(200);
    const queued = await db.query<{ kind: string }>(`select kind from tasks where workspace_id = $1`, [ws]);
    expect(queued.map((t) => t.kind)).toEqual(["workpackage"]);
    await store().setWorkPackageMeta(wp.id, { status: "done" }, "done", { author: "user" });
    expect((await send("POST", `${wp.id}/regenerate`)).status).toBe(409);
  });

  test("drop sets dropped", async () => {
    const wp = await packageWithDocs();
    expect((await send("POST", `${wp.id}/drop`)).status).toBe(200);
    expect((await store().get(wp.id))!.status).toBe("dropped");
    expect((await send("POST", `W-99/drop`)).status).toBe(404);
  });

  test("no workpackage__ function can set approved/in_progress/done/dropped", async () => {
    const wp = await packageWithDocs();
    const q = (await store().upsert({ kind: "question", title: "q", body: "b", status: "open", priority: 1, reason: "r", sourceMessages: [], basis: "inferred" } as never, { author: "agent" })).entry;
    const token = await runToken();
    const calls: [string, unknown][] = [
      ["workpackage__save_spec", { id: wp.id, markdown: GOOD_SPEC }],
      ["workpackage__save_plan", { id: wp.id, markdown: plan("- 新建：api:src/c.ts") }],
      ["workpackage__block", { id: wp.id, questionId: q.id }],
      ["workpackage__mark_task_inferred", { id: wp.id, task: 1, commits: ["abc"] }],
      ["workpackage__save_spec", { id: wp.id, markdown: GOOD_SPEC, status: "approved" }],
      ["workpackage__block", { id: wp.id, questionId: q.id, status: "done" }],
    ];
    for (const [name, args] of calls) {
      await call(token, name, args);
      const e = (await store().get(wp.id))!;
      expect(["approved", "in_progress", "done", "dropped"]).not.toContain(e.status);
      expect(e.workpackage!.approvedAt).toBeNull();
    }
  });
});

describe("progress from reports", () => {
  const ui = () => new Hono().route("/api", uiRoutes({ db, dataDir, events: new EventBus(), daemonStatus: () => true, daemon }));
  const events = new EventBus();
  const wpTask = (n: number, p: string): WpTask => ({
    n,
    title: `任务${n}`,
    satisfies: ["R-1"],
    files: [{ op: "modify", repo: "api", path: p }],
    status: "pending",
    inferred: false,
    reportMessageId: null,
    confirmedBy: null,
  });
  async function approvedPackage(status: "approved" | "draft" = "approved") {
    await store().upsert({ kind: "requirement", title: "需求", body: "b", reason: "r", sourceMessages: [], basis: "stated" } as never, { author: "user" });
    const wp = await newPackage();
    await store().setWorkPackageMeta(wp.id, { status, tasks: [wpTask(1, "src/a.ts"), wpTask(2, "src/b.ts")] }, "setup", { author: "user" });
    return wp;
  }
  const check = (over: Partial<ReportCheck> = {}): ReportCheck => ({
    commitsExist: true,
    missingCommits: [],
    onMain: "yes",
    filesOk: true,
    untouchedFiles: [],
    touchedFiles: ["src/a.ts"],
    checkedAt: "2026-10-23T10:00:00.000Z",
    mainSha: "2".repeat(40),
    ...over,
  });
  async function report(entries: string[], task: number | undefined, c: ReportCheck, commits = ["abcdef1"]) {
    const message = await addReportMessage(db, ws, "做完了", {
      report: { agent: "claude-code", gitCommonDir: "/x/.git", summary: "做完了", entries, commits, files: [], ...(task === undefined ? {} : { task }) },
      check: c,
    });
    await applyReportToWorkPackage(db, dataDir, events, ws, message);
    return message;
  }
  const tasks = async (id: string) => (await store().get(id))!.workpackage!.tasks;

  test("a passing report touching the task's file verifies the task and moves the package to in_progress", async () => {
    const wp = await approvedPackage();
    const m = await report([wp.id, "R-1"], 1, check());
    const after = (await store().get(wp.id))!;
    expect(after.status).toBe("in_progress");
    expect(after.workpackage!.tasks[0]).toMatchObject({ status: "verified", reportMessageId: m.id });
    expect(after.workpackage!.tasks[1]!.status).toBe("pending");
  });

  test("a passing report that touches none of the task's files is mismatch", async () => {
    const wp = await approvedPackage();
    await report([wp.id], 1, check({ touchedFiles: ["src/other.ts"] }));
    expect((await tasks(wp.id))[0]!.status).toBe("mismatch");
    await report([wp.id], 2, check({ commitsExist: false, missingCommits: ["abcdef1"] }));
    expect((await tasks(wp.id))[1]!.status).toBe("mismatch");
  });

  test("a not-yet report is reported, and a later re-check makes it verified", async () => {
    const wp = await approvedPackage();
    const m = await report([wp.id], 1, check({ onMain: "not-yet" }));
    expect((await tasks(wp.id))[0]!.status).toBe("reported");
    expect((await store().get(wp.id))!.status).toBe("in_progress");
    await applyReportToWorkPackage(db, dataDir, events, ws, { ...m, meta: { report: (m.meta as any).report, check: check() } });
    expect((await tasks(wp.id))[0]!.status).toBe("verified");
  });

  test("a later failing report does not downgrade verified", async () => {
    const wp = await approvedPackage();
    await report([wp.id], 1, check());
    await report([wp.id], 1, check({ filesOk: false }));
    await report([wp.id], 1, check({ onMain: "not-yet" }));
    expect((await tasks(wp.id))[0]!.status).toBe("verified");
  });

  test("an unknown task number or a draft package changes nothing", async () => {
    const wp = await approvedPackage();
    await report([wp.id], 9, check());
    await report(["R-1"], 1, check());
    await report([wp.id], undefined, check());
    expect((await tasks(wp.id)).map((t) => t.status)).toEqual(["pending", "pending"]);
    expect((await store().get(wp.id))!.status).toBe("approved");
    const draft = await store().createWorkPackage({ title: "草稿", requirements: ["R-1"], repos: wp.workpackage!.repos, reason: "r", sourceMessages: [] }, { author: "user" });
    await store().setWorkPackageMeta(draft.id, { tasks: [wpTask(1, "src/a.ts")] }, "setup", { author: "user" });
    await report([draft.id], 1, check());
    expect((await tasks(draft.id))[0]!.status).toBe("pending");
    expect((await store().get(draft.id))!.status).toBe("draft");
  });

  test("all tasks verified -> done, and the requirements become verified with evidence", async () => {
    const wp = await approvedPackage();
    await report([wp.id], 1, check(), ["aaaaaaa"]);
    const last = await report([wp.id], 2, check({ touchedFiles: ["src/b.ts"] }), ["bbbbbbb"]);
    expect((await store().get(wp.id))!.status).toBe("done");
    const req = (await store().get("R-1"))!;
    expect(req.implementation).toEqual({
      status: "verified",
      evidence: { reportMessageId: last.id, commits: ["aaaaaaa", "bbbbbbb"], inferred: false, note: `开发包 ${wp.id} 全部任务已核实`, confirmedBy: null },
    });
  });

  test("user confirm of an inferred task verifies it", async () => {
    const wp = await approvedPackage();
    const token = await runToken();
    expect((await call(token, "workpackage__mark_task_inferred", { id: wp.id, task: 1, commits: ["abc"] })).json.result.ok).toBe(true);
    expect((await tasks(wp.id))[0]).toMatchObject({ status: "reported", inferred: true });
    const res = await ui().request(`/api/workspaces/${ws}/workpackages/${wp.id}/tasks/1/confirm`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await tasks(wp.id))[0]).toMatchObject({ status: "verified", confirmedBy: "user" });
    expect((await store().get(wp.id))!.status).toBe("in_progress");
    const again = await ui().request(`/api/workspaces/${ws}/workpackages/${wp.id}/tasks/1/confirm`, { method: "POST" });
    expect(again.status).toBe(409);
  });
});
