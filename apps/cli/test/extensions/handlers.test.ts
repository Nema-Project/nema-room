import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

test("extensions.setUse disables a bundled extension and the list reflects it", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  const response = await router.handle({ type: "rpc.request", id: "2", method: "extensions.setUse", params: { id: "grill", useState: "disabled" } });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect((response.result as { useState: string }).useState).toBe("disabled");
  const listed = await router.handle({ type: "rpc.request", id: "3", method: "extensions.list", params: {} });
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  const rows = listed.result as Array<{ id: string; useState: string }>;
  expect(rows.find((row) => row.id === "grill")?.useState).toBe("disabled");
  expect(rows.map((row) => row.id)).toEqual(["code", "diagram", "superpowers", "grill", "github"]);
});

test("extensions.setUse refuses malformed params without a write", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  for (const params of [{}, { id: "grill" }, { id: "grill", useState: "paused" }, { id: 7, useState: "enabled" }, { useState: "enabled" }]) {
    const response = await router.handle({ type: "rpc.request", id: "x", method: "extensions.setUse", params });
    expect(response.ok).toBe(false);
  }
  expect(existsSync(join(dir, "extensions", "index.json"))).toBe(false);
});
