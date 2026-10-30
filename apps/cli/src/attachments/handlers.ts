import { loadConfig, type NemaConfig } from "../config.js";
import type { RpcRouter } from "../daemon/rpc.js";
import { attachmentCapabilities } from "./capabilities.js";

/** Registers the read-only `attachments.capabilities` RPC. `getConfig` mirrors the runner's config source. */
export function registerAttachmentHandlers(router: RpcRouter, nemaHome: string, getConfig?: () => NemaConfig): void {
  router.register("attachments.capabilities", async () => attachmentCapabilities(getConfig ? getConfig() : loadConfig(nemaHome)));
}
