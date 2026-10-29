import path from "node:path";
import type { RpcRouter } from "../daemon/rpc.js";
import { openExtensionStore } from "./store.js";

function requireId(params: unknown, method: string): string {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || !id) throw new Error(`${method} needs a string id`);
  return id;
}

function requireUseState(params: unknown): "enabled" | "disabled" {
  const useState = (params as { useState?: unknown } | undefined)?.useState;
  if (useState !== "enabled" && useState !== "disabled") throw new Error("extensions.setUse needs useState enabled or disabled");
  return useState;
}

export type ExtensionRemoval = { id: string; removed: "managed" | "external" };

export function registerExtensionHandlers(router: RpcRouter, nemaHome: string): void {
  const store = openExtensionStore(path.join(nemaHome, "extensions"));
  router.register("extensions.list", async () => store.list());
  // Three operations, three sets of rules, and the page may only reach two of them.
  //
  // Use state: flip one record's switch; every provision can be turned off and on again.
  // Install: stage a directory and activate it; a separate path with its own staging rules.
  // Remove: only an extension Nema provisioned can be deleted outright, which means its own
  // `extensions/<id>` directory goes with the record. An external one is only detached from the
  // index: the files stay exactly where the person put them. A bundled extension ships inside the
  // app, so there is nothing here to delete and the request is refused.
  router.register("extensions.setUse", async (params) => store.setUseState(requireId(params, "extensions.setUse"), requireUseState(params)));
  router.register("extensions.remove", async (params): Promise<ExtensionRemoval> => {
    const id = requireId(params, "extensions.remove");
    const record = store.list().find((row) => row.id === id);
    if (!record) throw new Error(`extension not found: ${id}`);
    if (record.provision === "bundled") throw new Error("bundled extensions cannot be removed");
    if (record.provision === "managed") {
      store.removeManaged(id);
      return { id, removed: "managed" };
    }
    store.detach(id);
    return { id, removed: "external" };
  });
}
