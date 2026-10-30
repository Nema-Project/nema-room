import { expect, test } from "vitest";
import { MIN_CLAUDE_SKILLS_VERSION, claudeSkillsSupported, parseClaudeVersion, versionAtLeast } from "../../src/skills/claudeVersion.js";

test("the version is the first x.y.z", () => {
  expect(parseClaudeVersion("2.1.309 (Claude Code)\n")).toBe("2.1.309");
  expect(parseClaudeVersion("Claude Code")).toBeNull();
  expect(MIN_CLAUDE_SKILLS_VERSION).toBe("2.1.309");
});

test("parts compare as numbers", () => {
  expect(versionAtLeast("2.1.309")).toBe(true);
  expect(versionAtLeast("2.1.308")).toBe(false);
  expect(versionAtLeast("2.0.999")).toBe(false);
  expect(versionAtLeast("2.10.0")).toBe(true);
  expect(versionAtLeast("3.0.0")).toBe(true);
});

test("claude --version runs once and its answer is kept", async () => {
  let runs = 0;
  const run = async () => {
    runs++;
    return "2.1.309 (Claude Code)";
  };
  expect(await claudeSkillsSupported(run)).toEqual({ ok: true, version: "2.1.309" });
  expect(await claudeSkillsSupported(run)).toEqual({ ok: true, version: "2.1.309" });
  expect(runs).toBe(1);
});

test("too old, unparseable or failing means not supported", async () => {
  expect(await claudeSkillsSupported(async () => "2.1.308 (Claude Code)")).toEqual({ ok: false, version: "2.1.308" });
  expect(await claudeSkillsSupported(async () => "Claude Code")).toEqual({ ok: false, version: null });
  expect(await claudeSkillsSupported(async () => Promise.reject(new Error("ENOENT")))).toEqual({ ok: false, version: null });
});
