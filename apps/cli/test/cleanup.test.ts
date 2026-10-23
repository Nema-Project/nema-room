import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { reconcileWorkspaceDirs, removeWorkspaceDir } from "../src/daemon/cleanup.js";

async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), "nema-cleanup-"));
  const nemaHome = path.join(base, "home");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(nemaHome, "ws"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "keep.txt"), "keep");
  return { base, nemaHome, outside };
}

function wsDir(nemaHome: string, id: string): string {
  const d = path.join(nemaHome, "ws", id, "codex-home");
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, "config.toml"), "x");
  return path.join(nemaHome, "ws", id);
}

describe("removeWorkspaceDir", () => {
  test("removes the workspace dir without following symlinks inside it", async () => {
    const { nemaHome, outside } = await setup();
    const dir = wsDir(nemaHome, "ws_abc");
    symlinkSync(path.join(outside, "keep.txt"), path.join(dir, "codex-home", "auth.json"));
    symlinkSync(outside, path.join(dir, "linked-dir"));
    expect(await removeWorkspaceDir(nemaHome, "ws_abc")).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  test("ignores ids that do not match the workspace id pattern", async () => {
    const { nemaHome, base } = await setup();
    writeFileSync(path.join(base, "victim"), "v");
    mkdirSync(path.join(nemaHome, "ws", "notaws"), { recursive: true });
    for (const bad of ["../../victim", "ws_../x", "ws_", "notaws", "ws_a/b", ".", "..", "", `ws_${"a".repeat(33)}`]) {
      expect(await removeWorkspaceDir(nemaHome, bad)).toBe(false);
    }
    expect(existsSync(path.join(base, "victim"))).toBe(true);
    expect(existsSync(path.join(nemaHome, "ws", "notaws"))).toBe(true);
  });

  test("a workspace entry that is a symlink is unlinked, its target untouched", async () => {
    const { nemaHome, outside } = await setup();
    symlinkSync(outside, path.join(nemaHome, "ws", "ws_link"));
    expect(await removeWorkspaceDir(nemaHome, "ws_link")).toBe(true);
    expect(existsSync(path.join(nemaHome, "ws", "ws_link"))).toBe(false);
    expect(readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  test("does nothing when <nemaHome>/ws is a symlink to somewhere else", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "nema-cleanup-"));
    const nemaHome = path.join(base, "home");
    const elsewhere = path.join(base, "elsewhere");
    mkdirSync(path.join(elsewhere, "ws_abc"), { recursive: true });
    mkdirSync(nemaHome, { recursive: true });
    symlinkSync(elsewhere, path.join(nemaHome, "ws"));
    expect(await removeWorkspaceDir(nemaHome, "ws_abc")).toBe(false);
    expect(await reconcileWorkspaceDirs(nemaHome, [])).toEqual([]);
    expect(existsSync(path.join(elsewhere, "ws_abc"))).toBe(true);
  });

  test("missing dirs are a no-op", async () => {
    const { nemaHome } = await setup();
    expect(await removeWorkspaceDir(nemaHome, "ws_missing")).toBe(false);
    expect(await removeWorkspaceDir(path.join(nemaHome, "nope"), "ws_missing")).toBe(false);
    expect(await reconcileWorkspaceDirs(path.join(nemaHome, "nope"), [])).toEqual([]);
  });
});

describe("reconcileWorkspaceDirs", () => {
  test("removes only workspace-shaped dirs that are not in the existing list", async () => {
    const { nemaHome } = await setup();
    const keep = wsDir(nemaHome, "ws_keep");
    const gone1 = wsDir(nemaHome, "ws_gone1");
    const gone2 = wsDir(nemaHome, "ws_gone-2");
    const other = path.join(nemaHome, "ws", "something-else");
    mkdirSync(other);
    writeFileSync(path.join(nemaHome, "ws", "notes.txt"), "n");
    const removed = await reconcileWorkspaceDirs(nemaHome, ["ws_keep", "ws_never_had_a_dir"]);
    expect(removed.sort()).toEqual(["ws_gone-2", "ws_gone1"]);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(gone1)).toBe(false);
    expect(existsSync(gone2)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(path.join(nemaHome, "ws", "notes.txt"))).toBe(true);
  });
});
