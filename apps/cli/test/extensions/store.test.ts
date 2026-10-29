import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

test("disabling a bundled extension keeps its seed and stores only the use state", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const store = openExtensionStore(dir);
  const before = store.list().find((row) => row.id === "diagram")!;
  const next = store.setUseState("diagram", "disabled");
  expect(next.useState).toBe("disabled");
  const after = store.list().find((row) => row.id === "diagram")!;
  expect(after.useState).toBe("disabled");
  // Nothing else about the seed may change: provision, availability, and functions stay as shipped.
  expect({ ...after, useState: before.useState }).toEqual(before);
  expect(store.list().filter((row) => row.id === "diagram")).toHaveLength(1);
  // The choice survives reopening the store, which is what a hub restart does.
  expect(openExtensionStore(dir).list().find((row) => row.id === "diagram")?.useState).toBe("disabled");
});

test("enabling a bundled extension again returns it to the shipped state", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const store = openExtensionStore(dir);
  store.setUseState("grill", "disabled");
  expect(store.setUseState("grill", "enabled").useState).toBe("enabled");
  expect(store.list().find((row) => row.id === "grill")?.useState).toBe("enabled");
});

test("a managed extension takes its use state like any other record", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const store = openExtensionStore(dir);
  store.putManaged(managed("skill"));
  expect(store.setUseState("skill", "disabled").useState).toBe("disabled");
  expect(store.list().find((row) => row.id === "skill")?.useState).toBe("disabled");
});

test("an unknown id or an unknown use state is refused without touching the store", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const store = openExtensionStore(dir);
  const before = JSON.stringify(store.list());
  expect(() => store.setUseState("nope", "enabled")).toThrow(/not installed/);
  expect(() => store.setUseState("diagram", "paused" as never)).toThrow(/invalid use state/);
  expect(JSON.stringify(store.list())).toBe(before);
  expect(existsSync(join(dir, "index.json"))).toBe(false);
});

test("the index is replaced in one step and leaves no temp file behind", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const store = openExtensionStore(dir);
  store.putManaged(managed("skill"));
  store.setUseState("skill", "disabled");
  store.setUseState("diagram", "disabled");
  // Only the index itself may exist: a temp file here would mean a rename never happened.
  expect(readdirSync(dir).filter((name) => name.startsWith("index.json"))).toEqual(["index.json"]);
  // And the file it left behind is complete, parseable JSON rather than a truncated write.
  const rows = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as ExtensionRecord[];
  expect(rows.find((row) => row.id === "skill")?.useState).toBe("disabled");
  expect(rows.find((row) => row.id === "diagram")?.useState).toBe("disabled");
});

test("writing the index replaces the file instead of truncating it in place", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  const store = openExtensionStore(dir);
  store.putManaged(managed("skill"));
  const file = join(dir, "index.json");
  const before = statSync(file).ino;
  store.setUseState("skill", "disabled");
  // A new inode means the old file was never opened for writing: a reader either sees the whole old
  // index or the whole new one, never a truncated middle.
  expect(statSync(file).ino).not.toBe(before);
});

test("a half-written index from an older crash does not block the next write", () => {
  dir = mkdtempSync(join(tmpdir(), "nema-ext-"));
  // Simulate the leftover a crash mid-write can leave: a stray temp file beside a valid index.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.json"), JSON.stringify([managed("skill")]));
  writeFileSync(join(dir, "index.json.999.1.tmp"), "[{\"id\":");
  const store = openExtensionStore(dir);
  expect(store.setUseState("skill", "disabled").useState).toBe("disabled");
  expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as ExtensionRecord[]).toMatchObject([
    { id: "skill", useState: "disabled" },
  ]);
});
