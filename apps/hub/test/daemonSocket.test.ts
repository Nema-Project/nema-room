import http from "node:http";
import { spawn as nodeSpawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { EventBus } from "../src/events.js";
import { createWorkspace, updateWorkspace } from "../src/workspaces.js";
import { addMessage, deliverySet, editUserMessage, listMessages, listThreadMessages, messageExcerpt, postUserMessage, type AgentMessage } from "../src/messages.js";
import { AttachmentRefSchema } from "@nema/shared";
import { png, uploadPng } from "./attachmentFixtures.js";
import { claimNextTask, finishTask, getTask, insertQueuedTask, interruptRunning, recordTaskChange, resolveRunToken, toUiTask } from "../src/tasks.js";
import * as tasks from "../src/tasks.js";
import { attachDaemonSocket, parsePublicHubUrl, REMOTE_HELLO_FAILED_MESSAGE } from "../src/daemonSocket.js";
import { KnowledgeStore } from "@nema/knowledge";
import type { OwnedHelperProcess, OwnedHelperScope } from "@nema/shared/ownedHelper";
import { addReportMessage, getMessage } from "../src/messages.js";
import { indexEntry } from "../src/entryIndex.js";
import { repoPath } from "../src/workspaces.js";
import { requestWorkPackage } from "../src/workpackages.js";
import { associateQuestion, ensureThread, getQuestionThread, getThread, nextAttention } from "../src/threads.js";

const failTimeline = vi.hoisted(() => ({ on: false }));
const promptBuild = vi.hoisted(() => ({ hold: false, release: () => {}, entered: () => {} }));
vi.mock("../src/entryIndex.js", async (orig) => {
  const m = await orig<typeof import("../src/entryIndex.js")>();
  return {
    ...m,
    timeline: async (...args: Parameters<typeof m.timeline>) => {
      if (failTimeline.on) throw new Error("index exploded");
      if (promptBuild.hold) {
        await new Promise<void>((resolve) => {
          promptBuild.release = resolve;
          promptBuild.entered();
        });
      }
      return m.timeline(...args);
    },
  };
});

const TOKEN = "tok";
let db: Db;
let dataDir: string;
let events: EventBus;
let server: http.Server;
let url: string;
let handle: ReturnType<typeof attachDaemonSocket>;
const sockets: WebSocket[] = [];
let wsA: string;
let wsB: string;

beforeEach(async () => {
  failTimeline.on = false;
  promptBuild.hold = false;
  promptBuild.release = () => {};
  promptBuild.entered = () => {};
  ({ db, dataDir } = await makeHubDeps());
  events = new EventBus();
  server = http.createServer();
  handle = attachDaemonSocket(server, { db, dataDir, events, daemonToken: TOKEN, hubUrl: "http://hub.test" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/daemon`;
  wsA = (await createWorkspace(db, dataDir, "A")).id;
  wsB = (await createWorkspace(db, dataDir, "B")).id;
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
afterAll(cleanupHubDeps);

async function addQuestion(ws: string, priority: number) {
  const { entry } = await new KnowledgeStore(repoPath(dataDir, ws)).upsert(
    { kind: "question", title: `Q p${priority}`, body: "b", status: "open", priority, reason: "r", sourceMessages: [] } as never,
    { author: "agent" },
  );
  await indexEntry(db, ws, entry);
  return entry;
}

type Msg = Record<string, any>;
type Client = {
  ws: WebSocket;
  next(type?: string): Promise<Msg>;
  /** True if a message of `type` has arrived and not been taken. Never consumes it. */
  has(type: string): boolean;
  send(m: Msg): void;
  closed: Promise<void>;
};

function connect(token = TOKEN, adapters: string[] = ["codex-direct"], hello: Msg = {}, targetUrl = url, options?: WebSocket.ClientOptions): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(targetUrl, options);
    sockets.push(ws);
    const queue: Msg[] = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (d) => {
      queue.push(JSON.parse(String(d)));
      waiters.shift()?.();
    });
    const closed = new Promise<void>((r) => ws.on("close", () => r()));
    ws.on("error", reject);
    const client: Client = {
      ws,
      closed,
      send: (m) => ws.send(JSON.stringify(m)),
      has: (type) => queue.some((m) => m.type === type),
      async next(type) {
        // Generous: under a full parallel run PGlite writes and prompt builds can take seconds.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const i = queue.findIndex((m) => !type || m.type === type);
          if (i >= 0) return queue.splice(i, 1)[0]!;
          if (Date.now() > deadline) throw new Error(`timeout waiting for ${type ?? "message"}`);
          await new Promise<void>((r) => {
            waiters.push(r);
            setTimeout(r, 50);
          });
        }
      },
    };
    ws.on("open", () => {
      // `accounts` is what the real daemon advertises (DAEMON_FEATURES); without it the hub now refuses to
      // send an account-bound task, which the tests that predate the gate do not mean to exercise.
      client.send({ type: "hello", token, version: "0", adapters, features: ["accounts"], ...hello });
      resolve(client);
    });
  });
}

function pausePromptBuild(): { entered: Promise<void>; release: () => void } {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  promptBuild.entered = () => markEntered();
  promptBuild.hold = true;
  return {
    entered,
    release() {
      promptBuild.hold = false;
      promptBuild.release();
    },
  };
}

async function interruptionsOf(taskId: string): Promise<number> {
  const [row] = await db.query<{ interruptions: number }>("select interruptions from tasks where id = $1", [taskId]);
  return row!.interruptions;
}

/**
 * Asserts nothing of `type` arrives within `ms`. It only peeks: racing a `next()` here would leave that
 * call polling after the race and let it steal a later message the test is waiting for.
 */
async function noMessage(c: Client, ms = 200, type = "task.assign"): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  expect(c.has(type)).toBe(false);
}

describe("daemon socket", () => {
  test("repo-move callback carries the runtime helper scope into report work-package updates", async () => {
    const repoId = "repo_move_scope";
    const gitCommonDir = "/real/a/.git";
    await db.query(
      `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url)
       values ($1, $2, '/real/a', $3, 'API', 'main', true, null)`,
      [repoId, wsA, gitCommonDir],
    );
    const store = new KnowledgeStore(repoPath(dataDir, wsA));
    await store.upsert({ kind: "requirement", title: "需求", body: "b", reason: "r", sourceMessages: [], basis: "stated" } as never, { author: "user" });
    const wp = await store.createWorkPackage({ title: "包", requirements: ["R-1"], repos: [repoId], reason: "r", sourceMessages: [] }, { author: "user" });
    await store.setWorkPackageMeta(wp.id, {
      status: "approved",
      tasks: [{ n: 1, title: "实现", satisfies: ["R-1"], files: [{ op: "modify", repo: "API", path: "src/a.ts" }], status: "pending", inferred: false, reportMessageId: null, confirmedBy: null }],
    }, "setup", { author: "user" });
    const report = await addReportMessage(db, wsA, "实现完成", {
      report: { agent: "claude-code", gitCommonDir, summary: "实现完成", entries: [wp.id], commits: ["abcdef1"], files: ["src/a.ts"], task: 1 },
      check: { commitsExist: true, missingCommits: [], onMain: "not-yet", filesOk: true, untouchedFiles: [], touchedFiles: ["src/a.ts"], checkedAt: new Date().toISOString(), mainSha: "1".repeat(40) },
    });
    const spawnCalls: string[] = [];
    const ownedHelpers: OwnedHelperScope = {
      async spawn(command, args, options) {
        spawnCalls.push(command);
        const child = nodeSpawn(command, args, { ...options, stdio: options?.stdio ?? ["ignore", "pipe", "pipe"], windowsHide: true });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, kill: (signal) => child.kill(signal), exited: closed, closed } satisfies OwnedHelperProcess;
      },
      stopAccepting() {},
      async drain() {},
    };
    const scopedServer = http.createServer();
    const scopedHandle = attachDaemonSocket(scopedServer, { db, dataDir, events, daemonToken: TOKEN, hubUrl: "http://hub.test", ownedHelpers });
    await new Promise<void>((resolve) => scopedServer.listen(0, "127.0.0.1", resolve));
    const scopedUrl = `ws://127.0.0.1:${(scopedServer.address() as AddressInfo).port}/daemon`;
    const daemon = await connect(TOKEN, ["codex-direct"], {}, scopedUrl);
    try {
      await daemon.next("welcome");
      const sync = await daemon.next("rpc.request");
      expect(sync.method).toBe("repos.sync");
      daemon.send({ type: "rpc.response", id: sync.id, ok: true, result: {} });
      daemon.send({ type: "repo.moved", repoId, mainRef: "origin/main", from: "0".repeat(40), to: "1".repeat(40) });
      const rpcRequest = await daemon.next("rpc.request");
      expect(rpcRequest.method).toBe("report.check");
      daemon.send({ type: "rpc.response", id: rpcRequest.id, ok: true, result: {
        commitsExist: true, missingCommits: [], onMain: "yes", filesOk: true, untouchedFiles: [], touchedFiles: ["src/a.ts"], checkedAt: new Date().toISOString(), mainSha: "1".repeat(40),
      } });
      await vi.waitFor(async () => expect((await new KnowledgeStore(repoPath(dataDir, wsA)).get(wp.id))?.workpackage?.tasks[0]?.status).toBe("verified"));
      expect(spawnCalls.some((command) => /git(?:\.exe)?$/i.test(command))).toBe(true);
      expect(((await getMessage(db, report.id))!.meta as any).check.onMain).toBe("yes");
    } finally {
      await scopedHandle.close();
      scopedServer.closeAllConnections();
      await new Promise<void>((resolve) => scopedServer.close(() => resolve()));
    }
  });

  test("bad token: error then close", async () => {
    const c = await connect("nope");
    const m = await c.next("error");
    expect(m.message).toBe("daemon token 无效");
    await c.closed;
    expect(handle.isConnected()).toBe(false);
  });

  test("a hello with reportTokenHash registers it once; a refused hello registers nothing", async () => {
    const hash = "c".repeat(64);
    const bad = await connect("nope", ["codex-direct"], { reportTokenHash: "d".repeat(64) });
    await bad.closed;
    const first = await connect(TOKEN, ["codex-direct"], { reportTokenHash: hash });
    await first.next("welcome");
    const second = await connect(TOKEN, ["codex-direct"], { reportTokenHash: hash });
    await second.next("welcome");
    expect(await db.query(`select hash from report_tokens`)).toEqual([{ hash }]);
  });

  test("a daemon reporting only the legacy adapter is refused (error + close), tasks stay queued", async () => {
    await postUserMessage(db, wsA, "hi", { authorUserId: "usr_local" });
    const c = await connect(TOKEN, ["codex"]);
    const m = await c.next("error");
    expect(m.message).toBe("nema CLI 版本过旧，请运行 npm run build -w apps/cli 并重启 nema daemon");
    await c.closed;
    expect(handle.isConnected()).toBe(false);
    expect((await listMessages(db, wsA)).some((x) => x.role === "system")).toBe(false);
  });

  test("an edit task quotes the previous text and the reply points back at it", async () => {
    const original = await postUserMessage(db, wsA, "original", { authorUserId: "usr_local" });
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await addMessage(db, wsA, "agent", "which one", {
      meta: { changes: [], askedQuestion: { id: "Q-1", title: "进度", body: "到哪了" } },
    });
    await new KnowledgeStore(repoPath(dataDir, wsA)).upsert(
      { kind: "requirement", title: "进度说明", body: "b", reason: "r", basis: "stated", sourceMessages: [original.message.id] } as never,
      { author: "agent" },
    );
    await postUserMessage(db, wsA, "later note", { authorUserId: "usr_local" });
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await editUserMessage(db, wsA, original.message.id, "middle", "usr_local");
    const c = await connect();
    const failed = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: failed.taskId, ok: false, error: "boom" });
    await vi.waitFor(async () => {
      const system = (await listMessages(db, wsA)).find((m) => m.role === "system");
      expect(system?.content).toContain("boom");
      expect(system?.meta).toBeNull();
    });
    const second = await editUserMessage(db, wsA, original.message.id, "latest", "usr_local");
    events.emit(wsA, { type: "task.updated", task: { id: second.task.id, workspaceId: wsA, messageId: original.message.id, status: "queued", error: null, threadId: null } });
    const again = await c.next("task.assign");
    expect(again.prompt).toContain(`[${original.message.id}] 旧版本：middle`);
    expect(again.prompt).toContain(`[${original.message.id}] 新版本：latest`);
    expect(again.prompt).toContain("later note");
    expect(again.prompt).toContain("R-1");
    expect(again.prompt).not.toContain("上一个追问");
    c.send({ type: "task.finished", taskId: again.taskId, ok: true, reply: "updated" });
    await vi.waitFor(async () => {
      const reply = (await listMessages(db, wsA)).find((m) => m.role === "agent" && m.content === "updated");
      expect(reply?.meta && "quote" in reply.meta && reply.meta.quote).toEqual({
        messageId: original.message.id,
        role: "user",
        excerpt: messageExcerpt("latest"),
      });
    });
  });

  test("a quote in the prompt is the message's current text", async () => {
    const target = await postUserMessage(db, wsA, "first wording", { authorUserId: "usr_local" });
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await editUserMessage(db, wsA, target.message.id, "rewritten wording", "usr_local");
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await postUserMessage(db, wsA, "I meant the architecture", { authorUserId: "usr_local", quoteMessageId: target.message.id });
    const c = await connect();
    const assigned = await c.next("task.assign");
    expect(assigned.prompt).toContain("# 本次消息引用的消息");
    expect(assigned.prompt).toContain("rewritten wording");
    expect(assigned.prompt).not.toContain("first wording");
  });

  test("recent user messages name their author only once the workspace has two active members (#163)", async () => {
    const single = await postUserMessage(db, wsA, "solo note", { authorUserId: "usr_local" });
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await db.query("insert into users(id,display_name) values ('usr_zhang','张三')");
    await db.query("insert into workspace_members(workspace_id,user_id,role,added_by) values ($1,'usr_zhang','member','usr_local')", [wsA]);
    await postUserMessage(db, wsA, "from zhang", { authorUserId: "usr_zhang" });
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await postUserMessage(db, wsA, "按 @张三 的说法", { authorUserId: "usr_local", mentions: [{ type: "member", id: "usr_zhang", text: "@张三" }] });
    const c = await connect();
    const assigned = await c.next("task.assign");
    expect(assigned.prompt).toContain(`[${single.message.id}] user(我): solo note`);
    expect(assigned.prompt).toContain("user(张三): from zhang");
    expect(assigned.prompt).toContain("## 成员 @张三（usr_zhang）");
  });

  test("a single-member workspace keeps the plain user label (#163)", async () => {
    const first = await postUserMessage(db, wsA, "solo note", { authorUserId: "usr_local" });
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await postUserMessage(db, wsA, "next", { authorUserId: "usr_local" });
    const c = await connect();
    const assigned = await c.next("task.assign");
    expect(assigned.prompt).toContain(`[${first.message.id}] user: solo note`);
    expect(assigned.prompt).not.toContain("user(");
  });

  test("assign carries confidential from the workspace setting", async () => {
    await updateWorkspace(db, wsA, { confidential: false });
    await updateWorkspace(db, wsB, { confidential: true });
    await postUserMessage(db, wsA, "open", { authorUserId: "usr_local" });
    await postUserMessage(db, wsB, "secret", { authorUserId: "usr_local" });
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a).toMatchObject({ workspaceId: wsA, adapter: "auto", confidential: false });
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "r" });
    const b = await c.next("task.assign");
    expect(b).toMatchObject({ workspaceId: wsB, adapter: "auto", confidential: true });
  });

  test("a thread's activated Skills ride on its tasks, newest first; main chat and record-less threads carry none", async () => {
    await postUserMessage(db, wsA, "main chat", { authorUserId: "usr_local" });
    const anchor = (await postUserMessage(db, wsA, "anchor", { authorUserId: "usr_local" })).message;
    const thread = await ensureThread(db, anchor.id, "T", "user");
    await db.query(
      `insert into thread_skill_activations(thread_id, skill_id, last_activated_at, last_task_id, revision)
       values ($1, 'tdd', now() - interval '1 hour', 't0', 'r'), ($1, 'pdf', now(), 't0', 'r')`,
      [thread.id],
    );
    await postUserMessage(db, wsA, "in thread", { authorUserId: "usr_local", threadId: thread.id });
    const other = (await postUserMessage(db, wsB, "other anchor", { authorUserId: "usr_local" })).message;
    const otherThread = await ensureThread(db, other.id, "U", "user");
    const c = await connect();
    const seen: Array<{ content: string; retained: unknown }> = [];
    for (let i = 0; i < 4; i++) {
      const a = await c.next("task.assign");
      const task = await getTask(db, a.taskId as string);
      const message = await getMessage(db, task!.messageId);
      seen.push({ content: message!.content, retained: (a as Record<string, unknown>).retainedSkills });
      c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "r" });
    }
    expect(Object.fromEntries(seen.map((s) => [s.content, s.retained]))).toEqual({
      "main chat": undefined,
      anchor: ["pdf", "tdd"],
      "in thread": ["pdf", "tdd"],
      "other anchor": undefined,
    });
    expect(otherThread.id).toBe(other.id);
  });

  test("task.assign lists only trusted repositories as projectSkills, and none when nothing is trusted", async () => {
    await db.query(
      `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url, trust_skills)
       values ('repo_t', $1, '/src/web', '/src/web/.git', 'web', 'main', false, null, true),
              ('repo_u', $1, '/src/api', '/src/api/.git', 'api', 'main', false, null, false)`,
      [wsA],
    );
    await postUserMessage(db, wsA, "a", { authorUserId: "usr_local" });
    await postUserMessage(db, wsB, "b", { authorUserId: "usr_local" });
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a.projectSkills).toEqual([{ repoId: "repo_t", label: "web", path: "/src/web", mainBranch: "main", gitCommonDir: "/src/web/.git" }]);
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "r" });
    const b = await c.next("task.assign");
    expect(b).not.toHaveProperty("projectSkills");
  });

  test("a leading /skill-name rides on its task as manualSkill; built-ins, mid-text names and others carry none", async () => {
    await postUserMessage(db, wsA, "/tdd 写测试\n第二行", { authorUserId: "usr_local" });
    await postUserMessage(db, wsA, "/thread x", { authorUserId: "usr_local" });
    await postUserMessage(db, wsA, "请用 /tdd", { authorUserId: "usr_local" });
    await postUserMessage(db, wsA, "/skill:thread 开", { authorUserId: "usr_local" });
    await postUserMessage(db, wsA, "plain", { authorUserId: "usr_local" });
    const c = await connect();
    const seen: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) {
      const a = await c.next("task.assign");
      const message = await getMessage(db, (await getTask(db, a.taskId as string))!.messageId);
      seen[message!.content] = (a as Record<string, unknown>).manualSkill;
      expect(a.prompt).toContain(message!.content.split("\n")[0]);
      c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "r" });
    }
    expect(seen).toEqual({
      "/tdd 写测试\n第二行": { skillId: "tdd", arguments: "写测试\n第二行" },
      "/thread x": undefined,
      "请用 /tdd": undefined,
      "/skill:thread 开": { skillId: "thread", arguments: "开" },
      plain: undefined,
    });
  });

  test("an edited message is read again: the re-run carries the new /skill-name", async () => {
    const m = await postUserMessage(db, wsA, "/tdd first", { authorUserId: "usr_local" });
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await editUserMessage(db, wsA, m.message.id, "/review again", "usr_local");
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a.manualSkill).toEqual({ skillId: "review", arguments: "again" });
  });

  test("a reply carries the skills its task offered, and the offers are cleared once it is saved", async () => {
    const m = await postUserMessage(db, wsA, "install the pdf skill", { authorUserId: "usr_local" });
    const c = await connect();
    expect((await c.next()).type).toBe("welcome");
    const a = await c.next("task.assign");
    const offer = {
      id: "pdf",
      name: "pdf",
      description: "Read PDFs",
      source: "acme/skills",
      repository: "https://github.com/acme/skills",
      commit: "b".repeat(40),
      path: "skills/pdf",
      license: null,
      target: "/x/extensions/pdf",
    };
    await db.query(`insert into task_skill_offers (task_id, skill_id, offer) values ($1, $2, $3::jsonb)`, [a.taskId, "pdf", JSON.stringify(offer)]);
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "here is the skill" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    const agent = (await listMessages(db, wsA)).find((row): row is AgentMessage => row.role === "agent")!;
    expect(agent.meta?.skillOffers).toEqual([offer]);
    expect(await db.query(`select 1 from task_skill_offers where task_id = $1`, [a.taskId])).toEqual([]);
  });

  test("a reply without offers has no skillOffers field", async () => {
    const m = await postUserMessage(db, wsA, "hello", { authorUserId: "usr_local" });
    const c = await connect();
    expect((await c.next()).type).toBe("welcome");
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "hi" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    const agent = (await listMessages(db, wsA)).find((row): row is AgentMessage => row.role === "agent")!;
    expect(agent.meta && "skillOffers" in agent.meta).toBe(false);
  });

  test("dispatches, stores agent reply with meta, completes, dispatches next", async () => {
    await updateWorkspace(db, wsA, { confidential: false });
    const m1 = await postUserMessage(db, wsA, "first", { authorUserId: "usr_local" });
    const m2 = await postUserMessage(db, wsA, "second", { authorUserId: "usr_local" });
    const status: boolean[] = [];
    events.subscribeAll((ws, e) => e.type === "daemon.status" && status.push(e.connected));
    const c = await connect();
    expect((await c.next()).type).toBe("welcome");
    const a1 = await c.next("task.assign");
    expect(a1).toMatchObject({ taskId: m1.task.id, workspaceId: wsA, adapter: "auto", confidential: false, hubUrl: "http://hub.test" });
    expect(a1.prompt).toContain("first");
    expect(handle.isConnected()).toBe(true);
    expect(status).toEqual([true]);

    await addQuestion(wsA, 1);
    await recordTaskChange(db, m1.task.id, { entryId: "R-1", kind: "requirement", title: "T", op: "add" });
    const progress: unknown[] = [];
    events.subscribe(wsA, (e) => e.type === "task.progress" && progress.push(e));
    c.send({ type: "task.event", taskId: m1.task.id, event: { type: "progress", text: "working" } });
    c.send({ type: "task.finished", taskId: m1.task.id, ok: true, reply: "done 1" });
    const a2 = await c.next("task.assign");
    expect(a2.taskId).toBe(m2.task.id);
    expect(progress).toEqual([{ type: "task.progress", taskId: m1.task.id, text: "working", threadId: null }]);
    const msgs = await listMessages(db, wsA);
    const agent = msgs.find((m): m is AgentMessage => m.role === "agent")!;
    expect(agent.content).toBe("done 1");
    expect(agent.taskId).toBe(m1.task.id);
    expect(agent.meta?.changes).toEqual([{ entryId: "R-1", kind: "requirement", title: "T", op: "add" }]);
    expect(agent.meta?.askedQuestion).toBeNull();
    expect((await getTask(db, m1.task.id))?.status).toBe("done");
  });

  test("the asked card is a question this task opened, not an older higher-priority one", async () => {
    const older = await addQuestion(wsA, 1);
    const m1 = await postUserMessage(db, wsA, "where is the doc", { authorUserId: "usr_local" });
    const created = await addQuestion(wsA, 3);
    await recordTaskChange(db, m1.task.id, { entryId: created.id, kind: "question", title: created.title, op: "add" });
    const c = await connect();
    const a1 = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a1.taskId, ok: true, reply: "asked the new one" });
    await vi.waitFor(async () => expect((await getTask(db, m1.task.id))?.status).toBe("done"));
    const threadId = await getQuestionThread(db, wsA, created.id);
    const agent = (await listThreadMessages(db, threadId!)).find((m): m is AgentMessage => m.role === "agent")!;
    expect(agent.meta?.askedQuestion?.id).toBe(created.id);
    expect(agent.meta?.askedQuestion?.id).not.toBe(older.id);
  });

  test("the first answer after legacy conversion receives that question in its assigned prompt", async () => {
    const q = await addQuestion(wsA, 1);
    const threadId = await nextAttention(db, dataDir, wsA);
    expect(threadId).toBeTruthy();
    expect(await getQuestionThread(db, wsA, q.id)).toBe(threadId);
    const answer = await postUserMessage(db, wsA, "Here is the answer", { authorUserId: "usr_local", threadId: threadId! });
    const c = await connect();
    const assignment = await c.next("task.assign");
    expect(assignment.taskId).toBe(answer.task.id);
    expect(assignment.prompt).toContain("# 上一个追问");
    expect(assignment.prompt).toContain(`${q.id}：${q.title}`);
    expect(assignment.prompt).toContain(q.body);
    c.send({ type: "task.finished", taskId: answer.task.id, ok: true, reply: "answer recorded" });
    await vi.waitFor(async () => expect((await getTask(db, answer.task.id))?.status).toBe("done"));
  });

  test("a main-chat task that adds a question replies in a new thread on its message", async () => {
    const m = await postUserMessage(db, wsA, "unclear request", { authorUserId: "usr_local" });
    const q = await addQuestion(wsA, 2);
    await recordTaskChange(db, m.task.id, { entryId: q.id, kind: "question", title: q.title, op: "add" });
    const c = await connect();
    const assigned = await c.next("task.assign");
    const received: any[] = [];
    let threadReplyCount = 0;
    events.subscribe(wsA, (e) => {
      if (e.type === "message.created") received.push(e.message);
      if (e.type === "thread.updated" && e.thread.id === m.message.id) threadReplyCount = e.thread.replyCount;
    });
    c.send({ type: "task.finished", taskId: assigned.taskId, ok: true, reply: "please clarify" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    expect(await getQuestionThread(db, wsA, q.id)).toBe(m.message.id);
    expect(await getThread(db, m.message.id)).toMatchObject({ id: m.message.id, openedBy: "grill" });
    expect(threadReplyCount).toBe(1);
    expect(received.find((item) => item.role === "agent")).toMatchObject({ threadId: m.message.id, content: "please clarify" });
    expect(await listMessages(db, wsA)).toContainEqual(expect.objectContaining({ id: m.message.id }));
  });

  test("an open question updated by the task opens a thread; resolved and dropped questions do not", async () => {
    const store = new KnowledgeStore(repoPath(dataDir, wsA));
    const updatedTasks = [] as Array<{ message: Awaited<ReturnType<typeof postUserMessage>>; questionId: string }>;
    for (const status of ["open", "resolved", "dropped"] as const) {
      const q = await store.upsert({ kind: "question", title: `Updated ${status}`, body: "b", status, priority: 1, reason: "r", sourceMessages: [] } as never, { author: "agent" });
      const message = await postUserMessage(db, wsA, `update ${status}`, { authorUserId: "usr_local" });
      await recordTaskChange(db, message.task.id, { entryId: q.entry.id, kind: "question", title: q.entry.title, op: "update" });
      updatedTasks.push({ message, questionId: q.entry.id });
    }
    const c = await connect();
    for (const [i, status] of (["open", "resolved", "dropped"] as const).entries()) {
      const a = await c.next("task.assign");
      expect(a.taskId).toBe(updatedTasks[i]!.message.task.id);
      c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: status });
      await vi.waitFor(async () => expect((await getTask(db, a.taskId))?.status).toBe("done"));
      expect(await getThread(db, updatedTasks[i]!.message.message.id) !== null).toBe(status === "open");
    }
  });

  test("thread replies associate every touched open question once and keep existing links", async () => {
    const m = await postUserMessage(db, wsA, "several questions", { authorUserId: "usr_local" });
    const q1 = await addQuestion(wsA, 1);
    const q2 = await addQuestion(wsA, 2);
    const oldAnchor = await postUserMessage(db, wsA, "old topic", { authorUserId: "usr_local" });
    await ensureThread(db, oldAnchor.message.id, "Existing", "user");
    await associateQuestion(db, wsA, q2.id, oldAnchor.message.id);
    await recordTaskChange(db, m.task.id, { entryId: q1.id, kind: "question", title: q1.title, op: "add" });
    await recordTaskChange(db, m.task.id, { entryId: q2.id, kind: "question", title: q2.title, op: "update" });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "two asks" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    expect(await getQuestionThread(db, wsA, q1.id)).toBe(m.message.id);
    expect(await getQuestionThread(db, wsA, q2.id)).toBe(oldAnchor.message.id);
    expect((await listThreadMessages(db, m.message.id)).filter((x) => x.role === "agent")).toHaveLength(1);
  });

  test("a main-chat task with no question and no open_thread stays in main chat with null askedQuestion", async () => {
    const m = await postUserMessage(db, wsA, "ordinary", { authorUserId: "usr_local" });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "ordinary reply" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    const agent = (await listMessages(db, wsA)).find((x): x is AgentMessage => x.role === "agent")!;
    expect(agent).toMatchObject({ content: "ordinary reply", threadId: null });
    expect(agent.meta?.askedQuestion).toBeNull();
  });

  test("reply goes to the thread when the task message is in a thread", async () => {
    const anchor = await postUserMessage(db, wsA, "anchor", { authorUserId: "usr_local" });
    await ensureThread(db, anchor.message.id, "Thread", "user");
    await db.query("update tasks set status='done' where id=$1", [anchor.task.id]);
    const m = await postUserMessage(db, wsA, "thread follow-up", { authorUserId: "usr_local", threadId: anchor.message.id });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "thread reply" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    expect((await listThreadMessages(db, anchor.message.id)).some((x) => x.content === "thread reply")).toBe(true);
    expect((await listMessages(db, wsA)).some((x) => x.content === "thread reply")).toBe(false);
  });

  test("a thread opened during the task receives its reply, with no main-chat agent message", async () => {
    const m = await postUserMessage(db, wsA, "open while running", { authorUserId: "usr_local" });
    const c = await connect();
    const a = await c.next("task.assign");
    await ensureThread(db, m.message.id, "Opened by tool", "agent");
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "in the opened thread" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    expect((await listThreadMessages(db, m.message.id)).some((x) => x.content === "in the opened thread")).toBe(true);
    expect((await listMessages(db, wsA)).some((x) => x.content === "in the opened thread")).toBe(false);
  });

  test("failure message stays in a thread", async () => {
    const m = await postUserMessage(db, wsA, "fail here", { authorUserId: "usr_local" });
    await ensureThread(db, m.message.id, "Failure", "agent");
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: false, error: "boom" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("failed"));
    expect(await listThreadMessages(db, m.message.id)).toContainEqual(expect.objectContaining({ role: "system", threadId: m.message.id, content: "处理失败：boom" }));
  });

  test("daemon failure opens a grill thread for a touched open question", async () => {
    const m = await postUserMessage(db, wsA, "fails after asking", { authorUserId: "usr_local" });
    const q = await addQuestion(wsA, 1);
    await recordTaskChange(db, m.task.id, { entryId: q.id, kind: "question", title: q.title, op: "add" });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: false, error: "daemon error" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("failed"));
    expect(await getThread(db, m.message.id)).toMatchObject({ id: m.message.id, openedBy: "grill" });
    expect(await getQuestionThread(db, wsA, q.id)).toBe(m.message.id);
    expect(await listThreadMessages(db, m.message.id)).toContainEqual(expect.objectContaining({ role: "system", threadId: m.message.id, content: "处理失败：daemon error" }));
  });

  test("prompt failure routes a retained question from an interrupted attempt", async () => {
    const m = await postUserMessage(db, wsA, "first attempt asks", { authorUserId: "usr_local" });
    const first = await connect();
    await first.next("task.assign");
    const q = await addQuestion(wsA, 1);
    await recordTaskChange(db, m.task.id, { entryId: q.id, kind: "question", title: q.title, op: "add" });
    first.ws.terminate();
    await first.closed;
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("queued"));
    failTimeline.on = true;
    const retry = await connect();
    await retry.next("welcome");
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("failed"));
    expect(await getThread(db, m.message.id)).toMatchObject({ id: m.message.id, openedBy: "grill" });
    expect(await getQuestionThread(db, wsA, q.id)).toBe(m.message.id);
    expect(await listThreadMessages(db, m.message.id)).toContainEqual(expect.objectContaining({ role: "system", threadId: m.message.id }));
  });

  test("failure associates a touched open question with its existing thread", async () => {
    const m = await postUserMessage(db, wsA, "thread failure asks", { authorUserId: "usr_local" });
    await ensureThread(db, m.message.id, "Existing topic", "user");
    const q = await addQuestion(wsA, 2);
    await recordTaskChange(db, m.task.id, { entryId: q.id, kind: "question", title: q.title, op: "update" });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: false, error: "thread error" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("failed"));
    expect(await getQuestionThread(db, wsA, q.id)).toBe(m.message.id);
    expect(await listThreadMessages(db, m.message.id)).toContainEqual(expect.objectContaining({ role: "system", threadId: m.message.id, content: "处理失败：thread error" }));
  });

  test("retry reuses the thread opened during the first run and stores one reply", async () => {
    const m = await postUserMessage(db, wsA, "interrupted", { authorUserId: "usr_local" });
    const first = await connect();
    await first.next("task.assign");
    await ensureThread(db, m.message.id, "Opened during run", "agent");
    first.ws.terminate();
    await first.closed;
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("queued"));
    const retry = await connect();
    const a = await retry.next("task.assign");
    retry.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "once" });
    retry.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "duplicate" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    expect(await getThread(db, m.message.id)).not.toBeNull();
    expect((await listThreadMessages(db, m.message.id)).filter((x) => x.role === "agent")).toHaveLength(1);
  });

  test("a reply insert failure rolls back task, thread, and associations before retry succeeds", async () => {
    const m = await postUserMessage(db, wsA, "atomic reply", { authorUserId: "usr_local" });
    const q = await addQuestion(wsA, 1);
    await recordTaskChange(db, m.task.id, { entryId: q.id, kind: "question", title: q.title, op: "add" });
    const c = await connect();
    const a = await c.next("task.assign");
    const originalTx = db.tx.bind(db);
    let failedInsert = false;
    let rolledBack = false;
    const txSpy = vi.spyOn(db, "tx").mockImplementation(((fn: (tx: Db) => Promise<unknown>) => originalTx(async (tx) => {
      const wrapped = new Proxy(tx, {
        get(target, property) {
          if (property === "query") return async (sql: string, params?: unknown[]) => {
            if (sql.startsWith("insert into messages")) {
              failedInsert = true;
              throw new Error("injected reply insert failure");
            }
            return target.query(sql, params);
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Db;
      try { return await fn(wrapped); } catch (error) { rolledBack = true; throw error; }
    })) as typeof db.tx);
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "retry me" });
    await vi.waitFor(() => expect(rolledBack && failedInsert).toBe(true));
    txSpy.mockRestore();
    expect((await getTask(db, m.task.id))?.status).toBe("running");
    expect(await getThread(db, m.message.id)).toBeNull();
    expect(await getQuestionThread(db, wsA, q.id)).toBeNull();
    expect((await listMessages(db, wsA)).some((x) => x.role === "agent")).toBe(false);

    c.ws.terminate();
    await c.closed;
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("queued"));
    const retry = await connect();
    const retryAssignment = await retry.next("task.assign");
    retry.send({ type: "task.finished", taskId: retryAssignment.taskId, ok: true, reply: "saved once" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    expect(await getQuestionThread(db, wsA, q.id)).toBe(m.message.id);
    expect((await listThreadMessages(db, m.message.id)).filter((x) => x.role === "agent")).toHaveLength(1);
  });

  test("editing an anchor and a report that adds a question reply in their threads", async () => {
    const anchor = await postUserMessage(db, wsA, "original", { authorUserId: "usr_local" });
    await ensureThread(db, anchor.message.id, "Anchor", "agent");
    await db.query("update tasks set status='done' where id=$1", [anchor.task.id]);
    const edited = await editUserMessage(db, wsA, anchor.message.id, "corrected", "usr_local");
    const c = await connect();
    const editAssignment = await c.next("task.assign");
    expect(editAssignment.taskId).toBe(edited.task.id);
    c.send({ type: "task.finished", taskId: editAssignment.taskId, ok: true, reply: "edited reply" });
    await vi.waitFor(async () => expect((await getTask(db, edited.task.id))?.status).toBe("done"));
    expect((await listThreadMessages(db, anchor.message.id)).some((x) => x.content === "edited reply")).toBe(true);
    c.ws.terminate();
    await c.closed;

    const report = await addReportMessage(db, wsA, "report body", { report: { agent: "test", gitCommonDir: "/tmp/report/.git", summary: "report", entries: [], commits: [], files: [] }, check: null });
    const reportTask = await insertQueuedTask(db, wsA, report.id);
    const q = await addQuestion(wsA, 1);
    await recordTaskChange(db, reportTask.id, { entryId: q.id, kind: "question", title: q.title, op: "add" });
    const reportClient = await connect();
    const reportAssignment = await reportClient.next("task.assign");
    expect(reportAssignment.taskId).toBe(reportTask.id);
    reportClient.send({ type: "task.finished", taskId: reportTask.id, ok: true, reply: "report asks" });
    await vi.waitFor(async () => expect((await getTask(db, reportTask.id))?.status).toBe("done"));
    expect(await getQuestionThread(db, wsA, q.id)).toBe(report.id);
    expect((await listThreadMessages(db, report.id)).some((x) => x.content === "report asks")).toBe(true);
  });

  test("grill off keeps a question-adding task reply in main chat", async () => {
    await db.query(`insert into workspace_plugins (workspace_id, plugin_id, enabled) values ($1, 'grill', false)`, [wsA]);
    const m = await postUserMessage(db, wsA, "no grill", { authorUserId: "usr_local" });
    const q = await addQuestion(wsA, 1);
    await recordTaskChange(db, m.task.id, { entryId: q.id, kind: "question", title: q.title, op: "add" });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "main reply" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    expect(await getThread(db, m.message.id)).toBeNull();
    expect((await listMessages(db, wsA)).some((x) => x.content === "main reply" && x.threadId === null)).toBe(true);
  });

  test("with grill-me off the finished message has no asked question", async () => {
    const m1 = await postUserMessage(db, wsA, "first", { authorUserId: "usr_local" });
    await db.query(`insert into workspace_plugins (workspace_id, plugin_id, enabled) values ($1, 'grill', false)`, [wsA]);
    await addQuestion(wsA, 1);
    const c = await connect();
    const a1 = await c.next("task.assign");
    expect(a1.prompt).toContain("不确定或有歧义时，不要猜，写成 `question` 条目");
    expect(a1.prompt).toContain("任何其他与 active 决策矛盾的陈述");
    expect(a1.prompt).not.toContain("追问严格程度");
    c.send({ type: "task.finished", taskId: m1.task.id, ok: true, reply: "done" });
    await vi.waitFor(async () => expect((await getTask(db, m1.task.id))?.status).toBe("done"));
    const agent = (await listMessages(db, wsA)).find((m): m is AgentMessage => m.role === "agent")!;
    expect(agent.meta?.askedQuestion).toBeNull();
  });

  test("hub restart: startup requeue unwedges a task left running and re-dispatches it with a fresh token", async () => {
    const m = await postUserMessage(db, wsA, "survive restart", { authorUserId: "usr_local" });
    // The previous hub process had handed this task to a daemon, then died.
    const stale = (await claimNextTask(db, "d_previous_process"))!;
    expect(stale.status).toBe("running");
    // Startup routine of the new hub process (main.ts) runs before the socket accepts daemons.
    expect(await interruptRunning(db, "all")).toEqual({ requeued: [m.task.id], failed: [] });
    expect(await getTask(db, m.task.id)).toMatchObject({ status: "queued", runToken: null, daemonId: null });
    expect(await resolveRunToken(db, stale.runToken!)).toBeNull();
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a.taskId).toBe(m.task.id);
    expect(a.runToken).not.toBe(stale.runToken);
    expect(await resolveRunToken(db, a.runToken)).toEqual({ taskId: m.task.id, workspaceId: wsA });
  });

  test("daemon hello requeues running rows owned by another daemon id and re-dispatches them", async () => {
    const m = await postUserMessage(db, wsA, "orphan", { authorUserId: "usr_local" });
    const stale = (await claimNextTask(db, "d_ghost"))!;
    const seen: string[] = [];
    const payloads: unknown[] = [];
    events.subscribe(wsA, (e) => {
      if (e.type !== "task.updated") return;
      seen.push(e.task.status);
      payloads.push(e.task);
    });
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a.taskId).toBe(m.task.id);
    expect(a.runToken).not.toBe(stale.runToken);
    expect(await resolveRunToken(db, stale.runToken!)).toBeNull();
    expect(seen).toEqual(["queued", "running"]);
    // UI-facing task.updated payloads never carry the run token or daemon id.
    for (const p of payloads) {
      expect(p).not.toHaveProperty("runToken");
      expect(p).not.toHaveProperty("daemonId");
    }
    expect(JSON.stringify(payloads)).not.toContain(a.runToken);
  });

  test("global serial across workspaces", async () => {
    const a = await postUserMessage(db, wsA, "a", { authorUserId: "usr_local" });
    const b = await postUserMessage(db, wsB, "b", { authorUserId: "usr_local" });
    const c = await connect();
    const first = await c.next("task.assign");
    expect(first.taskId).toBe(a.task.id);
    await noMessage(c);
    c.send({ type: "task.finished", taskId: a.task.id, ok: true, reply: "x" });
    expect((await c.next("task.assign")).taskId).toBe(b.task.id);
  });

  test("ignores task.finished for a task not assigned to the connection", async () => {
    const a = await postUserMessage(db, wsA, "a", { authorUserId: "usr_local" });
    const b = await postUserMessage(db, wsB, "b", { authorUserId: "usr_local" });
    const c = await connect();
    await c.next("task.assign");
    c.send({ type: "task.finished", taskId: b.task.id, ok: true, reply: "bogus" });
    await noMessage(c);
    expect((await getTask(db, b.task.id))?.status).toBe("queued");
    expect((await listMessages(db, wsB)).filter((m) => m.role === "agent")).toHaveLength(0);
    void a;
  });

  test("follow-up: prompt includes last asked question", async () => {
    const q = await addQuestion(wsA, 1);
    const first = await postUserMessage(db, wsA, "hello", { authorUserId: "usr_local" });
    await addMessage(db, wsA, "agent", "reply", {
      taskId: first.task.id,
      meta: { changes: [], askedQuestion: { id: q.id, title: q.title, body: q.body } },
    });
    await postUserMessage(db, wsA, "postgres", { authorUserId: "usr_local" });
    const c = await connect();
    await c.next("task.assign"); // first task
    c.send({ type: "task.finished", taskId: first.task.id, ok: true, reply: "r" });
    const a2 = await c.next("task.assign");
    expect(a2.prompt).toContain("上一个追问");
    expect(a2.prompt).toContain(q.id);
  });

  test("prompt uses latest agent message's question and includes newer agent replies, excludes later user messages", async () => {
    const q1 = await addQuestion(wsA, 1);
    const q2 = await addQuestion(wsA, 2);
    const u0 = await postUserMessage(db, wsA, "zero", { authorUserId: "usr_local" });
    await addMessage(db, wsA, "agent", "OLDER-REPLY", { taskId: u0.task.id, meta: { changes: [], askedQuestion: { id: q1.id, title: q1.title, body: q1.body } } });
    const u1 = await postUserMessage(db, wsA, "current-msg", { authorUserId: "usr_local" });
    await addMessage(db, wsA, "agent", "NEWER-REPLY", { taskId: u0.task.id, meta: { changes: [], askedQuestion: { id: q2.id, title: q2.title, body: q2.body } } });
    await postUserMessage(db, wsA, "LATER-USER", { authorUserId: "usr_local" });
    await db.query("update tasks set status = 'done' where id = $1", [u0.task.id]);
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a.taskId).toBe(u1.task.id);
    const upTo = a.prompt.split("# 上一个追问")[1]!.split("# 最近消息")[0]!;
    expect(upTo).toContain(q2.id);
    expect(upTo).not.toContain(`${q1.id}：`);
    expect(a.prompt).toContain("NEWER-REPLY");
    expect(a.prompt).not.toContain("LATER-USER");
  });

  test("a named answer targets that question, not the latest follow-up", async () => {
    const q1 = await addQuestion(wsA, 1);
    const q2 = await addQuestion(wsA, 2);
    const u0 = await postUserMessage(db, wsA, "zero", { authorUserId: "usr_local" });
    await addMessage(db, wsA, "agent", "asked-q2", { taskId: u0.task.id, meta: { changes: [], askedQuestion: { id: q2.id, title: q2.title, body: q2.body } } });
    await db.query("update tasks set status = 'done' where id = $1", [u0.task.id]);
    const u1 = await postUserMessage(db, wsA, `回答 ${q1.id}：\n里程碑二`, { authorUserId: "usr_local" });
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a.taskId).toBe(u1.task.id);
    expect(a.prompt).toContain("要回答的追问");
    expect(a.prompt).toContain(`${q1.id}：`);
    expect(a.prompt).not.toContain("上一个追问");
    expect(a.prompt.split("# 要回答的追问")[1]!.split("# 最近消息")[0]).not.toContain(`${q2.id}：`);
  });

  test("prompt build failure: system message once, task failed, no stuck running", async () => {
    const a = await postUserMessage(db, wsA, "a", { authorUserId: "usr_local" });
    await ensureThread(db, a.message.id, "Prompt error", "agent");
    failTimeline.on = true;
    const c = await connect();
    await c.next("welcome");
    for (let i = 0; i < 100 && (await getTask(db, a.task.id))?.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await getTask(db, a.task.id))?.status).toBe("failed");
    const sys = (await listThreadMessages(db, a.message.id)).filter((m) => m.role === "system");
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({ threadId: a.message.id });
    expect(sys[0]!.content.startsWith("处理失败：")).toBe(true);
  });

  test("disconnect emits task.updated queued for the requeued task", async () => {
    const a = await postUserMessage(db, wsA, "a", { authorUserId: "usr_local" });
    const seen: string[] = [];
    events.subscribeAll((_w, e) => e.type === "task.updated" && e.task.id === a.task.id && seen.push(e.task.status));
    const c = await connect();
    await c.next("task.assign");
    expect(seen).toContain("running");
    c.ws.terminate();
    for (let i = 0; i < 100 && seen[seen.length - 1] !== "queued"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(seen[seen.length - 1]).toBe("queued");
  });

  test("disconnect requeues; reconnect gets same task with new runToken", async () => {
    const a = await postUserMessage(db, wsA, "a", { authorUserId: "usr_local" });
    const c1 = await connect();
    const a1 = await c1.next("task.assign");
    c1.ws.terminate();
    await c1.closed;
    for (let i = 0; i < 50 && (await getTask(db, a.task.id))?.status !== "queued"; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await getTask(db, a.task.id))?.status).toBe("queued");
    const c2 = await connect();
    const a2 = await c2.next("task.assign");
    expect(a2.taskId).toBe(a1.taskId);
    expect(a2.runToken).not.toBe(a1.runToken);
  });

  // #167 task 10: a second hello no longer replaces the first connection (spec acceptance ①).
  test("a second daemon connects alongside the first; the first keeps its running task", async () => {
    const a = await postUserMessage(db, wsA, "a", { authorUserId: "usr_local" });
    const b = await postUserMessage(db, wsB, "b", { authorUserId: "usr_local" });
    const c1 = await connect();
    const a1 = await c1.next("task.assign");
    expect(a1.taskId).toBe(a.task.id);
    const c2 = await connect();
    const b2 = await c2.next("task.assign");
    expect(b2.taskId).toBe(b.task.id);
    expect(c1.ws.readyState).toBe(WebSocket.OPEN);
    const ids = handle.connectedDaemonIds();
    expect(ids).toHaveLength(2);
    expect(await getTask(db, a.task.id)).toMatchObject({ status: "running", runToken: a1.runToken, daemonId: ids[0] });
    expect(await getTask(db, b.task.id)).toMatchObject({ status: "running", runToken: b2.runToken, daemonId: ids[1] });
    expect(await interruptionsOf(a.task.id)).toBe(0);
    // Each finishes its own task; neither can finish the other's.
    c2.send({ type: "task.finished", taskId: a.task.id, ok: true, reply: "not mine" });
    c1.send({ type: "task.finished", taskId: a.task.id, ok: true, reply: "mine" });
    await vi.waitFor(async () => expect((await getTask(db, a.task.id))?.status).toBe("done"));
    expect((await listMessages(db, wsA)).filter((m) => m.role === "agent").map((m) => m.content)).toEqual(["mine"]);
    expect((await getTask(db, b.task.id))?.status).toBe("running");
  });

  test("one daemon disconnecting requeues only its own task; the other's keeps running", async () => {
    const a = await postUserMessage(db, wsA, "a", { authorUserId: "usr_local" });
    const b = await postUserMessage(db, wsB, "b", { authorUserId: "usr_local" });
    const status: boolean[] = [];
    events.subscribeAll((_w, e) => { if (e.type === "daemon.status") status.push(e.connected); });
    const c1 = await connect();
    await c1.next("task.assign");
    const c2 = await connect();
    const b2 = await c2.next("task.assign");
    const [, secondId] = handle.connectedDaemonIds();
    c1.ws.terminate();
    await c1.closed;
    await vi.waitFor(async () => expect((await getTask(db, a.task.id))?.status).toBe("queued"));
    expect(await interruptionsOf(a.task.id)).toBe(1);
    expect(await getTask(db, b.task.id)).toMatchObject({ status: "running", runToken: b2.runToken, daemonId: secondId });
    expect(await interruptionsOf(b.task.id)).toBe(0);
    // The status the UI shows stays "connected" while any daemon is online.
    expect(handle.isConnected()).toBe(true);
    expect(status).not.toContain(false);
    // The survivor finishes its task, then picks up the requeued one.
    c2.send({ type: "task.finished", taskId: b.task.id, ok: true, reply: "done b" });
    expect((await c2.next("task.assign")).taskId).toBe(a.task.id);
    c2.ws.terminate();
    await c2.closed;
    await vi.waitFor(() => expect(status.at(-1)).toBe(false));
    expect(handle.isConnected()).toBe(false);
  });

  test("failure: system message, task failed, next dispatched", async () => {
    const a = await postUserMessage(db, wsA, "a", { authorUserId: "usr_local" });
    const b = await postUserMessage(db, wsB, "b", { authorUserId: "usr_local" });
    const c = await connect();
    await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.task.id, ok: false, error: "boom" });
    expect((await c.next("task.assign")).taskId).toBe(b.task.id);
    const sys = (await listMessages(db, wsA)).find((m) => m.role === "system")!;
    expect(sys.content).toBe("处理失败：boom");
    expect((await getTask(db, a.task.id))?.status).toBe("failed");
  });

  test("a dispatch race requeues without spending a retry", async () => {
    const c1 = await connect();
    await c1.next("welcome");
    const posted = await postUserMessage(db, wsA, "race", { authorUserId: "usr_local" });
    let c2: Client | null = null;
    let firstToken: string | null = null;
    const realClaim = tasks.claimNextTask;
    const claimSpy = vi.spyOn(tasks, "claimNextTask").mockImplementation(async (database, daemonId) => {
      if (c2 === null) {
        // c1 goes away between "it was idle" and the claim; a new daemon connects meanwhile. Its hello
        // waits on this dispatchOnce, so the claim made for c1 is requeued before anything sweeps it.
        c1.ws.terminate();
        await c1.closed;
        c2 = await connect();
      }
      const task = await realClaim(database, daemonId);
      if (firstToken === null && task?.runToken) firstToken = task.runToken;
      return task;
    });
    try {
      events.emit(wsA, { type: "task.updated", task: toUiTask(posted.task, posted.message.threadId) });
      for (let i = 0; i < 50 && c2 === null; i++) await new Promise((r) => setTimeout(r, 20));
      expect(c2).not.toBeNull();
      const assign = await c2!.next("task.assign");
      expect(assign.taskId).toBe(posted.task.id);
      expect(assign.runToken).not.toBe(firstToken);
      const [row] = await db.query<{ interruptions: number; status: string }>(
        "select interruptions, status from tasks where id = $1",
        [posted.task.id],
      );
      expect(row).toEqual({ interruptions: 0, status: "running" });
    } finally {
      claimSpy.mockRestore();
    }
  });

  test("a second daemon's hello during the first's prompt build leaves that claim alone", async () => {
    const c1 = await connect();
    await c1.next("welcome");
    const posted = await postUserMessage(db, wsA, "unsent", { authorUserId: "usr_local" });
    const gate = pausePromptBuild();
    events.emit(wsA, { type: "task.updated", task: toUiTask(posted.task, posted.message.threadId) });
    await gate.entered;
    expect((await getTask(db, posted.task.id))?.status).toBe("running");
    const c2 = await connect();
    gate.release();
    const assign = await c1.next("task.assign");
    expect(assign.taskId).toBe(posted.task.id);
    await c2.next("welcome");
    expect(c1.ws.readyState).toBe(WebSocket.OPEN);
    expect(await getTask(db, posted.task.id)).toMatchObject({ status: "running", runToken: assign.runToken });
    expect(await interruptionsOf(posted.task.id)).toBe(0);
    await noMessage(c2);
    expect((await listMessages(db, wsA)).some((m) => m.role === "system")).toBe(false);
  });

  test("a disconnect during prompt build does not spend a retry", async () => {
    const c1 = await connect();
    await c1.next("welcome");
    const posted = await postUserMessage(db, wsA, "unsent", { authorUserId: "usr_local" });
    const gate = pausePromptBuild();
    events.emit(wsA, { type: "task.updated", task: toUiTask(posted.task, posted.message.threadId) });
    await gate.entered;
    expect((await getTask(db, posted.task.id))?.status).toBe("running");
    c1.ws.terminate();
    await c1.closed;
    for (let n = 0; n < 50 && (await getTask(db, posted.task.id))?.status === "running"; n++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    gate.release();
    expect(await interruptionsOf(posted.task.id)).toBe(0);
    expect((await getTask(db, posted.task.id))?.status).toBe("queued");
    expect((await listMessages(db, wsA)).some((m) => m.role === "system")).toBe(false);
  });

  test.each(["thread member", "anchor whose thread was opened after submission", "main conversation"] as const)("four daemon disconnects mid-run post a system failure in the %s conversation", async (scenario) => {
    let taskId: string;
    let threadId: string | null;
    if (scenario === "thread member") {
      const anchor = await addMessage(db, wsA, "agent", "thread anchor");
      const thread = await ensureThread(db, anchor.id, "Follow-up", "user");
      threadId = thread.id;
      taskId = (await postUserMessage(db, wsA, "thread member", { authorUserId: "usr_local", threadId: thread.id })).task.id;
    } else if (scenario === "anchor whose thread was opened after submission") {
      const anchor = await postUserMessage(db, wsA, "main anchor", { authorUserId: "usr_local" });
      taskId = anchor.task.id;
      threadId = (await ensureThread(db, anchor.message.id, "Opened before interruption", "user")).id;
    } else {
      const anchor = await postUserMessage(db, wsA, "main task", { authorUserId: "usr_local" });
      taskId = anchor.task.id;
      threadId = null;
    }
    let threadUpdates = 0;
    if (threadId) events.subscribe(wsA, (event) => { if (event.type === "thread.updated" && event.thread.id === threadId) threadUpdates++; });
    let client = await connect();
    for (let i = 0; i < 4; i++) {
      expect((await client.next("task.assign")).taskId).toBe(taskId);
      client.ws.terminate();
      await client.closed;
      if (i < 3) {
        for (let n = 0; n < 50 && (await getTask(db, taskId))?.status !== "queued"; n++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        expect((await getTask(db, taskId))?.status).toBe("queued");
        client = await connect();
      }
    }
    const failedText = "处理失败：任务被中断，自动重试 3 次后仍未完成。请重新发送这条消息。";
    if (threadId) {
      let system: Awaited<ReturnType<typeof listThreadMessages>> = [];
      for (let n = 0; n < 50; n++) {
        system = (await listThreadMessages(db, threadId)).filter((m) => m.role === "system");
        if (system.length > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(system).toEqual([expect.objectContaining({ content: failedText, taskId, threadId })]);
      expect((await listMessages(db, wsA)).filter((m) => m.role === "system")).toHaveLength(0);
      expect(threadUpdates).toBe(1);
    } else {
      let system: Awaited<ReturnType<typeof listMessages>> = [];
      for (let n = 0; n < 50; n++) {
        system = (await listMessages(db, wsA)).filter((m) => m.role === "system");
        if (system.length > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(system).toEqual([expect.objectContaining({ content: failedText, taskId, threadId: null })]);
      expect(threadUpdates).toBe(0);
    }
    const [row] = await db.query<{ status: string; error: string | null; interruptions: number }>(
      "select status, error, interruptions from tasks where id = $1",
      [taskId],
    );
    expect(row).toEqual({
      status: "failed",
      error: "任务被中断，自动重试 3 次后仍未完成。请重新发送这条消息。",
      interruptions: 4,
    });
  });

  test("welcome lists the existing workspace ids so the daemon can reconcile its isolation dirs", async () => {
    const c = await connect();
    const w = await c.next("welcome");
    expect([...w.workspaceIds].sort()).toEqual([wsA, wsB].sort());
  });

  test("workspace.deleted is forwarded to the connected daemon only", async () => {
    events.emit(wsA, { type: "workspace.deleted", workspaceId: wsA }); // nobody connected: dropped, reconciled on welcome
    const c = await connect();
    await c.next("welcome");
    events.emit(wsB, { type: "workspace.deleted", workspaceId: wsB });
    expect(await c.next("workspace.deleted")).toEqual({ type: "workspace.deleted", workspaceId: wsB });
    await noMessage(c, 200, "workspace.deleted");
  });

  test("workspace.deleted and the repos.sync that follows reach every connected daemon", async () => {
    const c1 = await connect();
    await c1.next("welcome");
    await c1.next("rpc.request");
    const c2 = await connect();
    await c2.next("welcome");
    await c2.next("rpc.request");
    events.emit(wsB, { type: "workspace.deleted", workspaceId: wsB });
    for (const c of [c1, c2]) {
      expect(await c.next("workspace.deleted")).toEqual({ type: "workspace.deleted", workspaceId: wsB });
      expect(await c.next("rpc.request")).toMatchObject({ method: "repos.sync" });
    }
  });

  test("new task enqueued later is dispatched via task.updated", async () => {
    const c = await connect();
    await c.next("welcome");
    const a = await postUserMessage(db, wsA, "late", { authorUserId: "usr_local" });
    events.emit(wsA, { type: "task.updated", task: toUiTask(a.task, a.message.threadId) });
    expect((await c.next("task.assign")).taskId).toBe(a.task.id);
  });

  test("the workpackage task.assign carries the 48/120/20min limits and the work package prompt; an organize task does not", async () => {
    const store = new KnowledgeStore(repoPath(dataDir, wsA));
    const { entry: req } = await store.upsert(
      { kind: "requirement", title: "R", body: "b", status: "active", reason: "r", sourceMessages: [], basis: "stated" } as never,
      { author: "user" },
    );
    await db.query(
      `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, last_main_sha, created_at)
       values ('repo_a', $1, '/repos/api', '/repos/api/.git', 'api', 'main', false, 'sha1', $2)`,
      [wsA, new Date().toISOString()],
    );
    await requestWorkPackage(db, dataDir, events, wsA, { requirements: [req.id] });
    const c = await connect();
    const wp = await c.next("task.assign");
    expect(wp.workspaceId).toBe(wsA);
    expect(wp.limits).toEqual({ maxModelCalls: 48, maxToolCalls: 120, timeoutMs: 1_200_000 });
    expect(wp.prompt).toContain("# 开发包 W-1");
    expect(wp.prompt).toContain("repo_a（api）");
    c.send({ type: "task.finished", taskId: wp.taskId, ok: true, reply: "r" });
    await postUserMessage(db, wsB, "plain", { authorUserId: "usr_local" });
    events.emit(wsB, { type: "task.updated", task: { id: "x", workspaceId: wsB, messageId: "x", status: "queued", error: null, threadId: null } });
    const organize = await c.next("task.assign");
    expect(organize.workspaceId).toBe(wsB);
    expect(organize.limits).toBeUndefined();
    expect(organize.prompt).not.toContain("# 开发包");
  });
});

describe("mentions in the task prompt", () => {
  test("a mentioned entry is inlined between the quoted message and this user message, and a mentioned file is delivered", async () => {
    const store = new KnowledgeStore(repoPath(dataDir, wsA));
    const { entry } = await store.upsert(
      { kind: "decision", title: "发布流程", body: "先灰度再全量。", reason: "r", sourceMessages: [], basis: "decided" } as never,
      { author: "user" },
    );
    await indexEntry(db, wsA, entry);
    const file = await uploadPng(db, dataDir, wsA, png(70), "截图.png");
    const earlier = await postUserMessage(db, wsA, "看这张", { authorUserId: "usr_local", attachmentIds: [file.id] });
    await db.query("update tasks set status = 'done' where id = $1", [earlier.task.id]);

    const content = `按 [${entry.id}] 来，再看 \`附件：截图.png\``;
    const m = await postUserMessage(db, wsA, content, { authorUserId: "usr_local",
      mentions: [
        { type: "entry", id: entry.id, text: `[${entry.id}]` },
        { type: "attachment", id: file.id, text: "`附件：截图.png`" },
      ],
    });
    const c = await connect(TOKEN, ["codex-direct"], { features: ["attachments"] });
    expect((await c.next()).type).toBe("welcome");
    const a = await c.next("task.assign");
    expect(a.taskId).toBe(m.task.id);
    expect(a.prompt).toContain(`## 条目 [${entry.id}] 发布流程（decision，active）`);
    expect(a.prompt).toContain("先灰度再全量。");
    expect(a.prompt).toContain("## 附件「截图.png」（image，message ");
    expect(a.prompt).toContain("已随本次任务投递");
    const mentionsAt = a.prompt.indexOf("# 本次提及的上下文");
    expect(mentionsAt).toBeGreaterThan(-1);
    expect(a.prompt.indexOf("# 本次用户消息")).toBeGreaterThan(mentionsAt);
    // The mentioned file really is in the delivery set.
    expect(a.attachments?.map((x: { id: string }) => x.id)).toContain(file.id);
    void store;
  });

  test("a message without mentions has no mention section at all", async () => {
    const m = await postUserMessage(db, wsA, "普通消息", { authorUserId: "usr_local" });
    const c = await connect();
    expect((await c.next("welcome"))).toBeTruthy();
    const a = await c.next("task.assign");
    expect(a.taskId).toBe(m.task.id);
    expect(a.prompt).not.toContain("# 本次提及的上下文");
  });
});

describe("attachments in task.assign", () => {
  test("a daemon with the attachments feature gets the delivery set, each a valid AttachmentRef", async () => {
    const quotedFile = await uploadPng(db, dataDir, wsA, png(80), "old.png");
    const quoted = await postUserMessage(db, wsA, "old", { authorUserId: "usr_local", attachmentIds: [quotedFile.id] });
    await db.query("update tasks set status = 'done' where id = $1", [quoted.task.id]);
    const file = await uploadPng(db, dataDir, wsA, png(64), "new.png");
    const m = await postUserMessage(db, wsA, "", { authorUserId: "usr_local", attachmentIds: [file.id], quoteMessageId: quoted.message.id });
    const c = await connect(TOKEN, ["codex-direct"], { features: ["attachments"] });
    expect((await c.next()).type).toBe("welcome");
    const a = await c.next("task.assign");
    expect(a.taskId).toBe(m.task.id);
    expect(a.attachments).toEqual(await deliverySet(db, m.task.id));
    expect(a.attachments.map((r: { id: string }) => r.id)).toEqual([file.id, quotedFile.id]);
    for (const ref of a.attachments) expect(AttachmentRefSchema.parse(ref)).toEqual(ref);
    // The prompt names the files; their bytes travel only through the room route.
    expect(a.prompt).toContain("[附件：new.png（image/png，64 B），见本次附件]");
    expect(a.prompt).not.toContain(png(64).toString("base64"));
  });

  test("without the feature, a task with attachments fails plainly and a text task still runs", async () => {
    const file = await uploadPng(db, dataDir, wsA);
    const withFile = await postUserMessage(db, wsA, "see file", { authorUserId: "usr_local", attachmentIds: [file.id] });
    const textOnly = await postUserMessage(db, wsA, "just text", { authorUserId: "usr_local" });
    const c = await connect();
    expect((await c.next()).type).toBe("welcome");
    const a = await c.next("task.assign");
    expect(a.taskId).toBe(textOnly.task.id);
    expect(a.attachments).toBeUndefined();
    await vi.waitFor(async () => expect((await getTask(db, withFile.task.id))?.status).toBe("failed"));
    const failure = (await listMessages(db, wsA)).find((row) => row.role === "system" && row.taskId === withFile.task.id);
    expect(failure?.content).toContain("当前 daemon 不支持附件");
  });

  test("a text-only task carries no attachments field", async () => {
    await postUserMessage(db, wsA, "plain", { authorUserId: "usr_local" });
    const c = await connect(TOKEN, ["codex-direct"], { features: ["attachments"] });
    expect((await c.next()).type).toBe("welcome");
    const a = await c.next("task.assign");
    expect("attachments" in a).toBe(false);
  });
});

describe("account choice and route decision", () => {
  test("a message that named an account sends that id down; one that named none sends no field", async () => {
    const picked = await postUserMessage(db, wsA, "on the second account", { authorUserId: "usr_local", accountId: "acct_abc1234567" });
    const plain = await postUserMessage(db, wsA, "on whatever the default is", { authorUserId: "usr_local" });
    const c = await connect();
    const a1 = await c.next("task.assign");
    expect(a1).toMatchObject({ taskId: picked.task.id, accountId: "acct_abc1234567" });
    // Nothing was said about automatic routing, so nothing is claimed about it.
    expect(a1).not.toHaveProperty("routing");

    c.send({ type: "task.finished", taskId: a1.taskId, ok: true, reply: "ok" });
    await vi.waitFor(async () => expect((await getTask(db, picked.task.id))?.status).toBe("done"));

    const a2 = await c.next("task.assign");
    expect(a2.taskId).toBe(plain.task.id);
    expect(a2).not.toHaveProperty("accountId");
  });

  test("an account-bound task is refused for a daemon that would drop the field, not run on its default", async () => {
    // An older daemon parses task.assign with accountId removed, so it would answer from whichever account is
    // its default — the one thing the user did not pick. The hub fails the task and says why instead.
    const m = await postUserMessage(db, wsA, "on the second account", { authorUserId: "usr_local", accountId: "acct_abc1234567" });
    const c = await connect(TOKEN, ["codex-direct"], { features: [] });
    await c.next("welcome");
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("failed"));
    expect(await c.has("task.assign")).toBe(false);
    const system = (await listMessages(db, wsA)).find((x) => x.role === "system")!;
    expect(system.content).toContain("不支持按账户运行任务");
  });

  test("a task that names no account still runs on a daemon without the capability", async () => {
    // Nothing was chosen, so nothing can be substituted: the old daemon's default is the intended answer.
    const m = await postUserMessage(db, wsA, "whatever the default is", { authorUserId: "usr_local" });
    const c = await connect(TOKEN, ["codex-direct"], { features: [] });
    const a = await c.next("task.assign");
    expect(a).toMatchObject({ taskId: m.task.id });
    expect(a).not.toHaveProperty("accountId");
  });

  test("a task that allows automatic routing says so", async () => {
    const m = await postUserMessage(db, wsA, "auto please", { authorUserId: "usr_local" });
    await db.query("update tasks set routing = 'auto' where id = $1", [m.task.id]);
    const c = await connect();
    const a1 = await c.next("task.assign");
    expect(a1).toMatchObject({ taskId: m.task.id, routing: "auto" });
  });

  test("a thread task carries its thread id; a main-chat task carries none", async () => {
    const mainChat = await postUserMessage(db, wsB, "plain main chat", { authorUserId: "usr_local" });
    const anchor = await postUserMessage(db, wsA, "anchor", { authorUserId: "usr_local" });
    await ensureThread(db, anchor.message.id, "A thread", "user");
    const inThread = await postUserMessage(db, wsA, "reply in the thread", { authorUserId: "usr_local", threadId: anchor.message.id });
    const activity: unknown[] = [];
    events.subscribe(wsA, (event) => activity.push(event));
    const c = await connect();
    const seen = new Map<string, Msg>();
    // Dispatch is one task at a time and the anchor now sits in its own thread, so walk the queue until the
    // thread reply arrives instead of assuming an order across workspaces.
    for (let i = 0; i < 4 && !seen.has(inThread.task.id); i++) {
      const a = await c.next("task.assign");
      seen.set(a.taskId, a);
      c.send({ type: "task.event", taskId: a.taskId, event: { type: "progress", text: "Reading" } });
      c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "ok" });
    }
    // A main-chat message belongs to no thread, so nothing is claimed about one.
    expect(seen.get(mainChat.task.id)).toBeDefined();
    expect(seen.get(mainChat.task.id)).not.toHaveProperty("threadId");
    expect(seen.get(inThread.task.id)).toMatchObject({ threadId: anchor.message.id });
    await vi.waitFor(() => {
      for (const taskId of [anchor.task.id, inThread.task.id]) {
        expect(activity).toContainEqual(expect.objectContaining({
          type: "task.updated", task: expect.objectContaining({ id: taskId, status: "running", threadId: anchor.message.id }),
        }));
        expect(activity).toContainEqual({
          type: "task.progress", taskId, threadId: anchor.message.id, text: "Reading",
        });
      }
    });
  });

  test("progress follows a running task when its message becomes a thread anchor", async () => {
    const posted = await postUserMessage(db, wsA, "Opening prompt", { authorUserId: "usr_local" });
    const activity: unknown[] = [];
    events.subscribe(wsA, (event) => activity.push(event));
    const client = await connect();
    const assignment = await client.next("task.assign");
    const thread = await ensureThread(db, posted.message.id, "Follow-up", "agent");
    events.emit(wsA, { type: "thread.updated", thread });
    client.send({ type: "task.event", taskId: assignment.taskId, event: { type: "progress", text: "Reading" } });
    await vi.waitFor(() => expect(activity).toContainEqual({
      type: "task.progress", taskId: posted.task.id, threadId: thread.id, text: "Reading",
    }));
    expect(activity).toContainEqual(expect.objectContaining({
      type: "task.updated", task: expect.objectContaining({ id: posted.task.id, status: "running", threadId: thread.id }),
    }));
  });

  test("the route the daemon reports is stored on the agent message", async () => {
    const m = await postUserMessage(db, wsA, "who answered this", { authorUserId: "usr_local" });
    const c = await connect();
    const a = await c.next("task.assign");
    const route = { accountId: "acct_abc1234567", accountName: "Personal", model: "gpt-5.5", mode: "manual", reason: "user_workspace" };
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "me", route });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    const agent = (await listMessages(db, wsA)).find((x): x is AgentMessage => x.role === "agent")!;
    expect(agent.meta?.route).toEqual(route);
  });

  test("an old daemon that sends no route still saves its reply", async () => {
    const m = await postUserMessage(db, wsA, "old daemon", { authorUserId: "usr_local" });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "still here" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    const agent = (await listMessages(db, wsA)).find((x): x is AgentMessage => x.role === "agent")!;
    expect(agent.content).toBe("still here");
    expect(agent.meta?.route).toBeUndefined();
  });

  test("a failure names the account it happened on, and keeps the record", async () => {
    // A failed task has no reply, so the route line has nowhere to go; the account and model join the
    // failure line instead, and the same record is stored beside it for later.
    const m = await postUserMessage(db, wsA, "will fail", { authorUserId: "usr_local", accountId: "acct_abc1234567" });
    const c = await connect();
    const a = await c.next("task.assign");
    const route = { accountId: "acct_abc1234567", accountName: "Personal", model: "gpt-5.5", mode: "manual", reason: "user_message" };
    c.send({ type: "task.finished", taskId: a.taskId, ok: false, error: "订阅额度已用完", route });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("failed"));
    const system = (await listMessages(db, wsA)).find((x) => x.role === "system")!;
    expect(system.content).toContain("订阅额度已用完");
    expect(system.content).toContain("Personal");
    expect(system.content).toContain("gpt-5.5");
    expect((system.meta as { route?: unknown } | null)?.route).toEqual(route);
  });

  test("a route this hub cannot read costs the route line, not the reply", async () => {
    // A daemon from a later version, or a record the hub's schema does not know. Dropping the whole
    // message would throw away an answer the user is waiting for; the reply is kept and the route is not.
    const m = await postUserMessage(db, wsA, "later version", { authorUserId: "usr_local" });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({
      type: "task.finished",
      taskId: a.taskId,
      ok: true,
      reply: "an answer worth keeping",
      route: { accountId: "acct_abc1234567", accountName: "Personal", model: "m", mode: "manual", reason: "invented_later" },
    });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    const reply = (await listMessages(db, wsA)).find((x) => x.role === "agent" && x.content === "an answer worth keeping")!;
    expect(reply).toBeDefined();
    expect((reply.meta as { route?: unknown } | null)?.route).toBeUndefined();
  });

  test("a failure whose route cannot be read still reports the failure", async () => {
    const m = await postUserMessage(db, wsA, "later version, failing", { authorUserId: "usr_local" });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({
      type: "task.finished",
      taskId: a.taskId,
      ok: false,
      error: "订阅额度已用完",
      route: { accountId: "acct_abc1234567", baseUrl: "https://example.test" },
    });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("failed"));
    const system = (await listMessages(db, wsA)).find((x) => x.role === "system")!;
    // The error survives and no unreadable account line is invented for it.
    expect(system.content).toBe("处理失败：订阅额度已用完");
  });

  test("a failure from a daemon that routed nothing reads as it always did", async () => {
    const m = await postUserMessage(db, wsA, "plain failure", { authorUserId: "usr_local" });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: false, error: "something broke" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("failed"));
    const system = (await listMessages(db, wsA)).find((x) => x.role === "system")!;
    expect(system.content).toBe("处理失败：something broke");
    expect(system.meta).toBeNull();
  });
});

describe("S3 acceptance: the account shown under the reply", () => {
  test("the metadata a real daemon sends renders as one line: account, model, reason", async () => {
    // The shape the daemon puts on `task.finished` after routing (see apps/cli/src/routing/index.ts):
    // the hub stores it verbatim under `meta.route`, which is what the reply line reads.
    const m = await postUserMessage(db, wsA, "who is this", { authorUserId: "usr_local", accountId: "acct_abc1234567" });
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a.accountId).toBe("acct_abc1234567");
    c.send({
      type: "task.finished",
      taskId: a.taskId,
      ok: true,
      reply: "me",
      route: {
        accountId: "acct_abc1234567",
        accountName: "OpenRouter 免费",
        model: "deepseek/xxx",
        mode: "manual",
        reason: "user_message",
        usage: { inputTokens: 120, outputTokens: 40 },
      },
    });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    const agent = (await listMessages(db, wsA)).find((x): x is AgentMessage => x.role === "agent")!;
    expect(agent.meta?.route).toEqual({
      accountId: "acct_abc1234567",
      accountName: "OpenRouter 免费",
      model: "deepseek/xxx",
      mode: "manual",
      reason: "user_message",
      usage: { inputTokens: 120, outputTokens: 40 },
    });
    // The message is stored as JSON, so the record survives a restart unchanged.
    const [row] = await db.query<{ route: unknown }>("select meta->'route' as route from messages where id = $1", [agent.id]);
    expect(row!.route).toMatchObject({ accountId: "acct_abc1234567", model: "deepseek/xxx" });
  });

  test("an account id of the wrong shape is refused before it reaches a task row", async () => {
    await expect(postUserMessage(db, wsA, "bad pick", { authorUserId: "usr_local", accountId: "../etc/passwd" })).rejects.toThrow();
    const rows = await db.query<{ n: number }>("select count(*)::int as n from tasks where account_id is not null");
    expect(rows[0]!.n).toBe(0);
  });
});

test("remote hello uses the registered ID across reconnects and revocation interrupts work", async () => {
  const { createDaemonRegistrationCode, registerDaemon } = await import("../src/daemons.js");
  await db.query("insert into users(id, display_name) values ('usr_daemon','Daemon owner')");
  const { code } = await createDaemonRegistrationCode(db, "usr_daemon");
  const { id, credential } = (await registerDaemon(db, code, "Laptop"))!;
  // D-6: a registered daemon only claims tasks of workspaces its owner belongs to.
  await db.query("insert into workspace_members(workspace_id,user_id,role,added_by) values ($1,'usr_daemon','member','usr_local')", [wsA]);
  const remoteServer = http.createServer();
  const remote = attachDaemonSocket(remoteServer, { db, dataDir, events, daemonToken: TOKEN, hubUrl: "http://hub.test", remoteAuth: true });
  await new Promise<void>((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
  const remoteUrl = `ws://127.0.0.1:${(remoteServer.address() as AddressInfo).port}/daemon`;
  try {
    const shared = await connect(TOKEN, undefined, {}, remoteUrl);
    expect((await shared.next("error")).message).toMatch(/invalid daemon credential/i);
    await shared.closed;

    const first = await connect(credential, undefined, {}, remoteUrl);
    await first.next("welcome");
    const { task: queued } = await postUserMessage(db, wsA, "First task", { authorUserId: "usr_local" });
    const task = queued!;
    events.emit(wsA, { type: "task.updated", task: tasks.toUiTask(task, null) });
    expect((await first.next("task.assign")).taskId).toBe(task.id);
    expect((await getTask(db, task.id))?.daemonId).toBe(id);

    const second = await connect(credential, undefined, {}, remoteUrl);
    await second.next("welcome");
    await first.closed;
    const assignment = await second.next("task.assign");
    expect(assignment.taskId).toBe(task.id);
    expect((await getTask(db, task.id))?.daemonId).toBe(id);
    expect(await interruptionsOf(task.id)).toBe(1);
    expect((await db.query("select last_seen_at from daemons where id=$1", [id]))[0]?.last_seen_at).not.toBeNull();

    expect(await remote.revokeRegisteredDaemon(id, "usr_daemon")).toMatchObject({ revokedAt: expect.any(String) });
    expect((await second.next("error")).message).toMatch(/revoked/i);
    await second.closed;
    await vi.waitFor(async () => expect((await getTask(db, task.id))?.status).toBe("queued"));
    expect(await interruptionsOf(task.id)).toBe(2);

    const revoked = await connect(credential, undefined, {}, remoteUrl);
    expect((await revoked.next("error")).message).toMatch(/revoked/i);
    await revoked.closed;
    expect(await db.query("select daemon_id, owner_user_id from daemon_events where kind='rejected' order by created_at")).toEqual([
      { daemon_id: null, owner_user_id: null },
      { daemon_id: id, owner_user_id: "usr_daemon" },
    ]);
  } finally {
    await remote.close();
    await new Promise<void>((resolve) => remoteServer.close(() => resolve()));
  }
});

describe("remote daemon hello", () => {
  let remoteServer: http.Server | undefined;
  let remote: ReturnType<typeof attachDaemonSocket> | undefined;
  let remoteUrl: string;
  let credential: string;

  // Called inside each test so a cold PGlite start counts against the test timeout, not the 10 s hook timeout.
  async function startRemoteHub(publicHubUrl?: string): Promise<NonNullable<typeof remote>> {
    const { createDaemonRegistrationCode, registerDaemon } = await import("../src/daemons.js");
    await db.query("insert into users(id, display_name) values ('usr_daemon','Daemon owner')");
    ({ credential } = (await registerDaemon(db, (await createDaemonRegistrationCode(db, "usr_daemon")).code, "Laptop"))!);
    // D-6: a registered daemon only claims tasks of workspaces its owner belongs to.
    await db.query("insert into workspace_members(workspace_id,user_id,role,added_by) values ($1,'usr_daemon','member','usr_local')", [wsA]);
    const httpServer = http.createServer();
    remoteServer = httpServer;
    // hub.example is the Host these tests' daemons send; since #167 task 15 F-1 the remote upgrade needs it listed.
    remote = attachDaemonSocket(httpServer, { db, dataDir, events, daemonToken: TOKEN, hubUrl: "http://127.0.0.1:4400", remoteAuth: true, allowedHosts: ["hub.example"], ...(publicHubUrl ? { publicHubUrl } : {}) });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    remoteUrl = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}/daemon`;
    return remote;
  }
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await remote?.close();
    const httpServer = remoteServer;
    remote = undefined;
    remoteServer = undefined;
    if (!httpServer) return;
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  async function queueTask() {
    const { task } = await postUserMessage(db, wsA, "Remote task", { authorUserId: "usr_local" });
    events.emit(wsA, { type: "task.updated", task: tasks.toUiTask(task!, null) });
    return task!;
  }

  test("a remote daemon's task.assign carries the address it connected to, not the hub's loopback", async () => {
    await startRemoteHub();
    const daemon = await connect(credential, undefined, {}, remoteUrl, { headers: { host: "hub.example:4400" } });
    await daemon.next("welcome");
    const task = await queueTask();
    const assignment = await daemon.next("task.assign");
    expect(assignment.taskId).toBe(task.id);
    expect(assignment.hubUrl).toBe("http://hub.example:4400");
    expect(new URL(assignment.hubUrl).hostname).not.toMatch(/^(127\.|localhost$|\[::1\]$)/);
  });

  test("a configured public hub URL wins over the upgrade-derived one behind a TLS proxy", async () => {
    await startRemoteHub("https://hub.example.lan");
    const daemon = await connect(credential, undefined, {}, remoteUrl, { headers: { host: "hub.example:4400" } });
    await daemon.next("welcome");
    const task = await queueTask();
    const assignment = await daemon.next("task.assign");
    expect(assignment.taskId).toBe(task.id);
    // Without the override the upgrade would have inferred http://hub.example:4400 here, and the
    // daemon's room/attachment calls would have gone plaintext at a port the proxy never serves.
    expect(assignment.hubUrl).toBe("https://hub.example.lan");
  });

  test("the local daemon keeps the hub's own URL whatever Host it sent", async () => {
    const daemon = await connect(TOKEN, undefined, {}, url, { headers: { host: "hub.example:4400" } });
    await daemon.next("welcome");
    await queueTask();
    expect((await daemon.next("task.assign")).hubUrl).toBe("http://hub.test");
  });

  test("a replaced socket that ignores the close frame is terminated, and the new hello completes promptly", async () => {
    await startRemoteHub();
    const first = await connect(credential, undefined, {}, remoteUrl);
    await first.next("welcome");
    const task = await queueTask();
    expect((await first.next("task.assign")).taskId).toBe(task.id);
    // The old peer stops reading, so it never answers the hub's close frame (ws itself would wait 30 s).
    (first.ws as unknown as { _socket: { pause(): void } })._socket.pause();

    const started = Date.now();
    const second = await connect(credential, undefined, {}, remoteUrl);
    await second.next("welcome");
    expect(Date.now() - started).toBeLessThan(5_000);
    // The old socket's cleanup still ran before the stable ID was reused: the task was interrupted once and comes back.
    expect((await second.next("task.assign")).taskId).toBe(task.id);
    expect(await interruptionsOf(task.id)).toBe(1);
  });

  async function registerSecond(): Promise<{ id: string; credential: string }> {
    const { createDaemonRegistrationCode, registerDaemon } = await import("../src/daemons.js");
    await db.query("insert into users(id, display_name) values ('usr_other','Other owner')");
    return (await registerDaemon(db, (await createDaemonRegistrationCode(db, "usr_other")).code, "Desktop"))!;
  }

  // #167 task 10, spec acceptance ① and ② under the connection table.
  test("two registered daemons coexist; revoking one disconnects only it and requeues only its task", async () => {
    const hub = await startRemoteHub();
    const [firstRow] = await db.query<{ id: string }>("select id from daemons where owner_user_id = 'usr_daemon'");
    const other = await registerSecond();
    // D-6: the second daemon only claims tasks of workspaces its owner belongs to.
    await db.query("insert into workspace_members(workspace_id,user_id,role,added_by) values ($1,'usr_other','member','usr_local')", [wsB]);
    const first = await connect(credential, undefined, {}, remoteUrl);
    await first.next("welcome");
    const a = await queueTask();
    expect((await first.next("task.assign")).taskId).toBe(a.id);

    const second = await connect(other.credential, undefined, {}, remoteUrl);
    await second.next("welcome");
    const { task: b } = await postUserMessage(db, wsB, "Other task", { authorUserId: "usr_local" });
    events.emit(wsB, { type: "task.updated", task: tasks.toUiTask(b!, null) });
    const bAssign = await second.next("task.assign");
    expect(bAssign.taskId).toBe(b!.id);
    // The second hello did not interrupt or requeue the first daemon's task.
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
    expect(await getTask(db, a.id)).toMatchObject({ status: "running", daemonId: firstRow!.id });
    expect(await interruptionsOf(a.id)).toBe(0);
    expect(hub.connectedDaemonIds()).toEqual([firstRow!.id, other.id]);

    expect(await hub.revokeRegisteredDaemon(firstRow!.id, "usr_daemon")).toMatchObject({ revokedAt: expect.any(String) });
    expect((await first.next("error")).message).toMatch(/revoked/i);
    await first.closed;
    await vi.waitFor(async () => expect((await getTask(db, a.id))?.status).toBe("queued"));
    expect(await interruptionsOf(a.id)).toBe(1);
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
    expect(await getTask(db, b!.id)).toMatchObject({ status: "running", runToken: bAssign.runToken, daemonId: other.id });
    expect(await interruptionsOf(b!.id)).toBe(0);
    expect(hub.isConnected()).toBe(true);
    expect(hub.isConnected(firstRow!.id)).toBe(false);
    expect(hub.isConnected(other.id)).toBe(true);
  });

  test("a hub failure during remote hello is logged and not reported as a credential refusal", async () => {
    const hub = await startRemoteHub();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const query = db.query.bind(db);
    const spy = vi.spyOn(db, "query").mockImplementation(((sql: string, params?: unknown[]) => {
      if (sql.startsWith("update daemons set last_seen_at")) return Promise.reject(new Error("database went away"));
      return query(sql, params);
    }) as typeof db.query);
    try {
      const daemon = await connect(credential, undefined, {}, remoteUrl);
      const { message } = await daemon.next("error");
      await daemon.closed;
      expect(message).toBe(REMOTE_HELLO_FAILED_MESSAGE);
      expect(message).not.toMatch(/invalid|revoked|credential|authori[sz]e|register/i);
      expect(log).toHaveBeenCalledWith("[daemon] remote hello failed", expect.objectContaining({ message: "database went away" }));
      expect(hub.isConnected()).toBe(false);
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }
    const retry = await connect(credential, undefined, {}, remoteUrl);
    await retry.next("welcome");
  });
});

describe("/daemon upgrade Host allowlist (#167 task 15 F-1)", () => {
  const opened: Array<{ server: http.Server; handle: ReturnType<typeof attachDaemonSocket> }> = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    for (const { server: s, handle: h } of opened.splice(0)) {
      await h.close();
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  async function hubWith(extra: { remoteAuth?: boolean; allowedHosts?: string[] }): Promise<{ port: number; wsUrl: string }> {
    const s = http.createServer();
    const h = attachDaemonSocket(s, { db, dataDir, events, daemonToken: TOKEN, hubUrl: "http://127.0.0.1:4400", ...extra });
    opened.push({ server: s, handle: h });
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const port = (s.address() as AddressInfo).port;
    return { port, wsUrl: `ws://127.0.0.1:${port}/daemon` };
  }

  /** Opens a raw upgrade with the given Host; resolves "open" or the HTTP status the hub refused with. */
  function upgrade(wsUrl: string, host: string): Promise<"open" | number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { host } });
      sockets.push(ws);
      ws.on("open", () => resolve("open"));
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? -1));
      ws.on("error", reject);
    });
  }

  test("remote form: an off-list Host is refused with 403 and never reaches hello", async () => {
    const { wsUrl } = await hubWith({ remoteAuth: true, allowedHosts: ["hub.example.lan"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await upgrade(wsUrl, "evil.example.com:4400")).toBe(403);
      expect(warn).toHaveBeenCalledWith('daemon upgrade refused: forbidden host "evil.example.com:4400"');
    } finally {
      warn.mockRestore();
    }
    // No hello was processed, so not even a credential rejection was recorded.
    expect(await db.query("select kind from daemon_events")).toEqual([]);
  });

  test("remote form: loopback on the listening port and listed hosts still upgrade", async () => {
    const { port, wsUrl } = await hubWith({ remoteAuth: true, allowedHosts: ["hub.example.lan", "other.example:8443"] });
    expect(await upgrade(wsUrl, `127.0.0.1:${port}`)).toBe("open");
    expect(await upgrade(wsUrl, `localhost:${port}`)).toBe("open");
    expect(await upgrade(wsUrl, "hub.example.lan:4400")).toBe("open");
    expect(await upgrade(wsUrl, "HUB.EXAMPLE.LAN")).toBe("open");
    expect(await upgrade(wsUrl, "other.example:8443")).toBe("open");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A ported entry matches only that port; loopback on another port is not this hub.
      expect(await upgrade(wsUrl, "other.example:4400")).toBe(403);
      expect(await upgrade(wsUrl, `127.0.0.1:${port + 1}`)).toBe(403);
    } finally {
      warn.mockRestore();
    }
  });

  test("remote form without an allowlist: only loopback upgrades", async () => {
    const { port, wsUrl } = await hubWith({ remoteAuth: true });
    expect(await upgrade(wsUrl, `127.0.0.1:${port}`)).toBe("open");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await upgrade(wsUrl, "hub.example.lan:4400")).toBe(403);
    } finally {
      warn.mockRestore();
    }
  });

  test("local form: the upgrade is not Host-checked, even with a filled allowlist (behaviour unchanged)", async () => {
    const { port, wsUrl } = await hubWith({ allowedHosts: ["hub.example.lan"] });
    expect(await upgrade(wsUrl, `127.0.0.1:${port}`)).toBe("open");
    expect(await upgrade(wsUrl, "evil.example.com:4400")).toBe("open");
  });

  test("remote form: an allowed upgrade still needs a valid credential at hello", async () => {
    const { wsUrl } = await hubWith({ remoteAuth: true, allowedHosts: ["hub.example.lan"] });
    const daemon = await connect("not-a-credential", undefined, {}, wsUrl, { headers: { host: "hub.example.lan:4400" } });
    expect((await daemon.next("error")).message).toMatch(/invalid daemon credential/i);
    await daemon.closed;
  });
});

describe("parsePublicHubUrl", () => {
  test("blank stays unset and an origin normalizes", () => {
    expect(parsePublicHubUrl(undefined)).toBeUndefined();
    expect(parsePublicHubUrl("  ")).toBeUndefined();
    expect(parsePublicHubUrl("https://hub.example.lan")).toBe("https://hub.example.lan");
    expect(parsePublicHubUrl("https://hub.example.lan/")).toBe("https://hub.example.lan");
    expect(parsePublicHubUrl("https://hub.example.lan:8443")).toBe("https://hub.example.lan:8443");
  });

  test("anything that is not exactly an http(s) origin throws instead of handing daemons a bad URL", () => {
    for (const bad of ["hub.example.lan", "ftp://hub.example.lan", "https://hub.example.lan/hub", "https://hub.example.lan?x=1", "https://hub.example.lan#frag"]) {
      expect(() => parsePublicHubUrl(bad)).toThrow(/NEMA_HUB_PUBLIC_URL/);
    }
  });
});
