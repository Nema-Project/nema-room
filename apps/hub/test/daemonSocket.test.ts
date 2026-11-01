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
import { claimNextTask, finishTask, getTask, insertQueuedTask, interruptRunning, recordTaskChange, resolveRunToken } from "../src/tasks.js";
import * as tasks from "../src/tasks.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
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
let handle: { isConnected(): boolean };
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

function connect(token = TOKEN, adapters: string[] = ["codex-direct"], hello: Msg = {}, targetUrl = url): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(targetUrl);
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
      client.send({ type: "hello", token, version: "0", adapters, ...hello });
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
    await postUserMessage(db, wsA, "hi");
    const c = await connect(TOKEN, ["codex"]);
    const m = await c.next("error");
    expect(m.message).toBe("nema CLI 版本过旧，请运行 npm run build -w apps/cli 并重启 nema daemon");
    await c.closed;
    expect(handle.isConnected()).toBe(false);
    expect((await listMessages(db, wsA)).some((x) => x.role === "system")).toBe(false);
  });

  test("an edit task quotes the previous text and the reply points back at it", async () => {
    const original = await postUserMessage(db, wsA, "original");
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await addMessage(db, wsA, "agent", "which one", {
      meta: { changes: [], askedQuestion: { id: "Q-1", title: "进度", body: "到哪了" } },
    });
    await new KnowledgeStore(repoPath(dataDir, wsA)).upsert(
      { kind: "requirement", title: "进度说明", body: "b", reason: "r", basis: "stated", sourceMessages: [original.message.id] } as never,
      { author: "agent" },
    );
    await postUserMessage(db, wsA, "later note");
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await editUserMessage(db, wsA, original.message.id, "middle");
    const c = await connect();
    const failed = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: failed.taskId, ok: false, error: "boom" });
    await vi.waitFor(async () => {
      const system = (await listMessages(db, wsA)).find((m) => m.role === "system");
      expect(system?.content).toContain("boom");
      expect(system?.meta).toBeNull();
    });
    const second = await editUserMessage(db, wsA, original.message.id, "latest");
    events.emit(wsA, { type: "task.updated", task: { id: second.task.id, workspaceId: wsA, messageId: original.message.id, status: "queued", error: null } });
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
    const target = await postUserMessage(db, wsA, "first wording");
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await editUserMessage(db, wsA, target.message.id, "rewritten wording");
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await postUserMessage(db, wsA, "I meant the architecture", target.message.id);
    const c = await connect();
    const assigned = await c.next("task.assign");
    expect(assigned.prompt).toContain("# 本次消息引用的消息");
    expect(assigned.prompt).toContain("rewritten wording");
    expect(assigned.prompt).not.toContain("first wording");
  });

  test("assign carries confidential from the workspace setting", async () => {
    await updateWorkspace(db, wsA, { confidential: false });
    await updateWorkspace(db, wsB, { confidential: true });
    await postUserMessage(db, wsA, "open");
    await postUserMessage(db, wsB, "secret");
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a).toMatchObject({ workspaceId: wsA, adapter: "auto", confidential: false });
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "r" });
    const b = await c.next("task.assign");
    expect(b).toMatchObject({ workspaceId: wsB, adapter: "auto", confidential: true });
  });

  test("a thread's activated Skills ride on its tasks, newest first; main chat and record-less threads carry none", async () => {
    await postUserMessage(db, wsA, "main chat");
    const anchor = (await postUserMessage(db, wsA, "anchor")).message;
    const thread = await ensureThread(db, anchor.id, "T", "user");
    await db.query(
      `insert into thread_skill_activations(thread_id, skill_id, last_activated_at, last_task_id, revision)
       values ($1, 'tdd', now() - interval '1 hour', 't0', 'r'), ($1, 'pdf', now(), 't0', 'r')`,
      [thread.id],
    );
    await postUserMessage(db, wsA, "in thread", { threadId: thread.id });
    const other = (await postUserMessage(db, wsB, "other anchor")).message;
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
    await postUserMessage(db, wsA, "a");
    await postUserMessage(db, wsB, "b");
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a.projectSkills).toEqual([{ repoId: "repo_t", label: "web", path: "/src/web", mainBranch: "main", gitCommonDir: "/src/web/.git" }]);
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "r" });
    const b = await c.next("task.assign");
    expect(b).not.toHaveProperty("projectSkills");
  });

  test("a leading /skill-name rides on its task as manualSkill; built-ins, mid-text names and others carry none", async () => {
    await postUserMessage(db, wsA, "/tdd 写测试\n第二行");
    await postUserMessage(db, wsA, "/thread x");
    await postUserMessage(db, wsA, "请用 /tdd");
    await postUserMessage(db, wsA, "/skill:thread 开");
    await postUserMessage(db, wsA, "plain");
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
    const m = await postUserMessage(db, wsA, "/tdd first");
    await finishTask(db, (await claimNextTask(db, "d1"))!.id, { ok: true });
    await editUserMessage(db, wsA, m.message.id, "/review again");
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a.manualSkill).toEqual({ skillId: "review", arguments: "again" });
  });

  test("a reply carries the skills its task offered, and the offers are cleared once it is saved", async () => {
    const m = await postUserMessage(db, wsA, "install the pdf skill");
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
    const m = await postUserMessage(db, wsA, "hello");
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
    const m1 = await postUserMessage(db, wsA, "first");
    const m2 = await postUserMessage(db, wsA, "second");
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
    const progress: string[] = [];
    events.subscribe(wsA, (e) => e.type === "task.progress" && progress.push(e.text));
    c.send({ type: "task.event", taskId: m1.task.id, event: { type: "progress", text: "working" } });
    c.send({ type: "task.finished", taskId: m1.task.id, ok: true, reply: "done 1" });
    const a2 = await c.next("task.assign");
    expect(a2.taskId).toBe(m2.task.id);
    expect(progress).toEqual(["working"]);
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
    const m1 = await postUserMessage(db, wsA, "where is the doc");
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
    const answer = await postUserMessage(db, wsA, "Here is the answer", { threadId: threadId! });
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
    const m = await postUserMessage(db, wsA, "unclear request");
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
      const message = await postUserMessage(db, wsA, `update ${status}`);
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
    const m = await postUserMessage(db, wsA, "several questions");
    const q1 = await addQuestion(wsA, 1);
    const q2 = await addQuestion(wsA, 2);
    const oldAnchor = await postUserMessage(db, wsA, "old topic");
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
    const m = await postUserMessage(db, wsA, "ordinary");
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "ordinary reply" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    const agent = (await listMessages(db, wsA)).find((x): x is AgentMessage => x.role === "agent")!;
    expect(agent).toMatchObject({ content: "ordinary reply", threadId: null });
    expect(agent.meta?.askedQuestion).toBeNull();
  });

  test("reply goes to the thread when the task message is in a thread", async () => {
    const anchor = await postUserMessage(db, wsA, "anchor");
    await ensureThread(db, anchor.message.id, "Thread", "user");
    await db.query("update tasks set status='done' where id=$1", [anchor.task.id]);
    const m = await postUserMessage(db, wsA, "thread follow-up", { threadId: anchor.message.id });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "thread reply" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    expect((await listThreadMessages(db, anchor.message.id)).some((x) => x.content === "thread reply")).toBe(true);
    expect((await listMessages(db, wsA)).some((x) => x.content === "thread reply")).toBe(false);
  });

  test("a thread opened during the task receives its reply, with no main-chat agent message", async () => {
    const m = await postUserMessage(db, wsA, "open while running");
    const c = await connect();
    const a = await c.next("task.assign");
    await ensureThread(db, m.message.id, "Opened by tool", "agent");
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "in the opened thread" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    expect((await listThreadMessages(db, m.message.id)).some((x) => x.content === "in the opened thread")).toBe(true);
    expect((await listMessages(db, wsA)).some((x) => x.content === "in the opened thread")).toBe(false);
  });

  test("failure message stays in a thread", async () => {
    const m = await postUserMessage(db, wsA, "fail here");
    await ensureThread(db, m.message.id, "Failure", "agent");
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: false, error: "boom" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("failed"));
    expect(await listThreadMessages(db, m.message.id)).toContainEqual(expect.objectContaining({ role: "system", threadId: m.message.id, content: "处理失败：boom" }));
  });

  test("daemon failure opens a grill thread for a touched open question", async () => {
    const m = await postUserMessage(db, wsA, "fails after asking");
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
    const m = await postUserMessage(db, wsA, "first attempt asks");
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
    const m = await postUserMessage(db, wsA, "thread failure asks");
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
    const m = await postUserMessage(db, wsA, "interrupted");
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
    const m = await postUserMessage(db, wsA, "atomic reply");
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
    const anchor = await postUserMessage(db, wsA, "original");
    await ensureThread(db, anchor.message.id, "Anchor", "agent");
    await db.query("update tasks set status='done' where id=$1", [anchor.task.id]);
    const edited = await editUserMessage(db, wsA, anchor.message.id, "corrected");
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
    const m = await postUserMessage(db, wsA, "no grill");
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
    const m1 = await postUserMessage(db, wsA, "first");
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
    const m = await postUserMessage(db, wsA, "survive restart");
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
    const m = await postUserMessage(db, wsA, "orphan");
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
    const a = await postUserMessage(db, wsA, "a");
    const b = await postUserMessage(db, wsB, "b");
    const c = await connect();
    const first = await c.next("task.assign");
    expect(first.taskId).toBe(a.task.id);
    await noMessage(c);
    c.send({ type: "task.finished", taskId: a.task.id, ok: true, reply: "x" });
    expect((await c.next("task.assign")).taskId).toBe(b.task.id);
  });

  test("ignores task.finished for a task not assigned to the connection", async () => {
    const a = await postUserMessage(db, wsA, "a");
    const b = await postUserMessage(db, wsB, "b");
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
    const first = await postUserMessage(db, wsA, "hello");
    await addMessage(db, wsA, "agent", "reply", {
      taskId: first.task.id,
      meta: { changes: [], askedQuestion: { id: q.id, title: q.title, body: q.body } },
    });
    await postUserMessage(db, wsA, "postgres");
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
    const u0 = await postUserMessage(db, wsA, "zero");
    await addMessage(db, wsA, "agent", "OLDER-REPLY", { taskId: u0.task.id, meta: { changes: [], askedQuestion: { id: q1.id, title: q1.title, body: q1.body } } });
    const u1 = await postUserMessage(db, wsA, "current-msg");
    await addMessage(db, wsA, "agent", "NEWER-REPLY", { taskId: u0.task.id, meta: { changes: [], askedQuestion: { id: q2.id, title: q2.title, body: q2.body } } });
    await postUserMessage(db, wsA, "LATER-USER");
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
    const u0 = await postUserMessage(db, wsA, "zero");
    await addMessage(db, wsA, "agent", "asked-q2", { taskId: u0.task.id, meta: { changes: [], askedQuestion: { id: q2.id, title: q2.title, body: q2.body } } });
    await db.query("update tasks set status = 'done' where id = $1", [u0.task.id]);
    const u1 = await postUserMessage(db, wsA, `回答 ${q1.id}：\n里程碑二`);
    const c = await connect();
    const a = await c.next("task.assign");
    expect(a.taskId).toBe(u1.task.id);
    expect(a.prompt).toContain("要回答的追问");
    expect(a.prompt).toContain(`${q1.id}：`);
    expect(a.prompt).not.toContain("上一个追问");
    expect(a.prompt.split("# 要回答的追问")[1]!.split("# 最近消息")[0]).not.toContain(`${q2.id}：`);
  });

  test("prompt build failure: system message once, task failed, no stuck running", async () => {
    const a = await postUserMessage(db, wsA, "a");
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
    const a = await postUserMessage(db, wsA, "a");
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
    const a = await postUserMessage(db, wsA, "a");
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

  test("second daemon replaces the first", async () => {
    const a = await postUserMessage(db, wsA, "a");
    const c1 = await connect();
    await c1.next("task.assign");
    const c2 = await connect();
    await c1.closed;
    const a2 = await c2.next("task.assign");
    expect(a2.taskId).toBe(a.task.id);
    expect(handle.isConnected()).toBe(true);
  });

  test("failure: system message, task failed, next dispatched", async () => {
    const a = await postUserMessage(db, wsA, "a");
    const b = await postUserMessage(db, wsB, "b");
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
    const posted = await postUserMessage(db, wsA, "race");
    let c2: Client | null = null;
    let firstToken: string | null = null;
    const realClaim = tasks.claimNextTask;
    const claimSpy = vi.spyOn(tasks, "claimNextTask").mockImplementation(async (database, daemonId) => {
      if (c2 === null) {
        // Hello waits on this dispatchOnce, so only wait until it has closed c1, then claim.
        c2 = await connect();
        await c1.closed;
      }
      const task = await realClaim(database, daemonId);
      if (firstToken === null && task?.runToken) firstToken = task.runToken;
      return task;
    });
    try {
      events.emit(wsA, { type: "task.updated", task: posted.task });
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

  test("a second hello during prompt build does not spend a retry", async () => {
    const c1 = await connect();
    await c1.next("welcome");
    const posted = await postUserMessage(db, wsA, "unsent");
    const gate = pausePromptBuild();
    events.emit(wsA, { type: "task.updated", task: posted.task });
    await gate.entered;
    expect((await getTask(db, posted.task.id))?.status).toBe("running");
    const c2 = await connect();
    await c1.closed;
    gate.release();
    const assign = await c2.next("task.assign");
    expect(assign.taskId).toBe(posted.task.id);
    expect(await interruptionsOf(posted.task.id)).toBe(0);
    expect((await listMessages(db, wsA)).some((m) => m.role === "system")).toBe(false);
  });

  test("a disconnect during prompt build does not spend a retry", async () => {
    const c1 = await connect();
    await c1.next("welcome");
    const posted = await postUserMessage(db, wsA, "unsent");
    const gate = pausePromptBuild();
    events.emit(wsA, { type: "task.updated", task: posted.task });
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
      taskId = (await postUserMessage(db, wsA, "thread member", { threadId: thread.id })).task.id;
    } else if (scenario === "anchor whose thread was opened after submission") {
      const anchor = await postUserMessage(db, wsA, "main anchor");
      taskId = anchor.task.id;
      threadId = (await ensureThread(db, anchor.message.id, "Opened before interruption", "user")).id;
    } else {
      const anchor = await postUserMessage(db, wsA, "main task");
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

  test("new task enqueued later is dispatched via task.updated", async () => {
    const c = await connect();
    await c.next("welcome");
    const a = await postUserMessage(db, wsA, "late");
    events.emit(wsA, { type: "task.updated", task: a.task });
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
    await postUserMessage(db, wsB, "plain");
    events.emit(wsB, { type: "task.updated", task: { id: "x", workspaceId: wsB, messageId: "x", status: "queued", error: null } });
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
    const earlier = await postUserMessage(db, wsA, "看这张", { attachmentIds: [file.id] });
    await db.query("update tasks set status = 'done' where id = $1", [earlier.task.id]);

    const content = `按 [${entry.id}] 来，再看 \`附件：截图.png\``;
    const m = await postUserMessage(db, wsA, content, {
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
    const m = await postUserMessage(db, wsA, "普通消息");
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
    const quoted = await postUserMessage(db, wsA, "old", { attachmentIds: [quotedFile.id] });
    await db.query("update tasks set status = 'done' where id = $1", [quoted.task.id]);
    const file = await uploadPng(db, dataDir, wsA, png(64), "new.png");
    const m = await postUserMessage(db, wsA, "", { attachmentIds: [file.id], quoteMessageId: quoted.message.id });
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
    const withFile = await postUserMessage(db, wsA, "see file", { attachmentIds: [file.id] });
    const textOnly = await postUserMessage(db, wsA, "just text");
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
    await postUserMessage(db, wsA, "plain");
    const c = await connect(TOKEN, ["codex-direct"], { features: ["attachments"] });
    expect((await c.next()).type).toBe("welcome");
    const a = await c.next("task.assign");
    expect("attachments" in a).toBe(false);
  });
});

describe("account choice and route decision", () => {
  test("a message that named an account sends that id down; one that named none sends no field", async () => {
    const picked = await postUserMessage(db, wsA, "on the second account", { accountId: "acct_abc1234567" });
    const plain = await postUserMessage(db, wsA, "on whatever the default is");
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

  test("a task that allows automatic routing says so", async () => {
    const m = await postUserMessage(db, wsA, "auto please");
    await db.query("update tasks set routing = 'auto' where id = $1", [m.task.id]);
    const c = await connect();
    const a1 = await c.next("task.assign");
    expect(a1).toMatchObject({ taskId: m.task.id, routing: "auto" });
  });

  test("a thread task carries its thread id; a main-chat task carries none", async () => {
    const mainChat = await postUserMessage(db, wsB, "plain main chat");
    const anchor = await postUserMessage(db, wsA, "anchor");
    await ensureThread(db, anchor.message.id, "A thread", "user");
    const inThread = await postUserMessage(db, wsA, "reply in the thread", { threadId: anchor.message.id });
    const c = await connect();
    const seen = new Map<string, Msg>();
    // Dispatch is one task at a time and the anchor now sits in its own thread, so walk the queue until the
    // thread reply arrives instead of assuming an order across workspaces.
    for (let i = 0; i < 4 && !seen.has(inThread.task.id); i++) {
      const a = await c.next("task.assign");
      seen.set(a.taskId, a);
      c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "ok" });
    }
    // A main-chat message belongs to no thread, so nothing is claimed about one.
    expect(seen.get(mainChat.task.id)).toBeDefined();
    expect(seen.get(mainChat.task.id)).not.toHaveProperty("threadId");
    expect(seen.get(inThread.task.id)).toMatchObject({ threadId: anchor.message.id });
  });

  test("the route the daemon reports is stored on the agent message", async () => {
    const m = await postUserMessage(db, wsA, "who answered this");
    const c = await connect();
    const a = await c.next("task.assign");
    const route = { accountId: "acct_abc1234567", accountName: "Personal", model: "gpt-5.5", mode: "manual", reason: "user_workspace" };
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "me", route });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    const agent = (await listMessages(db, wsA)).find((x): x is AgentMessage => x.role === "agent")!;
    expect(agent.meta?.route).toEqual(route);
  });

  test("an old daemon that sends no route still saves its reply", async () => {
    const m = await postUserMessage(db, wsA, "old daemon");
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: true, reply: "still here" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("done"));
    const agent = (await listMessages(db, wsA)).find((x): x is AgentMessage => x.role === "agent")!;
    expect(agent.content).toBe("still here");
    expect(agent.meta?.route).toBeUndefined();
  });

  test("a failure keeps the account out of the message but not out of the record", async () => {
    // A failed task has no reply, so no route line; the account that failed is named by the daemon in the
    // error text, which is what `saveTaskFailure` stores.
    const m = await postUserMessage(db, wsA, "will fail", { accountId: "acct_abc1234567" });
    const c = await connect();
    const a = await c.next("task.assign");
    c.send({ type: "task.finished", taskId: a.taskId, ok: false, error: "账户「Personal」还没有凭据，请在设置页填写后再运行。" });
    await vi.waitFor(async () => expect((await getTask(db, m.task.id))?.status).toBe("failed"));
    const system = (await listMessages(db, wsA)).find((x) => x.role === "system")!;
    expect(system.content).toContain("Personal");
    expect(system.meta).toBeNull();
  });
});

describe("S3 acceptance: the account shown under the reply", () => {
  test("the metadata a real daemon sends renders as one line: account, model, reason", async () => {
    // The shape the daemon puts on `task.finished` after routing (see apps/cli/src/routing/index.ts):
    // the hub stores it verbatim under `meta.route`, which is what the reply line reads.
    const m = await postUserMessage(db, wsA, "who is this", { accountId: "acct_abc1234567" });
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
    await expect(postUserMessage(db, wsA, "bad pick", { accountId: "../etc/passwd" })).rejects.toThrow();
    const rows = await db.query<{ n: number }>("select count(*)::int as n from tasks where account_id is not null");
    expect(rows[0]!.n).toBe(0);
  });
});
