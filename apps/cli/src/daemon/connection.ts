import WebSocket from "ws";
import { parseHubToDaemon } from "@nema/shared";
import { cliVersion } from "../direct/siwc.js";
import { reportTokenHash } from "../report/token.js";
import { reconcileWorkspaceDirs, removeWorkspaceDir } from "./cleanup.js";
import type { RpcRouter } from "./rpc.js";
import type { Runner } from "./runner.js";

export type DaemonOpts = {
  hubUrl: string;
  token: string;
  runner: Runner;
  reconnectMs?: number;
  /** `~/.nema`: when set, isolation dirs of deleted workspaces (`<nemaHome>/ws/<id>`) are removed. */
  nemaHome?: string;
  /** Whose `report-token` the hello registers; defaults to `nemaHome`. The desktop app points it at the user-level `~/.nema` its hooks use. */
  reportTokenHome?: string;
  /** Reported in `hello` (defaults to apps/cli/package.json's version). */
  version?: string;
  /** When set, `rpc.request` is answered immediately and does not wait for the task runner. */
  rpc?: RpcRouter;
  /** Called with the live socket send, and with null when that socket closes. */
  bindSend?: (send: ((message: unknown) => boolean) | null) => void;
};

export const VERSION_SKEW_ERROR = "hub 与 nema CLI 版本不一致，请同时更新（重新构建 compose 并重启 nema daemon）";

function skewGuidance(message: string): string | null {
  if (!message.includes("版本不一致")) return null;
  const match = /nema@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(message);
  if (match) return `run: npm i -g nema@${match[1]}`;
  return "run: npm i -g nema@<hub 版本>\n请先查看正在运行的 hub 的版本";
}

export function connectDaemon(opts: DaemonOpts): { close(): Promise<void> } {
  const reconnectMs = opts.reconnectMs ?? 3000;
  const url = opts.hubUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/daemon";
  let ws: WebSocket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let stop = false;
  let closePromise: Promise<void> | undefined;
  const rpcInflight = new Set<Promise<unknown>>();

  const open = () => {
    if (closed) return;
    const sock = new WebSocket(url);
    ws = sock;
    const send = (m: unknown): boolean => {
      if (closed) return false;
      if (sock.readyState !== WebSocket.OPEN) return false;
      try {
        sock.send(JSON.stringify(m));
        return true;
      } catch {
        return false;
      }
    };
    sock.on("open", () => {
      if (closed) return;
      opts.bindSend?.(send);
      let hash: string | null = null;
      try {
        const tokenHome = opts.reportTokenHome ?? opts.nemaHome;
        hash = tokenHome ? reportTokenHash(tokenHome) : null;
      } catch (e) {
        console.error(`[nema] report token not sent: ${e instanceof Error ? e.message : String(e)}`);
      }
      send({
        type: "hello",
        token: opts.token,
        version: opts.version ?? cliVersion(),
        adapters: opts.runner.adapterNames,
        ...(hash ? { reportTokenHash: hash } : {}),
      });
    });
    sock.on("message", (d) => {
      if (closed) return;
      let m;
      let rawMsg: unknown;
      try {
        rawMsg = JSON.parse(String(d));
        m = parseHubToDaemon(rawMsg);
      } catch (e) {
        const r = rawMsg as { type?: unknown; taskId?: unknown } | null;
        if (r && typeof r === "object" && r.type === "task.assign" && typeof r.taskId === "string") {
          // A schema mismatch (e.g. a newer hub): fail the task instead of leaving it running forever.
          console.error(`[nema] cannot parse task.assign ${r.taskId}: ${e instanceof Error ? e.message : String(e)}`);
          send({ type: "task.finished", taskId: r.taskId, ok: false, error: VERSION_SKEW_ERROR });
        } else {
          console.error("[nema] ignoring unparseable hub message:", e instanceof Error ? e.message : String(e));
        }
        return;
      }
      const nemaHome = opts.nemaHome;
      if (m.type === "error") {
        console.error(`[nema] hub: ${m.message}`);
        const guidance = skewGuidance(m.message);
        if (guidance) {
          console.error(guidance);
          stop = true;
        }
      } else if (m.type === "welcome") {
        console.log(`[nema] daemon connected to ${opts.hubUrl}`);
        const ids = m.workspaceIds;
        if (nemaHome && ids) {
          // Queued behind any task still running, so a dir is never removed under a live agent.
          void opts.runner.exclusive(async () => {
            try {
              const removed = await reconcileWorkspaceDirs(nemaHome, ids);
              if (removed.length > 0) console.log(`[nema] removed isolation dirs of deleted workspaces: ${removed.join(", ")}`);
            } catch (e) {
              console.error("[nema] isolation dir cleanup failed", e);
            }
          });
        }
      } else if (m.type === "workspace.deleted") {
        const id = m.workspaceId;
        if (nemaHome) {
          void opts.runner.exclusive(async () => {
            try {
              await removeWorkspaceDir(nemaHome, id);
            } catch (e) {
              console.error(`[nema] failed to remove isolation dir of ${id}`, e);
            }
          });
        }
      } else if (m.type === "task.assign") {
        const taskId = m.taskId;
        opts.runner.enqueue(
          m,
          (event) => send({ type: "task.event", taskId, event }),
          (r) => send(r.ok ? { type: "task.finished", taskId, ok: true, reply: r.reply } : { type: "task.finished", taskId, ok: false, error: r.error }),
        );
      } else if (m.type === "rpc.request" && opts.rpc) {
        // A running agent waits on this response, so it must not join the task queue.
        const router = opts.rpc;
        const request = router.handle(m).then((res) => { if (!closed) send(res); });
        rpcInflight.add(request);
        void request.then(() => rpcInflight.delete(request), () => rpcInflight.delete(request));
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      if (ws === sock) {
        ws = null;
        opts.bindSend?.(null);
      }
      if (!closed && !stop) timer = setTimeout(open, reconnectMs);
    });
  };
  open();

  return {
    close() {
      if (closePromise) return closePromise;
      closed = true;
      if (timer) clearTimeout(timer);
      opts.bindSend?.(null);
      const socket = ws;
      const socketClosed = !socket || socket.readyState === WebSocket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            socket.once("close", () => resolve());
            try { socket.terminate(); } catch { resolve(); }
          });
      closePromise = Promise.all([...rpcInflight, socketClosed]).then(() => {});
      return closePromise;
    },
  };
}
