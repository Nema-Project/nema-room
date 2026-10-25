import type http from "node:http";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import { KnowledgeStore } from "@nema/knowledge";
import { WORKPACKAGE_LIMITS, parseDaemonToHub, type AgentMessageMeta, type HubToDaemon, type PluginToolSpec, type UserMessageMeta } from "@nema/shared";
import { createConnectionRpc, DaemonRpcError, type ConnectionRpc, type DaemonRpc } from "./daemonRpc.js";
import type { Db } from "./db/db.js";
import type { EventBus } from "./events.js";
import { chooseAskedQuestion, timeline } from "./entryIndex.js";
import { addMessage, getLastAskedQuestion, getMessage, listMessageVersions, listPromptMessages, listRecentMessages, messageExcerpt, type Message } from "./messages.js";
import { associateQuestion, conversationOf, ensureThread, getThread } from "./threads.js";
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

export type DaemonSocketDeps = { db: Db; dataDir: string; events: EventBus; daemonToken: string; hubUrl: string; ownedHelpers?: OwnedHelperScope };

type Conn = {
  ws: WebSocket;
  daemonId: string;
  assigned: { taskId: string; workspaceId: string; runToken: string } | null;
  rpc: ConnectionRpc;
};

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

  /** Requeues a daemon's running tasks and announces each so UIs see them as queued again. */
  async function requeueAndEmit(daemonId: string): Promise<void> {
    const ids = (await db.query<{ id: string }>(`select id from tasks where daemon_id = $1 and status = 'running'`, [daemonId])).map((r) => r.id);
    await requeueDaemonTasks(db, daemonId);
    for (const id of ids) await emitTask(id);
  }

  async function buildTaskPrompt(task: Task): Promise<{ prompt: string; confidential: boolean }> {
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
    });
    return { prompt, confidential: workspace.confidential };
  }

  async function saveTaskFailure(taskId: string, workspaceId: string, runToken: string, error: string): Promise<Message | null> {
    const task = await getTask(db, taskId);
    if (!task) return null;
    const anchor = await getMessage(db, task.messageId);
    if (!anchor) return null;
    const replyThread = await conversationOf(db, anchor);
    return db.tx(async (t) => {
      if (!(await finishTask(t, taskId, { ok: false, error }, runToken))) return null;
      return addMessage(t, workspaceId, "system", "处理失败：" + error, { taskId, threadId: replyThread });
    });
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
      let built: { prompt: string; confidential: boolean };
      let pluginTools: PluginToolSpec[] = [];
      try {
        built = await buildTaskPrompt(task);
        pluginTools = await enabledPluginTools(db, task.workspaceId);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        try {
          const msg = task.runToken ? await saveTaskFailure(task.id, task.workspaceId, task.runToken, error) : null;
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
    let msg: Message | null = null;
    let replyThread: string | null = null;
    let taskMessage: Message | null = null;
    let threadEvent = false;
    if (m.ok) {
      // With grill-me off the uncertain items still become questions, but the chat shows no asked one.
      // A question this task opened is the one the reply is about, even when an older question has higher priority.
      const grillOn = (await grillState(db, a.workspaceId)).enabled;
      const changes = (await listTaskChanges(db, m.taskId)) as AgentMessageMeta["changes"];
      const store = new KnowledgeStore(repoPath(dataDir, a.workspaceId), deps.ownedHelpers);
      const touched = (await Promise.all([...new Set(changes.filter((c) => c.kind === "question").map((c) => c.entryId))].map((id) => store.get(id)))).filter((e) => e !== null);
      const q = grillOn ? chooseAskedQuestion(touched, null) : null;
      const finished = await getTask(db, m.taskId);
      if (!finished) return;
      taskMessage = await getMessage(db, finished.messageId);
      if (!taskMessage) return;
      replyThread = await conversationOf(db, taskMessage);
      if (!replyThread && grillOn && q) {
        replyThread = taskMessage.id;
        threadEvent = true;
      }
      const meta: AgentMessageMeta = {
        changes,
        askedQuestion: q ? { id: q.id, title: q.title, body: q.body } : null,
      };
      if (finished?.kind === "edit") {
        const edited = await getMessage(db, finished.messageId);
        if (edited) meta.quote = { messageId: edited.id, role: edited.role, excerpt: messageExcerpt(edited.content) };
      }
      msg = await db.tx(async (t) => {
        if (!(await finishTask(t, m.taskId, { ok: true }, a.runToken))) return null;
        if (threadEvent && taskMessage && q) await ensureThread(t, taskMessage.id, q.title, "grill");
        const reply = await addMessage(t, a.workspaceId, "agent", m.reply, { taskId: m.taskId, meta, threadId: replyThread });
        if (replyThread) {
          for (const entry of touched) {
            if (entry.kind === "question" && entry.status === "open") await associateQuestion(t, a.workspaceId, entry.id, replyThread);
          }
        }
        return reply;
      });
      if (!msg) {
        conn.assigned = null;
        return;
      }
    } else {
      const task = await getTask(db, m.taskId);
      taskMessage = task ? await getMessage(db, task.messageId) : null;
      replyThread = taskMessage ? await conversationOf(db, taskMessage) : null;
      msg = await db.tx(async (t) => {
        if (!(await finishTask(t, m.taskId, { ok: false, error: m.error }, a.runToken))) return null;
        return addMessage(t, a.workspaceId, "system", "处理失败：" + m.error, { taskId: m.taskId, threadId: replyThread });
      });
      if (!msg) {
        conn.assigned = null;
        return;
      }
    }
    conn.assigned = null;
    events.emit(a.workspaceId, { type: "message.created", message: msg });
    if (replyThread || threadEvent) {
      const thread = await getThread(db, replyThread ?? taskMessage!.id);
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
