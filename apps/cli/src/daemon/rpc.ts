import { DAEMON_ERROR, GraphifyErrorSchema, codedFields, unknownRpcMethodError, type DaemonToHub, type HubToDaemon } from "@nema/shared";

export type RpcHandler = (params: unknown) => Promise<unknown>;

type RpcRequest = Extract<HubToDaemon, { type: "rpc.request" }>;
type RpcResponse = Extract<DaemonToHub, { type: "rpc.response" }>;

export class RpcRouter {
  private readonly handlers = new Map<string, RpcHandler>();

  register(method: string, h: RpcHandler): void {
    this.handlers.set(method, h);
  }

  async handle(req: RpcRequest): Promise<RpcResponse> {
    const handler = this.handlers.get(req.method);
    if (!handler) {
      // The text stays: a hub reads it as "older daemon" (`isUnknownRpcMethodError`). The code is for the UI.
      return {
        type: "rpc.response", id: req.id, ok: false, error: unknownRpcMethodError(req.method),
        code: DAEMON_ERROR.rpcUnknownMethod, params: { method: req.method },
      };
    }
    try {
      return { type: "rpc.response", id: req.id, ok: true, result: await handler(req.params) };
    } catch (e) {
      const graphifyError = e instanceof Error && "graphifyError" in e
        ? GraphifyErrorSchema.safeParse(e.graphifyError).data
        : undefined;
      // Only a `CodedError` carries a code: a Node error's `code` (ENOENT) or Graphify's own is not one.
      return {
        type: "rpc.response", id: req.id, ok: false,
        error: e instanceof Error ? e.message : String(e),
        ...(graphifyError ? { graphifyError } : {}),
        ...codedFields(e),
      };
    }
  }
}
