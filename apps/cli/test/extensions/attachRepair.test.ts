import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { registerExtensionHandlers, type ExtensionHandlerOptions } from "../../src/extensions/handlers.js";
import { bundledExtensions, openExtensionStore } from "../../src/extensions/store.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function setup(options: ExtensionHandlerOptions = {}) {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "nema-ext-attach-")));
  const nemaHome = join(dir, "nema");
  const home = join(dir, "home");
  mkdirSync(home);
  const router = new RpcRouter();
  registerExtensionHandlers(router, nemaHome, { home, ...options });
  let n = 0;
  const call = async (method: string, params: unknown) => router.handle({ type: "rpc.request", id: String(++n), method, params });
  return { nemaHome, home, call };
}

function skill(folder: string, name = "notes"): string {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Keeps notes\n---\n`);
  return folder;
}

function errorOf(response: { ok: boolean }): string {
  return response.ok ? "" : (response as unknown as { error: string }).error;
}

test("extensions.discover lists the home's skill folders against current records", async () => {
  const { home, call } = setup();
  skill(join(home, ".claude", "skills", "notes"));
  const response = await call("extensions.discover", {});
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const result = response.result as { skills: Array<{ id: string; attached: boolean }> };
  expect(result.skills).toEqual([expect.objectContaining({ id: "notes", attached: false, problem: null })]);
});

test("extensions.attach writes an external record at the real path and copies nothing", async () => {
  const { nemaHome, home, call } = setup();
  const folder = skill(join(home, "my-skills", "notes"));
  symlinkSync(join(home, "my-skills"), join(home, "linked"), "dir");
  const response = await call("extensions.attach", { path: join(home, "linked", "notes") });
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.result).toEqual({
    id: "notes", kind: "skill", name: "notes", summary: "Keeps notes", source: folder, revision: "local",
    provision: "external", installState: "installed", useState: "enabled", availability: "ready", externalPath: folder, error: null,
  });
  expect(existsSync(join(nemaHome, "extensions", "extensions", "notes"))).toBe(false);
  const listed = await call("extensions.list", {});
  expect(listed.ok && (listed.result as Array<{ id: string }>).some((row) => row.id === "notes")).toBe(true);
  const found = await call("extensions.discover", {});
  expect(found.ok).toBe(true);
  // Detaching keeps the folder.
  const removed = await call("extensions.remove", { id: "notes" });
  expect(removed.ok && removed.result).toEqual({ id: "notes", removed: "external" });
  expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toContain("name: notes");
});

test("extensions.attach refuses what it cannot attach, without a write", async () => {
  const { nemaHome, home, call } = setup();
  const notes = skill(join(home, "a", "notes"));
  skill(join(home, "b", "grill"), "grill");
  mkdirSync(join(home, "empty"));
  writeFileSync(join(home, "file.md"), "x");
  const refused: Array<[unknown, RegExp]> = [
    [{}, /needs an absolute folder path/],
    [{ path: 7 }, /needs an absolute folder path/],
    [{ path: "a/notes" }, /needs an absolute folder path/],
    [{ path: join(home, "missing") }, /not-a-folder$/],
    [{ path: join(home, "file.md") }, /not-a-folder$/],
    [{ path: join(home, "empty") }, /missing-frontmatter$/],
    [{ path: join(home, "b", "grill") }, /bundled-id$/],
  ];
  for (const [params, message] of refused) {
    const response = await call("extensions.attach", params);
    expect(response.ok).toBe(false);
    expect(errorOf(response)).toMatch(message);
  }
  expect(existsSync(join(nemaHome, "extensions", "index.json"))).toBe(false);
  expect((await call("extensions.attach", { path: notes })).ok).toBe(true);
  const again = await call("extensions.attach", { path: notes });
  expect(errorOf(again)).toMatch(/already attached/);
  const other = skill(join(home, "c", "notes"));
  expect(errorOf(await call("extensions.attach", { path: other }))).toMatch(/id-taken$/);
});

test("extensions.attach refuses an id a managed record already holds", async () => {
  const { nemaHome, home, call } = setup();
  openExtensionStore(join(nemaHome, "extensions")).putManaged({
    id: "notes", kind: "skill", name: "notes", summary: "s", source: "nema install", revision: "abc", provision: "managed",
    installState: "installed", useState: "enabled", availability: "ready", externalPath: null, error: null,
  });
  expect(errorOf(await call("extensions.attach", { path: skill(join(home, "x", "notes")) }))).toMatch(/id-taken$/);
});

test("extensions.repair records the packaged Graphify check and the list shows it", async () => {
  let installed = true;
  const { call } = setup({ checkGraphify: async () => ({ installed, detail: "graphify 1.0" }), now: () => new Date("2026-10-30T03:00:00Z") });
  const fixed = await call("extensions.repair", { id: "code" });
  expect(fixed.ok && fixed.result).toMatchObject({ id: "code", availability: "ready", error: null, checkedAt: "2026-10-30T03:00:00.000Z" });
  let listed = await call("extensions.list", {});
  expect(listed.ok && (listed.result as Array<{ id: string }>).find((row) => row.id === "code")).toMatchObject({ availability: "ready", error: null });
  installed = false;
  const missing = await call("extensions.repair", { id: "code" });
  expect(missing.ok && missing.result).toMatchObject({ availability: "missing-dependency", error: "bundled-runtime-missing" });
  listed = await call("extensions.list", {});
  expect(listed.ok && (listed.result as Array<{ id: string }>).find((row) => row.id === "code")).toMatchObject({ availability: "missing-dependency" });
});

test("extensions.repair marks a Graphify that runs but fails as damaged", async () => {
  const { call } = setup({ checkGraphify: async () => { throw new Error("graphify exited with 1"); } });
  const response = await call("extensions.repair", { id: "code" });
  expect(response.ok && response.result).toMatchObject({ availability: "damaged", error: "bundled-runtime-damaged" });
});

test("extensions.repair confirms the other bundled items and keeps the use state", async () => {
  const { call } = setup({ checkGraphify: async () => { throw new Error("must not run"); } });
  await call("extensions.setUse", { id: "grill", useState: "disabled" });
  const response = await call("extensions.repair", { id: "grill" });
  expect(response.ok && response.result).toMatchObject({ id: "grill", availability: "ready", error: null, useState: "disabled" });
  // Switching it back on keeps the stored check.
  await call("extensions.setUse", { id: "grill", useState: "enabled" });
  const listed = await call("extensions.list", {});
  expect(listed.ok && (listed.result as Array<{ id: string }>).find((row) => row.id === "grill")).toMatchObject({ useState: "enabled", checkedAt: expect.any(String) });
});

test("extensions.repair refuses anything that is not bundled", async () => {
  const { home, call } = setup({ checkGraphify: async () => ({ installed: true, detail: "" }) });
  await call("extensions.attach", { path: skill(join(home, "x", "notes")) });
  for (const params of [{}, { id: "notes" }, { id: "nope" }]) {
    const response = await call("extensions.repair", params);
    expect(response.ok).toBe(false);
  }
  expect(errorOf(await call("extensions.repair", { id: "notes" }))).toMatch(/only a bundled extension/);
});

test("extensions.repair checks the GitHub CLI for the github item", async () => {
  let status = { installed: false, loggedIn: false, detail: "gh not found" };
  const { call } = setup({ checkGithub: async () => status, checkGraphify: async () => { throw new Error("must not run"); } });
  const missing = await call("extensions.repair", { id: "github" });
  expect(missing.ok && missing.result).toMatchObject({ id: "github", availability: "missing-dependency", error: "github-cli-missing" });
  status = { installed: true, loggedIn: false, detail: "not logged in" };
  const signedOut = await call("extensions.repair", { id: "github" });
  expect(signedOut.ok && signedOut.result).toMatchObject({ availability: "missing-dependency", error: "github-cli-signed-out" });
  status = { installed: true, loggedIn: true, detail: "ok" };
  const ready = await call("extensions.repair", { id: "github" });
  expect(ready.ok && ready.result).toMatchObject({ availability: "ready", error: null });
});

test("a GitHub CLI check that throws marks the github item damaged", async () => {
  const { call } = setup({ checkGithub: async () => { throw new Error("gh crashed"); } });
  const response = await call("extensions.repair", { id: "github" });
  expect(response.ok && response.result).toMatchObject({ availability: "damaged", error: "github-cli-damaged" });
});

test("an older Repair that finishes last does not overwrite a newer one", async () => {
  const answers: Array<(value: { installed: boolean; detail: string }) => void> = [];
  let tick = 0;
  const { call } = setup({
    checkGraphify: () => new Promise((resolve) => answers.push(resolve)),
    now: () => new Date(Date.UTC(2026, 9, 30, 3, 0, tick++)),
  });
  const older = call("extensions.repair", { id: "code" });
  const newer = call("extensions.repair", { id: "code" });
  await vi.waitFor(() => expect(answers).toHaveLength(2));
  answers[1]!({ installed: true, detail: "" });
  const newest = await newer;
  expect(newest.ok && newest.result).toMatchObject({ availability: "ready", checkedAt: "2026-10-30T03:00:01.000Z" });
  answers[0]!({ installed: false, detail: "" });
  const stale = await older;
  // The late answer gets the stored, newer result back instead of writing its own.
  expect(stale.ok && stale.result).toMatchObject({ availability: "ready", checkedAt: "2026-10-30T03:00:01.000Z" });
  const listed = await call("extensions.list", {});
  expect(listed.ok && (listed.result as Array<{ id: string }>).find((row) => row.id === "code")).toMatchObject({ availability: "ready", checkedAt: "2026-10-30T03:00:01.000Z" });
});

test("a stored check with an unknown availability is ignored and the shipped seed stands", async () => {
  const { nemaHome, call } = setup();
  const root = join(nemaHome, "extensions");
  mkdirSync(root, { recursive: true });
  const seed = bundledExtensions().find((row) => row.id === "code")!;
  for (const broken of [{ availability: "fine" }, { availability: undefined }, { availability: "ready", error: 7 }]) {
    writeFileSync(join(root, "index.json"), JSON.stringify([{ ...seed, ...broken, checkedAt: "2026-10-30T03:00:00.000Z" }]));
    const listed = await call("extensions.list", {});
    const row = listed.ok && (listed.result as Array<{ id: string }>).find((item) => item.id === "code");
    expect(row, JSON.stringify(broken)).toEqual(seed);
  }
});
