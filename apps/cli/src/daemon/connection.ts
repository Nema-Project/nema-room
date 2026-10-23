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
  /** Reported in `hello` (defaults to apps/cli/package.json's version). */
  version?: string;
  /** When set, `rpc.request` is answered immediately and does not wait for the task runner. */
  rpc?: RpcRouter;
  /** Called with the live socket send, and with null when that socket closes. */
  bindSend?: (send: ((message: unknown) => boolean) | null) => void;
};

export const VERSION_SKEW_ERROR = "hub 与 nema CLI 版本不一致，请同时更新（重新构建 compose 并重启 nema daemon）";

export function connectDaemon(opts: DaemonOpts): { close(): void } {
  const reconnectMs = opts.reconnectMs ?? 3000;
  const url = opts.hubUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/daemon";
  let ws: WebSocket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    const sock = new WebSocket(url);
    ws = sock;
    const send = (m: unknown): boolean => {
      if (sock.readyState !== WebSocket.OPEN) return false;
      try {
        sock.send(JSON.stringify(m));
        return true;
      } catch {
        return false;
      }
    };
    sock.on("open", () => {
      opts.bindSend?.(send);
      let hash: string | null = null;
      try {
        hash = opts.nemaHome ? reportTokenHash(opts.nemaHome) : null;
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
      } else if (m.type === "welcome") {
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
        void router.handle(m).then((res) => send(res));
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      if (ws === sock) {
        ws = null;
        opts.bindSend?.(null);
      }
      if (!closed) timer = setTimeout(open, reconnectMs);
    });
  };
  open();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      opts.bindSend?.(null);
      ws?.terminate();
    },
  };
}
