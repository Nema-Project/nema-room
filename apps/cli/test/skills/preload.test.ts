import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openExtensionStore } from "../../src/extensions/store.js";
import { PRELOAD_HEADER, preloadSection, readSkillBody } from "../../src/skills/preload.js";
import { settleReports } from "../../src/skills/reports.js";
import { takeSnapshot } from "../../src/skills/snapshot.js";
import { COMMIT, managedSkill, skillText } from "./helpers.js";

let base: string;
let nemaHome: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "nema-preload-")));
  nemaHome = join(base, "nema");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const snapshot = () => takeSnapshot({ nemaHome, claudeCodeOk: true });
const readBody = (skill: Parameters<typeof readSkillBody>[1]) => readSkillBody(nemaHome, skill);

test("nothing retained, nothing preloaded", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd") });
  expect(await preloadSection({ snapshot: await snapshot(), retained: [], readBody })).toEqual({ text: null, loaded: [], dropped: [] });
});

test("a Skill switched off since is skipped; an upgraded one comes with its new body", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd", "d", "new body\n") });
  managedSkill(nemaHome, "pdf", { "SKILL.md": skillText("pdf") });
  openExtensionStore(join(nemaHome, "extensions")).setUseState("pdf", "disabled");
  const out = await preloadSection({ snapshot: await snapshot(), retained: ["pdf", "tdd"], readBody });
  expect(out.loaded).toEqual(["tdd"]);
  expect(out.dropped).toEqual([]);
  expect(out.text).toBe([PRELOAD_HEADER, `<skill_content name="tdd" revision="${COMMIT}">`, "new body\n", "</skill_content>"].join("\n"));
});

test("newest first, and the first that does not fit stops the list", async () => {
  for (const id of ["a1", "b2", "c3"]) managedSkill(nemaHome, id, { "SKILL.md": skillText(id, "d", "x".repeat(15 * 1024)) });
  const out = await preloadSection({ snapshot: await snapshot(), retained: ["c3", "a1", "b2"], readBody });
  expect(out.loaded).toEqual(["c3", "a1"]);
  expect(out.dropped).toEqual(["b2"]);
  expect(Buffer.byteLength(out.text!)).toBeLessThanOrEqual(32 * 1024);
});

test("a body changed after the snapshot is not preloaded", async () => {
  const root = managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd") });
  const snap = await snapshot();
  writeFileSync(join(root, "SKILL.md"), skillText("tdd", "d", "changed\n"));
  expect((await preloadSection({ snapshot: snap, retained: ["tdd"], readBody })).loaded).toEqual([]);
});

test("settleReports counts failures and gives up after the timeout", async () => {
  expect(await settleReports([Promise.resolve(), Promise.reject(new Error("x"))], 1000)).toEqual({ timedOut: false, failed: 1 });
  expect(await settleReports([new Promise(() => {})], 20)).toMatchObject({ timedOut: true });
});
