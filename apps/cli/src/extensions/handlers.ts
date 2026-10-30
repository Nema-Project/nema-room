import path from "node:path";
import type { RpcRouter } from "../daemon/rpc.js";
import { parseSkillSource } from "@nema/shared";
import { resolveSkillSource, type SkillCandidate, type SkillResolution, type SourceFetch } from "./source.js";
import { openExtensionStore } from "./store.js";

/** Hub waits 60 s for this RPC; stop GitHub reads first so the daemon's own error reaches the page. */
const RESOLVE_TIMEOUT_MS = 45_000;

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

/** A resolved source as the install preview shows it: where each skill would land, and whether it is already there. */
export type SourcePreview = SkillResolution & { skills: Array<SkillCandidate & { target: string | null; installed: boolean }> };

export type ExtensionHandlerOptions = { fetch?: SourceFetch };

export function registerExtensionHandlers(router: RpcRouter, nemaHome: string, options: ExtensionHandlerOptions = {}): void {
  const root = path.join(nemaHome, "extensions");
  const store = openExtensionStore(root);
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
  // Read-only: parse the pasted source, pin it to one commit, and list the skills at that commit. No
  // record or directory is written, so an abandoned preview leaves nothing behind.
  router.register("extensions.resolveSource", async (params): Promise<SourcePreview> => {
    const raw = (params as { source?: unknown } | undefined)?.source;
    if (typeof raw !== "string") throw new Error("extensions.resolveSource needs a string source");
    const source = parseSkillSource(raw);
    const fetch = options.fetch ?? (globalThis.fetch as unknown as SourceFetch);
    let resolved: SkillResolution;
    try {
      resolved = await resolveSkillSource(source, { fetch, signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(`GitHub did not answer within ${RESOLVE_TIMEOUT_MS / 1000} s`);
      }
      throw error;
    }
    const present = new Set(store.list().map((row) => row.id));
    return {
      ...resolved,
      skills: resolved.skills.map((skill) => ({
        ...skill,
        target: skill.id ? path.join(root, "extensions", skill.id) : null,
        installed: skill.id ? present.has(skill.id) : false,
      })),
    };
  });
}
