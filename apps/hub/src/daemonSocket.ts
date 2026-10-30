import type http from "node:http";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import { KnowledgeStore } from "@nema/knowledge";
import { AttachmentRefSchema, WORKPACKAGE_LIMITS, parseDaemonToHub, type AgentMessageMeta, type AttachmentRef, type Entry, type HubToDaemon, type PluginToolSpec, type UserMessageMeta } from "@nema/shared";
import { createConnectionRpc, DaemonRpcError, type ConnectionRpc, type DaemonRpc } from "./daemonRpc.js";
import type { Db } from "./db/db.js";
import type { EventBus } from "./events.js";
import { chooseAskedQuestion, timeline } from "./entryIndex.js";
import { addMessage, deliverySet, getLastAskedQuestion, getMessage, listMessageVersions, listPromptMessages, listRecentMessages, messageExcerpt, type Message } from "./messages.js";
import { associateQuestion, conversationOf, ensureThread, getThread } from "./threads.js";
import { retainedSkills } from "./skillActivations.js";
import { announceInterrupted } from "./interrupts.js";
import { enabledPluginTools, grillState } from "./plugins.js";
import { recheckReports, registerReportToken } from "./reports.js";
import { buildPrompt, namedAnswerId, type WorkPackagePromptInput } from "./prompt.js";
import { onRepoMoved } from "./diagrams.js";
import { workPackageIdOf, workPackageRules } from "./workpackages.js";
import { applyRepoFetched, applyRepoMoved, listRepos, syncBoundRepos } from "./repos.js";
import { claimNextTask, finishTask, getTask, interruptRunning, listTaskChanges, requeueDaemonTasks, toUiTask, type Task } from "./tasks.js";
import { getWorkspace, listWorkspaces, repoPath } from "./workspaces.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { versionSkewMessage } from "./hubVersion.js";
import { clearSkillOffers, listSkillOffers } from "./skillOffers.js";

export type DaemonSocketDeps = { db: Db; dataDir: string; events: EventBus; daemonToken: string; hubUrl: string; ownedHelpers?: OwnedHelperScope; releaseVersion?: string };

type Conn = {
  ws: WebSocket;
  daemonId: string;
  assigned: { taskId: string; workspaceId: string; runToken: string } | null;
  rpc: ConnectionRpc;
  /** hello.features; "attachments" means the daemon fetches task.assign.attachments. */
  features: ReadonlySet<string>;
};

type TaskReplyRouting = {
  task: Task;
  taskMessage: Message;
  changes: AgentMessageMeta["changes"];
  touched: Entry[];
  askedQuestion: Entry | null;
  replyThread: string | null;
  createThread: boolean;
};

export const NO_ATTACHMENT_SUPPORT_MESSAGE = "当前 daemon 不支持附件，请升级 CLI";

export const OLD_CLI_MESSAGE = "nema CLI 版本过旧，请运行 npm run build -w apps/cli 并重启 nema daemon";

export function attachDaemonSocket(server: http.Server, deps: DaemonSocketDeps): { isConnected(): boolean; rpc: DaemonRpc; close(): Promise<void> } {
  const { db, dataDir, events } = deps;
  const wss = new WebSocketServer({ server, path: "/daemon" });
  let current: Conn | null = null;
  const connections = new Set<Conn>();
  let chain: Promise<void> = Promise.resolve();
  let moves: Promise<void> = Promise.resolve();
  let stopping = false;
  const pending = new Set<Promise<void>>();
  const track = (promise: Promise<void>): void => {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
  };

  const send = (ws: WebSocket, m: HubToDaemon) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  };
  const emitTask = async (taskId: string) => {
    const t = await getTask(db, taskId);
    if (t) events.emit(t.workspaceId, { type: "task.updated", task: toUiTask(t) });
  };

  async function taskReplyRouting(taskId: string): Promise<TaskReplyRouting | null> {
    const task = await getTask(db, taskId);
    if (!task) return null;
    const taskMessage = await getMessage(db, task.messageId);
    if (!taskMessage) return null;
    const changes = (await listTaskChanges(db, taskId)) as AgentMessageMeta["changes"];
    const store = new KnowledgeStore(repoPath(dataDir, task.workspaceId), deps.ownedHelpers);
    const touched = (await Promise.all(
      [...new Set(changes.filter((change) => change.kind === "question").map((change) => change.entryId))]
        .map((id) => store.get(id)),
    )).filter((entry): entry is Entry => entry !== null);
    const grillOn = (await grillState(db, task.workspaceId)).enabled;
    const askedQuestion = grillOn ? chooseAskedQuestion(touched, null) : null;
    const existingThread = await conversationOf(db, taskMessage);
    const createThread = !existingThread && grillOn && askedQuestion !== null;
    return {
      task,
      taskMessage,
      changes,
      touched,
      askedQuestion,
      replyThread: existingThread ?? (createThread ? taskMessage.id : null),
      createThread,
    };
  }

  async function saveTaskOutcome(
    routing: TaskReplyRouting,
    expectedRunToken: string,
    result: { ok: true } | { ok: false; error: string },
    role: "agent" | "system",
    content: string,
    meta?: AgentMessageMeta,
  ): Promise<Message | null> {
    return db.tx(async (t) => {
      if (!(await finishTask(t, routing.task.id, result, expectedRunToken))) return null;
      // Read under the task row lock finishTask now holds: an offer still being written either
      // committed first and is read here, or waits and then sees the task finished and is refused.
      // A failed task's offers are not shown at all.
      const offers = await listSkillOffers(t, routing.task.id);
      if (meta && offers.length > 0) meta = { ...meta, skillOffers: offers };
      await clearSkillOffers(t, routing.task.id);
      if (routing.createThread && routing.askedQuestion) {
        await ensureThread(t, routing.taskMessage.id, routing.askedQuestion.title, "grill");
      }
      const message = await addMessage(t, routing.task.workspaceId, role, content, {
        taskId: routing.task.id,
        ...(meta ? { meta } : {}),
        threadId: routing.replyThread,
      });
      if (routing.replyThread) {
        for (const entry of routing.touched) {
          if (entry.kind === "question" && entry.status === "open") {
            await associateQuestion(t, routing.task.workspaceId, entry.id, routing.replyThread);
          }
        }
      }
      return message;
    });
  }

  /** Requeues a daemon's running tasks and announces each so UIs see them as queued again. */
  async function requeueAndEmit(daemonId: string): Promise<void> {
    const ids = (await db.query<{ id: string }>(`select id from tasks where daemon_id = $1 and status = 'running'`, [daemonId])).map((r) => r.id);
    await requeueDaemonTasks(db, daemonId);
    for (const id of ids) await emitTask(id);
  }

  async function buildTaskPrompt(task: Task): Promise<{ prompt: string; confidential: boolean; attachments: AttachmentRef[]; retainedSkills: string[] }> {
    const workspace = await getWorkspace(db, task.workspaceId);
    if (!workspace) throw new Error("workspace not found");
    const userMessage = await getMessage(db, task.messageId);
    if (!userMessage) throw new Error("task message not found");
    const editing = task.kind === "edit";
    const conversationId = await conversationOf(db, userMessage);
    const contextLimit = conversationId ? 50 : 20;
    const before = editing
      ? await listRecentMessages(db, task.workspaceId, userMessage.id, contextLimit)
      : await listPromptMessages(db, task.workspaceId, userMessage.id, contextLimit);
    // A system-started task, a report, or an edit re-run is not the user's answer to the last follow-up question.
    // A message that names `回答 Q-n：` answers that question even when a newer follow-up exists.
    const named = !editing && userMessage.role === "user" ? namedAnswerId(userMessage.content) : null;
    const asked = named
      ? { id: named }
      : editing || userMessage.role === "system" || userMessage.role === "report"
        ? undefined
        : await getLastAskedQuestion(db, task.workspaceId, conversationId);
    const store = new KnowledgeStore(repoPath(dataDir, task.workspaceId), deps.ownedHelpers);
    const lastAskedQuestion = asked ? await store.get(asked.id) : null;
    let workpackage: WorkPackagePromptInput | undefined;
    if (task.kind === "workpackage") {
      const id = workPackageIdOf(userMessage.content);
      const wp = id ? await store.get(id) : null;
      if (!wp?.workpackage) throw new Error(`找不到开发包 ${id ?? "（未知）"}`);
      const repos = await listRepos(db, task.workspaceId);
      workpackage = {
        id: wp.id,
        requirements: wp.workpackage.requirements,
        repos: repos.map((r) => ({ id: r.id, label: r.label })),
        rules: workPackageRules(),
      };
    }
    const edit = editing
      ? {
          previousContent: (await listMessageVersions(db, userMessage.id)).at(-1)?.content ?? "",
          cited: await store.entriesCiting(userMessage.id),
        }
      : null;
    const quoteId = userMessage.role === "user" ? (userMessage.meta as UserMessageMeta | null)?.quote?.messageId : undefined;
    const quotedMessage = quoteId ? await getMessage(db, quoteId) : null;
    const conversationThread = conversationId ? await getThread(db, conversationId) : null;
    const conversationAnchor = conversationId ? await getMessage(db, conversationId) : null;
    // Every ref is checked against AttachmentRefSchema here as well as when it was read.
    const attachments = AttachmentRefSchema.array().parse(await deliverySet(db, task.id));
    const prompt = await buildPrompt({
      workspace,
      userMessage,
      recentMessages: before,
      entries: await timeline(db, dataDir, task.workspaceId, deps.ownedHelpers),
      lastAskedQuestion,
      priorChanges: await listTaskChanges(db, task.id),
      grill: await grillState(db, task.workspaceId),
      ...(workpackage ? { workpackage } : {}),
      ...(quotedMessage ? { quotedMessage } : {}),
      ...(edit ? { edit } : {}),
      ...(conversationThread && conversationAnchor ? { conversation: { thread: conversationThread, anchor: conversationAnchor, opened: conversationThread.openedBy } } : {}),
      deliveredAttachmentIds: attachments.map((a) => a.id),
    });
    // A thread's activated Skills come back on its next task; ids only, the daemon reads them again.
    const retained = conversationId ? await retainedSkills(db, conversationId) : [];
    return { prompt, confidential: workspace.confidential, attachments, retainedSkills: retained };
  }

  async function saveTaskFailure(taskId: string, error: string, expectedRunToken?: string): Promise<Message | null> {
    const routing = await taskReplyRouting(taskId);
    if (!routing) return null;
    const runToken = expectedRunToken ?? routing.task.runToken;
    if (!runToken) return null;
    return saveTaskOutcome(routing, runToken, { ok: false, error }, "system", "处理失败：" + error);
  }

  async function dispatchOnce(): Promise<void> {
    for (;;) {
      if (stopping) return;
      const conn = current;
      if (!conn || conn.assigned) return;
      const task = await claimNextTask(db, conn.daemonId);
      if (stopping) return;
      if (!task) return;
      if (current !== conn) {
        await requeueAndEmit(conn.daemonId);
        return;
      }
      let built: { prompt: string; confidential: boolean; attachments: AttachmentRef[]; retainedSkills: string[] };
      let pluginTools: PluginToolSpec[] = [];
      try {
        built = await buildTaskPrompt(task);
        // An older daemon would drop the field and answer from the text alone; fail the task instead.
        if (built.attachments.length > 0 && !conn.features.has("attachments")) throw new Error(NO_ATTACHMENT_SUPPORT_MESSAGE);
        pluginTools = await enabledPluginTools(db, task.workspaceId);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        try {
          const msg = task.runToken ? await saveTaskFailure(task.id, error, task.runToken) : null;
          if (msg) {
            events.emit(task.workspaceId, { type: "message.created", message: msg });
            if (msg.threadId) {
              const thread = await getThread(db, msg.threadId);
              if (thread) events.emit(task.workspaceId, { type: "thread.updated", thread });
            }
            await emitTask(task.id);
          }
        } catch (e2) {
          console.error("[daemon] failed to record prompt failure", e2);
          await requeueAndEmit(conn.daemonId).catch(() => {});
          return;
        }
        continue;
      }
      if (stopping) return;
      if (current !== conn || conn.ws.readyState !== conn.ws.OPEN) {
        await requeueAndEmit(conn.daemonId);
        return;
      }
      conn.assigned = { taskId: task.id, workspaceId: task.workspaceId, runToken: task.runToken! };
      send(conn.ws, {
        type: "task.assign",
        taskId: task.id,
        workspaceId: task.workspaceId,
        adapter: "auto",
        confidential: built.confidential,
        prompt: built.prompt,
        runToken: task.runToken!,
        hubUrl: deps.hubUrl,
        pluginTools,
        ...(task.kind === "workpackage" ? { limits: { ...WORKPACKAGE_LIMITS } } : {}),
        ...(built.attachments.length > 0 ? { attachments: built.attachments } : {}),
        ...(built.retainedSkills.length > 0 ? { retainedSkills: built.retainedSkills } : {}),
      });
      await emitTask(task.id);
      return;
    }
  }

  // Dispatches are serialized so concurrent triggers never double-claim.
  const dispatch = (): Promise<void> => {
    chain = chain.then(dispatchOnce).catch((e) => console.error("[daemon] dispatch failed", e));
    track(chain);
    return chain;
  };

  async function onFinished(conn: Conn, m: Extract<ReturnType<typeof parseDaemonToHub>, { type: "task.finished" }>) {
    const a = conn.assigned;
    if (!a || a.taskId !== m.taskId) return;
    let msg: Message | null;
    if (m.ok) {
      const routing = await taskReplyRouting(m.taskId);
      if (!routing) {
        conn.assigned = null;
        return;
      }
      const meta: AgentMessageMeta = {
        changes: routing.changes,
        askedQuestion: routing.askedQuestion ? { id: routing.askedQuestion.id, title: routing.askedQuestion.title, body: routing.askedQuestion.body } : null,
      };
      if (routing.task.kind === "edit") {
        const edited = await getMessage(db, routing.task.messageId);
        if (edited) meta.quote = { messageId: edited.id, role: edited.role, excerpt: messageExcerpt(edited.content) };
      }
      msg = await saveTaskOutcome(routing, a.runToken, { ok: true }, "agent", m.reply, meta);
    } else {
      msg = await saveTaskFailure(m.taskId, m.error, a.runToken);
    }
    if (!msg) {
      conn.assigned = null;
      return;
    }
    conn.assigned = null;
    events.emit(a.workspaceId, { type: "message.created", message: msg });
    if (msg.threadId) {
      const thread = await getThread(db, msg.threadId);
      if (thread) events.emit(a.workspaceId, { type: "thread.updated", thread });
    }
    await emitTask(m.taskId);
    await dispatch();
  }

  wss.on("connection", (ws) => {
    let conn: Conn | null = null;
    // Per-connection serial handling keeps hello/finished ordering intact.
    let inbox: Promise<void> = Promise.resolve();

    const handle = async (raw: string) => {
      if (stopping) return;
      let m;
      try {
        m = parseDaemonToHub(JSON.parse(raw));
      } catch {
        return;
      }
      if (!conn) {
        if (m.type !== "hello") return;
        if (m.token !== deps.daemonToken) {
          send(ws, { type: "error", message: "daemon token 无效" });
          ws.close();
          return;
        }
        if (deps.releaseVersion && m.version !== deps.releaseVersion) {
          send(ws, { type: "error", message: versionSkewMessage(deps.releaseVersion) });
          ws.close();
          return;
        }
        // An old CLI (adapter "codex" only) silently drops the new `adapter:"auto"` assignments, which would
        // leave the task running forever: refuse it up front so tasks stay queued.
        if (!m.adapters.some((a) => a === "codex-direct" || a === "codex-cli")) {
          send(ws, { type: "error", message: OLD_CLI_MESSAGE });
          ws.close();
          return;
        }
        if (m.reportTokenHash) await registerReportToken(db, m.reportTokenHash);
        if (stopping) return;
        const old = current;
        conn = {
          ws,
          daemonId: `d_${nanoid(10)}`,
          assigned: null,
          features: new Set(m.features ?? []),
          rpc: createConnectionRpc((id, method, params) => send(ws, { type: "rpc.request", id, method, params })),
        };
        connections.add(conn);
        current = conn;
        // Leave old.assigned for the close handler. An in-flight dispatchOnce may have claimed a
        // task it has not sent; wait until that claim is requeued uncounted before a counted interrupt.
        const pendingDispatch = chain;
        if (old) old.ws.close();
        await pendingDispatch;
        if (stopping) {
          conn.rpc.failAll("hub shutting down");
          connections.delete(conn);
          if (current === conn) current = null;
          return;
        }
        await announceInterrupted(db, events, await interruptRunning(db, { exceptDaemonId: conn.daemonId }));
        if (stopping) {
          conn.rpc.failAll("hub shutting down");
          connections.delete(conn);
          if (current === conn) current = null;
          return;
        }
        // The id list lets the daemon drop isolation dirs of workspaces deleted while it was away.
        send(ws, { type: "welcome", workspaceIds: (await listWorkspaces(db)).map((w) => w.id) });
        track(syncBoundRepos(db, conn.rpc).catch((error) => { if (!stopping) console.error("[daemon] repos.sync failed", error); }));
        events.emitGlobal({ type: "daemon.status", connected: true });
        await dispatch();
        return;
      }
      if (m.type === "task.event") {
        if (conn.assigned?.taskId !== m.taskId) return;
        events.emit(conn.assigned.workspaceId, { type: "task.progress", taskId: m.taskId, text: m.event.text });
      } else if (m.type === "task.finished") {
        await onFinished(conn, m);
      } else if (m.type === "rpc.response") {
        conn.rpc.onResponse(m);
      } else if (m.type === "repo.moved") {
        if (await applyRepoMoved(db, events, m)) {
          // Not awaited here: it waits on daemon RPC replies, which arrive through this same inbox.
          // Moves are chained so two quick moves of one repo settle in order.
          const move = { repoId: m.repoId, to: m.to };
          moves = moves
            .then(() => onRepoMoved(db, dataDir, rpc, events, move, deps.ownedHelpers))
            .catch((e) => { if (!stopping) console.error("[daemon] diagram staleness check failed", e); })
            .then(() => recheckReports({ db, events, daemon: rpc, dataDir, ownedHelpers: deps.ownedHelpers }, move.repoId))
            .catch((e) => { if (!stopping) console.error("[daemon] report re-check failed", e); });
          track(moves);
        }
      } else if (m.type === "repo.fetched") {
        await applyRepoFetched(db, m);
      }
    };

    ws.on("message", (d) => {
      const raw = String(d);
      inbox = inbox.then(() => handle(raw)).catch((e) => console.error("[daemon] message failed", e));
      track(inbox);
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      inbox = inbox.then(async () => {
        if (conn) connections.delete(conn);
        if (!conn || stopping) return;
        const wasCurrent = current === conn;
        const assigned = conn.assigned;
        if (wasCurrent) current = null;
        conn.assigned = null;
        conn.rpc.failAll("daemon 已断开");
        // A claim that never reached task.assign is not an interruption.
        if (assigned) await announceInterrupted(db, events, await interruptRunning(db, { daemonId: conn.daemonId }));
        else await requeueAndEmit(conn.daemonId);
        if (wasCurrent) events.emitGlobal({ type: "daemon.status", connected: false });
      }).catch((e) => console.error("[daemon] close failed", e));
      track(inbox);
    });
  });

  const unsubscribe = events.subscribeAll((_ws, e) => {
    if (e.type === "task.updated" && e.task.status === "queued") void dispatch();
    else if (e.type === "workspace.deleted" && current) {
      send(current.ws, { type: "workspace.deleted", workspaceId: e.workspaceId });
      track(syncBoundRepos(db, current.rpc).catch((error) => { if (!stopping) console.error("[daemon] repos.sync failed", error); }));
    }
  });
  const rpc: DaemonRpc = {
    call(method, params, timeoutMs) {
      const conn = current;
      if (!conn || conn.ws.readyState !== conn.ws.OPEN) return Promise.reject(new DaemonRpcError("daemon 未连接"));
      return conn.rpc.call(method, params, timeoutMs);
    },
  };

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      stopping = true;
      unsubscribe();
      current = null;
      for (const conn of connections) conn.rpc.failAll("hub shutting down");
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) client.close(1001, "hub shutting down");
      }
      const timeout = setTimeout(() => {
        for (const client of wss.clients) client.terminate();
      }, 1_000);
      timeout.unref?.();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      clearTimeout(timeout);
      while (pending.size > 0) await Promise.all([...pending]);
      await Promise.all([chain, moves]);
    })();
    return closePromise;
  };
  wss.on("connection", (ws) => {
    if (stopping) ws.close(1001, "hub shutting down");
  });
  return { isConnected: () => !stopping && current !== null, rpc, close };
}
