import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openExtensionStore } from "../../src/extensions/store.js";
import { MANUAL_BYTES, MANUAL_HEADER, PRELOAD_HEADER, manualSection, preloadSection, readSkillBody } from "../../src/skills/preload.js";
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

describe("manualSection", () => {
  const manual = (skillId: string, args = "") => ({ skillId, arguments: args });

  test("$ARGUMENTS takes the arguments, every occurrence", async () => {
    managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd", "d", "Write tests for $ARGUMENTS.\nThen run $ARGUMENTS again.\n") });
    const out = await manualSection({ snapshot: await snapshot(), manual: manual("tdd", "the parser"), readBody });
    expect(out.skill?.id).toBe("tdd");
    expect(out.text).toBe([MANUAL_HEADER, `<skill_content name="tdd" revision="${COMMIT}">`, "Write tests for the parser.\nThen run the parser again.\n", "</skill_content>"].join("\n"));
  });

  test("without a placeholder the arguments go on a last line; no arguments, no line", async () => {
    managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd", "d", "Body.\n") });
    const snap = await snapshot();
    expect((await manualSection({ snapshot: snap, manual: manual("tdd", "x y"), readBody })).text).toContain("Body.\n\nARGUMENTS: x y\n</skill_content>");
    expect((await manualSection({ snapshot: snap, manual: manual("tdd"), readBody })).text).not.toContain("ARGUMENTS");
  });

  test("a Skill the model may not invoke can still be called by hand", async () => {
    managedSkill(nemaHome, "deploy", { "SKILL.md": skillText("deploy", "d", "Ship.\n", "disable-model-invocation: true\n") });
    const out = await manualSection({ snapshot: await snapshot(), manual: manual("deploy"), readBody });
    expect(out.skill?.id).toBe("deploy");
    expect(out.text).toContain("Ship.");
  });

  test("a missing or switched-off Skill becomes a note, not a failure", async () => {
    managedSkill(nemaHome, "pdf", { "SKILL.md": skillText("pdf") });
    openExtensionStore(join(nemaHome, "extensions")).setUseState("pdf", "disabled");
    const snap = await snapshot();
    for (const id of ["pdf", "nope"]) {
      const out = await manualSection({ snapshot: snap, manual: manual(id, "a"), readBody });
      expect(out.skill).toBeNull();
      expect(out.text).toContain(`用户调用的 Skill /${id} 不存在或已停用`);
    }
  });

  test("a body over 48 KB is cut on a character boundary with a way to read on", async () => {
    managedSkill(nemaHome, "big", { "SKILL.md": skillText("big", "d", "字".repeat(20 * 1024)) });
    const out = await manualSection({ snapshot: await snapshot(), manual: manual("big", "go"), readBody, more: (skill, at) => `用 read_skill（name: ${skill.id}, offset: ${at.offset}）读剩下的部分。` });
    const cut = Math.floor(MANUAL_BYTES / 3) * 3;
    expect(out.text).toContain(`${"字".repeat(cut / 3)}\n\nARGUMENTS: go`);
    expect(out.text).not.toContain("字".repeat(cut / 3 + 1));
    expect(out.text).toContain(`正文超过 48 KB，这里只附了前 ${cut} 字节。用 read_skill（name: big, offset: ${cut}）读剩下的部分。`);
  });

  test("the manual section sits apart from the 32 KB a thread's Skills get", async () => {
    managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd", "d", "x".repeat(40 * 1024)) });
    managedSkill(nemaHome, "pdf", { "SKILL.md": skillText("pdf", "d", "y".repeat(30 * 1024)) });
    const snap = await snapshot();
    const called = await manualSection({ snapshot: snap, manual: manual("tdd"), readBody });
    const kept = await preloadSection({ snapshot: snap, retained: ["pdf"], readBody });
    expect(called.text).toContain("x".repeat(40 * 1024));
    expect(kept.loaded).toEqual(["pdf"]);
  });
});
