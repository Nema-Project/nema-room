import type { DaemonToHub, HubToDaemon } from "@nema/shared";

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
    if (!handler) return { type: "rpc.response", id: req.id, ok: false, error: `未知方法 ${req.method}` };
    try {
      return { type: "rpc.response", id: req.id, ok: true, result: await handler(req.params) };
    } catch (e) {
      return { type: "rpc.response", id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
