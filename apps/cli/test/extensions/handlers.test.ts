import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { registerExtensionHandlers } from "../../src/extensions/handlers.js";
import { openExtensionStore } from "../../src/extensions/store.js";

let dir: string | undefined;
let outside: string | undefined;
afterEach(() => {
  for (const path of [dir, outside]) if (path) rmSync(path, { recursive: true, force: true });
  dir = undefined;
  outside = undefined;
});

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

/** A record the store writes itself, so `extensions.remove` sees the same index the CLI would. */
function seed(id: string, provision: "managed" | "external", externalPath: string | null = null): void {
  const store = openExtensionStore(join(dir!, "extensions"));
  store.putManaged({
    id,
    kind: "skill",
    name: id,
    summary: "A skill",
    source: provision === "external" ? "https://example.com/skills" : "nema install",
    revision: "abc123",
    provision,
    installState: "installed",
    useState: "enabled",
    availability: "ready",
    externalPath,
    error: null,
  });
}

async function rpc(router: RpcRouter, id: string, method: string, params: unknown) {
  return router.handle({ type: "rpc.request", id, method, params });
}

test("extensions.remove deletes a managed extension directory and its record", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  seed("skill", "managed");
  writeFileSync(join(dir, "extensions", "extensions", "skill", "SKILL.md"), "# skill");

  const response = await rpc(router, "1", "extensions.remove", { id: "skill" });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.result).toEqual({ id: "skill", removed: "managed" });
  expect(existsSync(join(dir, "extensions", "extensions", "skill"))).toBe(false);
  const listed = await rpc(router, "2", "extensions.list", {});
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect((listed.result as Array<{ id: string }>).some((row) => row.id === "skill")).toBe(false);
});

test("extensions.remove detaches an external extension and keeps its files", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  outside = mkdtempSync(join(tmpdir(), "nema-ext-rpc-outside-"));
  writeFileSync(join(outside, "SKILL.md"), "# outside");
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  seed("remote", "external", outside);

  const response = await rpc(router, "1", "extensions.remove", { id: "remote" });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.result).toEqual({ id: "remote", removed: "external" });
  expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toBe("# outside");
  const listed = await rpc(router, "2", "extensions.list", {});
  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect((listed.result as Array<{ id: string }>).some((row) => row.id === "remote")).toBe(false);
});

test("extensions.remove refuses a bundled extension and leaves the list alone", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  const before = await rpc(router, "1", "extensions.list", {});
  expect(before.ok).toBe(true);

  const response = await rpc(router, "2", "extensions.remove", { id: "code" });
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error).toBe("bundled extensions cannot be removed");
  const after = await rpc(router, "3", "extensions.list", {});
  expect(after.ok).toBe(true);
  if (!after.ok || !before.ok) return;
  expect(after.result).toEqual(before.result);
  expect(existsSync(join(dir, "extensions", "index.json"))).toBe(false);
});

test("extensions.remove refuses a missing id or a non-string id without a write", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  for (const params of [{}, { id: "" }, { id: 7 }, { id: null }, null]) {
    const response = await rpc(router, "x", "extensions.remove", params);
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error).toBe("extensions.remove needs a string id");
  }
  expect(existsSync(join(dir, "extensions", "index.json"))).toBe(false);
});

test("extensions.remove refuses an unknown id and leaves the store alone", async () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-rpc-"));
  const router = new RpcRouter();
  registerExtensionHandlers(router, dir);
  seed("skill", "managed");
  const before = await rpc(router, "1", "extensions.list", {});
  expect(before.ok).toBe(true);

  const response = await rpc(router, "2", "extensions.remove", { id: "nope" });
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error).toBe("extension not found: nope");
  const after = await rpc(router, "3", "extensions.list", {});
  expect(after.ok).toBe(true);
  if (!after.ok || !before.ok) return;
  expect(after.result).toEqual(before.result);
  expect(existsSync(join(dir, "extensions", "extensions", "skill"))).toBe(true);
});
