import path from "node:path";
import type { RpcRouter } from "../daemon/rpc.js";
import { openExtensionStore } from "./store.js";

function requireId(params: unknown): string {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || !id) throw new Error("extensions.setUse needs a string id");
  return id;
}

function requireUseState(params: unknown): "enabled" | "disabled" {
  const useState = (params as { useState?: unknown } | undefined)?.useState;
  if (useState !== "enabled" && useState !== "disabled") throw new Error("extensions.setUse needs useState enabled or disabled");
  return useState;
}

export function registerExtensionHandlers(router: RpcRouter, nemaHome: string): void {
  const store = openExtensionStore(path.join(nemaHome, "extensions"));
  router.register("extensions.list", async () => store.list());
  // The only write reachable from the page: flip one record's use state. Installation and removal
  // are separate operations with their own staging rules.
  router.register("extensions.setUse", async (params) => store.setUseState(requireId(params), requireUseState(params)));
}
