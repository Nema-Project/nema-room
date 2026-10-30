import { mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openExtensionStore } from "../../src/extensions/store.js";
import { readSnapshotFile, stillReadable, takeSnapshot } from "../../src/skills/snapshot.js";
import { COMMIT, externalSkill, managedSkill, skillText } from "./helpers.js";

let base: string;
let nemaHome: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "nema-snapshot-")));
  nemaHome = join(base, "nema");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const store = () => openExtensionStore(join(nemaHome, "extensions"));

test("enabled managed and external Skills are in the snapshot", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd"), "scripts/run.sh": "x" });
  externalSkill(nemaHome, "notes", join(base, "notes"), { "SKILL.md": skillText("notes") });
  const snapshot = await takeSnapshot({ nemaHome, claudeCodeOk: true });
  expect(snapshot.warnings).toEqual([]);
  expect(snapshot.skills.map((s) => [s.id, s.source, s.revision])).toEqual([
    ["notes", "external", expect.stringMatching(/^local@[0-9a-f]{7}$/)],
    ["tdd", "managed", COMMIT],
  ]);
  const tdd = snapshot.skills.find((s) => s.id === "tdd")!;
  expect(tdd).toMatchObject({ recordId: "tdd", repo: null, meta: { name: "tdd", description: "Does tdd things." } });
  expect(tdd.usage.runtimes.find((r) => r.adapter === "codex-direct")?.missing).toEqual(["scripts"]);
});

test("disabled, installing, damaged and bundled entries are left out", async () => {
  managedSkill(nemaHome, "off", { "SKILL.md": skillText("off") }, { useState: "disabled" });
  managedSkill(nemaHome, "busy", { "SKILL.md": skillText("busy") }, { installState: "installing" });
  managedSkill(nemaHome, "broken", { "SKILL.md": skillText("broken") }, { availability: "damaged" });
  const snapshot = await takeSnapshot({ nemaHome, claudeCodeOk: true });
  expect(snapshot.skills).toEqual([]);
});

test("a SKILL.md that cannot be parsed is a warning, not a Skill", async () => {
  managedSkill(nemaHome, "bad", { "SKILL.md": "no front matter" });
  managedSkill(nemaHome, "good", { "SKILL.md": skillText("good") });
  const snapshot = await takeSnapshot({ nemaHome, claudeCodeOk: true });
  expect(snapshot.skills.map((s) => s.id)).toEqual(["good"]);
  expect(snapshot.warnings).toEqual([expect.stringContaining("bad")]);
});

test("disabling a Skill makes it unreadable", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd") });
  const [skill] = (await takeSnapshot({ nemaHome, claudeCodeOk: true })).skills;
  expect(await stillReadable(nemaHome, skill!)).toBe(true);
  store().setUseState("tdd", "disabled");
  expect(await stillReadable(nemaHome, skill!)).toBe(false);
  expect(await readSnapshotFile(nemaHome, skill!, "SKILL.md", 1024)).toEqual({ ok: false, reason: "gone" });
});

test.skipIf(process.platform === "win32")("an external folder swapped for a link is no longer readable", async () => {
  const folder = externalSkill(nemaHome, "notes", join(base, "notes"), { "SKILL.md": skillText("notes") });
  const [skill] = (await takeSnapshot({ nemaHome, claudeCodeOk: true })).skills;
  renameSync(folder, join(base, "moved"));
  symlinkSync(join(base, "moved"), folder);
  expect(await stillReadable(nemaHome, skill!)).toBe(false);
});

test("a file changed after the snapshot is refused; a file not in the manifest is refused", async () => {
  const root = managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd"), "references/a.md": "one" });
  const [skill] = (await takeSnapshot({ nemaHome, claudeCodeOk: true })).skills;
  expect(await readSnapshotFile(nemaHome, skill!, "references/a.md", 1024)).toMatchObject({ ok: true, bytes: Buffer.from("one") });
  writeFileSync(join(root, "references", "a.md"), "two");
  expect(await readSnapshotFile(nemaHome, skill!, "references/a.md", 1024)).toEqual({ ok: false, reason: "changed" });
  writeFileSync(join(root, "new.md"), "x");
  expect(await readSnapshotFile(nemaHome, skill!, "new.md", 1024)).toEqual({ ok: false, reason: "not-in-skill" });
  expect(await readSnapshotFile(nemaHome, skill!, "../x", 1024)).toEqual({ ok: false, reason: "outside" });
});

test("Claude Code too old marks every Skill", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd") });
  const [skill] = (await takeSnapshot({ nemaHome, claudeCodeOk: false })).skills;
  expect(skill!.usage.runtimes[0]).toMatchObject({ adapter: "claude-code", support: "none" });
});
