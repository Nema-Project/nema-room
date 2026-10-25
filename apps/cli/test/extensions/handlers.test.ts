import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { registerExtensionHandlers } from "../../src/extensions/handlers.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

test("extensions.list returns the bundled seeds", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  const response = await router.handle({ type: "rpc.request", id: "1", method: "extensions.list", params: {} });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const rows = response.result as Array<{ id: string }>;
  expect(rows.map((row) => row.id)).toEqual(["code", "diagram", "superpowers", "grill", "github"]);
});
