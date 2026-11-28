import { nanoid } from "nanoid";
import { GraphifyErrorSchema, HUB_ERROR, readCoded, type CodeParams, type DaemonToHub, type ErrorBody, type GraphifyError } from "@nema/shared";

/*
 * The hub's own errors for "no daemon answered" (#299 batch 0). Status codes, repo binding and the extension
 * index's disk fallback key on exactly these texts, so producers and matchers both use the constants and
 * `isDaemonOffline` instead of repeating the wording.
 */
export const DAEMON_NOT_CONNECTED = "daemon 未连接";
export const DAEMON_DISCONNECTED = "daemon 已断开";
export const DAEMON_TIMED_OUT = "daemon 响应超时";
/** The UI code of each offline text (#299 batch 1); `DaemonRpcError` attaches it, so no producer has to. */
const DAEMON_OFFLINE_CODES: ReadonlyMap<string, string> = new Map([
  [DAEMON_NOT_CONNECTED, HUB_ERROR.daemonNotConnected],
  [DAEMON_DISCONNECTED, HUB_ERROR.daemonDisconnected],
  [DAEMON_TIMED_OUT, HUB_ERROR.daemonTimedOut],
]);
const DAEMON_OFFLINE: ReadonlySet<string> = new Set(DAEMON_OFFLINE_CODES.keys());

/**
 * A daemon call that failed. `message` is the fallback text; `code` and `params` (#299 batch 1) come from a
 * daemon that sends them, or from the hub's own offline texts, and are absent for an older daemon.
 */
export class DaemonRpcError extends Error {
  readonly code?: string;
  readonly params?: CodeParams;

  constructor(message: string, readonly graphifyError?: GraphifyError, coded?: { code?: string; params?: CodeParams }) {
    super(message);
    this.name = "DaemonRpcError";
    const code = coded?.code ?? DAEMON_OFFLINE_CODES.get(message);
    if (code !== undefined) this.code = code;
    if (coded?.code !== undefined && coded.params !== undefined) this.params = coded.params;
  }
}

/** `{ error, code?, params? }` for an error response; the fallback text is always there. */
export function errorBody(message: string, coded?: { code?: string; params?: CodeParams }): ErrorBody {
  return {
    error: message,
    ...(coded?.code !== undefined ? { code: coded.code } : {}),
    ...(coded?.code !== undefined && coded.params !== undefined ? { params: coded.params } : {}),
  };
}

/** The body a route answers a failed daemon call with: text, code and params, and Graphify's facts when it has them. */
export function daemonErrorBody(error: DaemonRpcError): ErrorBody & { graphifyError?: GraphifyError } {
  return { ...errorBody(error.message, error), ...(error.graphifyError ? { graphifyError: error.graphifyError } : {}) };
}

/** Whether an error message says no daemon answered (not connected, disconnected, or timed out). */
export function isDaemonOffline(message: string): boolean {
  return DAEMON_OFFLINE.has(message);
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
          reject(new DaemonRpcError(DAEMON_TIMED_OUT));
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
      else waiter.reject(new DaemonRpcError(message.error, GraphifyErrorSchema.safeParse(message.graphifyError).data, readCoded(message.code, message.params)));
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
