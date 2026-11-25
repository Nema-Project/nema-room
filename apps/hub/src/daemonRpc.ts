import { nanoid } from "nanoid";
import type { DaemonToHub } from "@nema/shared";

export class DaemonRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonRpcError";
  }
}

/** Plugin calls and index builds may run graphify on a whole repo, which takes minutes, not seconds. */
export const INDEX_RPC_TIMEOUT_MS = 300_000;

/**
 * Component RPCs answer from the store or start a background install and return at once; the download itself
 * never runs inside an RPC (its progress is read back through `components.status`). A cancel waits for the
 * installer to clean its staging, and agent detection runs `--version` with a 10-second limit, so the default
 * 30 seconds covers both; a longer limit would only hide a stuck daemon.
 */
export const COMPONENT_RPC_TIMEOUT_MS = 30_000;

/**
 * What a call is about, so the hub can choose among several connected daemons (#167). Every field is a
 * preference, never a requirement: with one daemon connected the call always goes to it, as it did before
 * the connection table. The order in which the facade applies them is documented on `attachDaemonSocket`'s
 * `rpc` in daemonSocket.ts.
 */
export type DaemonTarget = {
  /** Answer from this daemon when it is connected, e.g. the one that reported a repo move. */
  daemonId?: string;
  /** The call serves this running task: answer from the daemon running it. */
  taskId?: string;
  /** The call concerns this workspace: prefer a daemon owned by one of its owners. */
  workspaceId?: string;
  /** Every connected daemon should hear it (e.g. `repos.sync`); resolves with the first answer. */
  all?: boolean;
};

export interface DaemonRpc {
  call(method: string, params: unknown, timeoutMs?: number, target?: DaemonTarget): Promise<unknown>;
}

/**
 * Binds a default target, for code that already knows what its calls are about (a run-token request knows
 * its task). A target given at the call is merged over the bound one.
 */
export function withDaemonTarget(daemon: DaemonRpc, bound: DaemonTarget): DaemonRpc {
  return { call: (method, params, timeoutMs, target) => daemon.call(method, params, timeoutMs, { ...bound, ...target }) };
}

type RpcResponse = Extract<DaemonToHub, { type: "rpc.response" }>;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: DaemonRpcError) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Pending calls for one daemon socket. The socket drops the instance when that socket closes. */
export type ConnectionRpc = {
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  onResponse(message: RpcResponse): void;
  failAll(message: string): void;
};

export function createConnectionRpc(send: (id: string, method: string, params: unknown) => void): ConnectionRpc {
  const pending = new Map<string, Pending>();
  return {
    call(method, params, timeoutMs = 30_000) {
      const id = nanoid();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(new DaemonRpcError("daemon 响应超时"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        send(id, method, params);
      });
    },
    onResponse(message) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new DaemonRpcError(message.error));
    },
    failAll(message) {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new DaemonRpcError(message));
      }
      pending.clear();
    },
  };
}
