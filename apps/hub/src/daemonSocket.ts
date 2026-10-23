import type http from "node:http";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import { KnowledgeStore } from "@nema/knowledge";
import { WORKPACKAGE_LIMITS, parseDaemonToHub, type AgentMessageMeta, type HubToDaemon, type PluginToolSpec } from "@nema/shared";
import { createConnectionRpc, DaemonRpcError, type ConnectionRpc, type DaemonRpc } from "./daemonRpc.js";
import type { Db } from "./db/db.js";
import type { EventBus } from "./events.js";
import { timeline, topOpenQuestion } from "./entryIndex.js";
import { addMessage, getLastAgentMessage, getMessage, listPromptMessages, type Message } from "./messages.js";
import { announceInterrupted } from "./interrupts.js";
import { enabledPluginTools, grillState } from "./plugins.js";
import { recheckReports, registerReportToken } from "./reports.js";
import { buildPrompt, type WorkPackagePromptInput } from "./prompt.js";
import { onRepoMoved } from "./diagrams.js";
import { workPackageIdOf, workPackageRules } from "./workpackages.js";
import { applyRepoFetched, applyRepoMoved, listRepos, syncBoundRepos } from "./repos.js";
import { claimNextTask, finishTask, getTask, interruptRunning, listTaskChanges, requeueDaemonTasks, toUiTask, type Task } from "./tasks.js";
import { getWorkspace, listWorkspaces, repoPath } from "./workspaces.js";

export type DaemonSocketDeps = { db: Db; dataDir: string; events: EventBus; daemonToken: string; hubUrl: string };

type Conn = {
  ws: WebSocket;
  daemonId: string;
  assigned: { taskId: string; workspaceId: string; runToken: string } | null;
  rpc: ConnectionRpc;
};

export const OLD_CLI_MESSAGE = "nema CLI 版本过旧，请运行 npm run build -w apps/cli 并重启 nema daemon";

export function attachDaemonSocket(server: http.Server, deps: DaemonSocketDeps): { isConnected(): boolean; rpc: DaemonRpc } {
  const { db, dataDir, events } = deps;
  const wss = new WebSocketServer({ server, path: "/daemon" });
  let current: Conn | null = null;
  let chain: Promise<void> = Promise.resolve();
  let moves: Promise<void> = Promise.resolve();

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
    const before = await listPromptMessages(db, task.workspaceId, userMessage.id, 20);
    // A system-started task or a coding agent's report is not the user's answer to the last follow-up question.
    const asked = userMessage.role === "system" || userMessage.role === "report" ? undefined : (await getLastAgentMessage(db, task.workspaceId))?.meta?.askedQuestion;
    const store = new KnowledgeStore(repoPath(dataDir, task.workspaceId));
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
    const prompt = await buildPrompt({
      workspace,
      userMessage,
      recentMessages: before,
      entries: await timeline(db, dataDir, task.workspaceId),
      lastAskedQuestion,
      priorChanges: await listTaskChanges(db, task.id),
      grill: await grillState(db, task.workspaceId),
      ...(workpackage ? { workpackage } : {}),
    });
    return { prompt, confidential: workspace.confidential };
  }

  async function dispatchOnce(): Promise<void> {
    for (;;) {
      const conn = current;
      if (!conn || conn.assigned) return;
      const task = await claimNextTask(db, conn.daemonId);
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
          if (await finishTask(db, task.id, { ok: false, error }, task.runToken ?? undefined)) {
            const msg = await addMessage(db, task.workspaceId, "system", "处理失败：" + error, { taskId: task.id });
            events.emit(task.workspaceId, { type: "message.created", message: msg });
            await emitTask(task.id);
          }
        } catch (e2) {
          console.error("[daemon] failed to record prompt failure", e2);
          await requeueAndEmit(conn.daemonId).catch(() => {});
          return;
        }
        continue;
      }
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
    return chain;
  };

  async function onFinished(conn: Conn, m: Extract<ReturnType<typeof parseDaemonToHub>, { type: "task.finished" }>) {
    const a = conn.assigned;
    if (!a || a.taskId !== m.taskId) return;
    let msg: Message | null = null;
    if (m.ok) {
      // With grill-me off the uncertain items still become questions, but the chat shows no asked one.
      const q = (await grillState(db, a.workspaceId)).enabled ? await topOpenQuestion(db, dataDir, a.workspaceId) : null;
      const meta: AgentMessageMeta = {
        changes: (await listTaskChanges(db, m.taskId)) as AgentMessageMeta["changes"],
        askedQuestion: q ? { id: q.id, title: q.title, body: q.body } : null,
      };
      if (!(await finishTask(db, m.taskId, { ok: true }, a.runToken))) {
        conn.assigned = null;
        return;
      }
      msg = await addMessage(db, a.workspaceId, "agent", m.reply, { taskId: m.taskId, meta });
    } else {
      if (!(await finishTask(db, m.taskId, { ok: false, error: m.error }, a.runToken))) {
        conn.assigned = null;
        return;
      }
      msg = await addMessage(db, a.workspaceId, "system", "处理失败：" + m.error, { taskId: m.taskId });
    }
    conn.assigned = null;
    events.emit(a.workspaceId, { type: "message.created", message: msg });
    await emitTask(m.taskId);
    await dispatch();
  }

  wss.on("connection", (ws) => {
    let conn: Conn | null = null;
    // Per-connection serial handling keeps hello/finished ordering intact.
    let inbox: Promise<void> = Promise.resolve();

    const handle = async (raw: string) => {
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
        const old = current;
        conn = {
          ws,
          daemonId: `d_${nanoid(10)}`,
          assigned: null,
          rpc: createConnectionRpc((id, method, params) => send(ws, { type: "rpc.request", id, method, params })),
        };
        current = conn;
        // Leave old.assigned for the close handler. An in-flight dispatchOnce may have claimed a
        // task it has not sent; wait until that claim is requeued uncounted before a counted interrupt.
        const pendingDispatch = chain;
        if (old) old.ws.close();
        await pendingDispatch;
        await announceInterrupted(db, events, await interruptRunning(db, { exceptDaemonId: conn.daemonId }));
        // The id list lets the daemon drop isolation dirs of workspaces deleted while it was away.
        send(ws, { type: "welcome", workspaceIds: (await listWorkspaces(db)).map((w) => w.id) });
        void syncBoundRepos(db, conn.rpc).catch((error) => console.error("[daemon] repos.sync failed", error));
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
            .then(() => onRepoMoved(db, dataDir, rpc, events, move))
            .catch((e) => console.error("[daemon] diagram staleness check failed", e))
            .then(() => recheckReports({ db, events, daemon: rpc, dataDir }, move.repoId))
            .catch((e) => console.error("[daemon] report re-check failed", e));
        }
      } else if (m.type === "repo.fetched") {
        await applyRepoFetched(db, m);
      }
    };

    ws.on("message", (d) => {
      const raw = String(d);
      inbox = inbox.then(() => handle(raw)).catch((e) => console.error("[daemon] message failed", e));
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      inbox = inbox.then(async () => {
        if (!conn) return;
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
    });
  });

  events.subscribeAll((_ws, e) => {
    if (e.type === "task.updated" && e.task.status === "queued") void dispatch();
    else if (e.type === "workspace.deleted" && current) {
      send(current.ws, { type: "workspace.deleted", workspaceId: e.workspaceId });
      void syncBoundRepos(db, current.rpc).catch((error) => console.error("[daemon] repos.sync failed", error));
    }
  });
  server.on("close", () => wss.close());

  const rpc: DaemonRpc = {
    call(method, params, timeoutMs) {
      const conn = current;
      if (!conn || conn.ws.readyState !== conn.ws.OPEN) return Promise.reject(new DaemonRpcError("daemon 未连接"));
      return conn.rpc.call(method, params, timeoutMs);
    },
  };

  return { isConnected: () => current !== null, rpc };
}
