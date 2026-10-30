import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ExtensionRecord } from "@nema/shared";
import { MANIFEST_FILE, gitBlobSha, loadManifest, revisionOf } from "../../src/skills/manifest.js";

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "nema-manifest-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const SKILL = "---\nname: x\ndescription: d\n---\nbody\n";

function folder(name: string): string {
  const root = join(base, name);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "SKILL.md"), SKILL);
  writeFileSync(join(root, "scripts", "run.sh"), "#!/bin/sh\n");
  writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  if (process.platform !== "win32") chmodSync(join(root, "scripts", "run.sh"), 0o755);
  return root;
}

const record = (o: Partial<ExtensionRecord>): ExtensionRecord => ({
  id: "x", kind: "skill", name: "x", summary: "d", source: "s", revision: "0123456789abcdef0123456789abcdef01234567",
  provision: "managed", installState: "installed", useState: "enabled", availability: "ready", externalPath: null, error: null, ...o,
});

test("gitBlobSha matches git hash-object", () => {
  // `git hash-object --stdin` of "hello\n" and of nothing
  expect(gitBlobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  expect(gitBlobSha(Buffer.alloc(0))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("a managed folder without a manifest gets one computed and saved", async () => {
  const root = folder("managed");
  const manifest = await loadManifest(root, "managed");
  expect(manifest.files.map((f) => f.path)).toEqual(["SKILL.md", "logo.png", "scripts/run.sh"]);
  expect(manifest.files[0]).toEqual({ path: "SKILL.md", size: SKILL.length, blob: gitBlobSha(Buffer.from(SKILL)), executable: false, binary: false });
  expect(manifest.files[1]).toMatchObject({ path: "logo.png", binary: true });
  expect(manifest.files[2]).toMatchObject({ path: "scripts/run.sh", executable: process.platform !== "win32" });
  expect(JSON.parse(readFileSync(join(root, MANIFEST_FILE), "utf8"))).toEqual(manifest);
  // A saved manifest is read back rather than recomputed.
  writeFileSync(join(root, "SKILL.md"), "changed");
  expect(await loadManifest(root, "managed")).toEqual(manifest);
});

test("an external folder is hashed every time and never written to", async () => {
  const root = folder("external");
  const first = await loadManifest(root, "external");
  expect(existsSync(join(root, MANIFEST_FILE))).toBe(false);
  writeFileSync(join(root, "SKILL.md"), "changed");
  const second = await loadManifest(root, "external");
  expect(second.files[0]!.blob).not.toBe(first.files[0]!.blob);
});

test.skipIf(process.platform === "win32")("links are left out of the manifest", async () => {
  const root = folder("links");
  symlinkSync("/etc/hostname", join(root, "link"));
  expect((await loadManifest(root, "external")).files.map((f) => f.path)).not.toContain("link");
});

test("an unreadable saved manifest is recomputed", async () => {
  const root = folder("broken");
  writeFileSync(join(root, MANIFEST_FILE), "{not json");
  expect((await loadManifest(root, "managed")).files).toHaveLength(3);
});

test("revisions", async () => {
  const root = folder("rev");
  const manifest = await loadManifest(root, "external");
  expect(revisionOf(record({}), manifest)).toBe("0123456789abcdef0123456789abcdef01234567");
  expect(revisionOf(record({ provision: "external", revision: "local" }), manifest)).toBe(`local@${gitBlobSha(Buffer.from(SKILL)).slice(0, 7)}`);
});
