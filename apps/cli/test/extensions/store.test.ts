import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { bundledExtensions, openExtensionStore, type ExtensionRecord } from "../../src/extensions/store.js";

let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

function managed(id: string, installState: ExtensionRecord["installState"] = "installed"): ExtensionRecord {
  return {
    id,
    kind: "skill",
    name: id,
    summary: "A skill",
    source: "https://example.com/skills",
    revision: "abc123",
    provision: "managed",
    installState,
    useState: "enabled",
    availability: "ready",
    externalPath: null,
    error: null,
  };
}

test("bundled seeds are present, enabled, and GitHub has no login field", () => {
  const rows = bundledExtensions();
  expect(rows.map((row) => row.id)).toEqual(["code", "diagram", "superpowers", "grill", "github"]);
  expect(rows.every((row) => row.provision === "bundled" && row.useState === "enabled")).toBe(true);
  expect(rows.find((row) => row.id === "code")).toMatchObject({ availability: "missing-dependency", error: "bundled-runtime-missing" });
  expect(rows.find((row) => row.id === "github")).toMatchObject({ availability: "ready", error: null });
  expect(rows.find((row) => row.id === "github")).not.toHaveProperty("loggedIn");
});

test("refuses to remove a bundled extension", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const store = openExtensionStore(dir);
  expect(() => store.removeManaged("code")).toThrow(/bundled/);
  expect(store.list().some((row) => row.id === "code")).toBe(true);
});

test("does not delete a managed id whose directory points outside extensions", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const outside = mkdtempSync(join(tmpdir(), "nema-ext-outside-"));
  writeFileSync(join(outside, "keep.txt"), "keep");
  const store = openExtensionStore(dir);
  store.putManaged(managed("linked"));
  const link = join(dir, "extensions", "linked");
  rmSync(link, { recursive: true });
  symlinkSync(outside, link, "junction");
  expect(() => store.removeManaged("linked")).toThrow(/outside/);
  expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  expect(store.list().some((row) => row.id === "linked")).toBe(true);
});

test("detaching an external item leaves its file in place", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const outside = mkdtempSync(join(tmpdir(), "nema-ext-external-"));
  writeFileSync(join(outside, "SKILL.md"), "# skill");
  const store = openExtensionStore(dir);
  store.putManaged({ ...managed("remote"), provision: "external", externalPath: outside });
  store.detach("remote");
  expect(readFileSync(join(outside, "SKILL.md"), "utf8")).toBe("# skill");
  expect(store.list().some((row) => row.id === "remote")).toBe(false);
});

test("an installing record is not listed as installed", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const store = openExtensionStore(dir);
  store.putManaged(managed("pending", "installing"));
  expect(store.list().find((row) => row.id === "pending")?.installState).toBe("installing");
});

test("a failed install leaves the previous installed record and files", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const store = openExtensionStore(dir);
  store.putManaged(managed("skill"));
  writeFileSync(join(dir, "extensions", "skill", "keep.txt"), "old");
  const missing = join(dir, "missing-stage");
  expect(() => store.installManaged(managed("skill"), missing)).toThrow(/staged/);
  expect(store.list().find((row) => row.id === "skill")?.installState).toBe("installed");
  expect(readFileSync(join(dir, "extensions", "skill", "keep.txt"), "utf8")).toBe("old");
});

test("cancelling an install removes only that extension directory", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const store = openExtensionStore(dir);
  store.putManaged(managed("pending", "installing"));
  store.putManaged(managed("other"));
  writeFileSync(join(dir, "extensions", "pending", "partial.txt"), "partial");
  writeFileSync(join(dir, "extensions", "other", "keep.txt"), "keep");
  store.cancelInstall("pending");
  expect(store.list().find((row) => row.id === "pending")?.installState).toBe("absent");
  expect(existsSync(join(dir, "extensions", "pending"))).toBe(false);
  expect(readFileSync(join(dir, "extensions", "other", "keep.txt"), "utf8")).toBe("keep");
});

test("installManaged activates a staged directory", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const staged = mkdtempSync(join(tmpdir(), "nema-ext-staged-"));
  mkdirSync(join(staged, "skill"));
  writeFileSync(join(staged, "SKILL.md"), "# skill");
  const store = openExtensionStore(dir);
  store.installManaged(managed("skill", "installing"), staged);
  expect(readFileSync(join(dir, "extensions", "skill", "SKILL.md"), "utf8")).toBe("# skill");
  expect(store.list().find((row) => row.id === "skill")?.installState).toBe("installed");
  rmSync(staged, { recursive: true, force: true });
});
