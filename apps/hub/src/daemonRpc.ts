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

export interface DaemonRpc {
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
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
