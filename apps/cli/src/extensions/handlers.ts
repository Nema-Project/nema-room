import path from "node:path";
import type { RpcRouter } from "../daemon/rpc.js";
import { openExtensionStore } from "./store.js";

export function registerExtensionHandlers(router: RpcRouter, nemaHome: string): void {
  const store = openExtensionStore(path.join(nemaHome, "extensions"));
  router.register("extensions.list", async () => store.list());
}
