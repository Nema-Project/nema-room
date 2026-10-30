import { expect, test } from "vitest";
import { RESERVED_SLASH_NAMES, isReservedSlashName, isSkillName, parseManualSkill } from "../src/index.js";

test("isSkillName follows the Agent Skills naming rules", () => {
  for (const ok of ["pdf-tools", "3d-print", "a", "a".repeat(64), "tdd"]) expect(isSkillName(ok)).toBe(true);
  for (const bad of ["-a", "a-", "a--b", "A", "a".repeat(65), "", "a_b", "a.b", "web:deploy"]) expect(isSkillName(bad)).toBe(false);
});

test("reserved slash names cover the built-in composer commands", () => {
  expect([...RESERVED_SLASH_NAMES]).toEqual(["thread", "progress", "update"]);
  for (const name of ["thread", "progress", "update", "diagram:flow", "diagram:architecture", "diagram:"]) expect(isReservedSlashName(name)).toBe(true);
  for (const name of ["tdd", "threads", "diagram", "web:deploy"]) expect(isReservedSlashName(name)).toBe(false);
});

test("parseManualSkill reads a leading /name and its arguments", () => {
  expect(parseManualSkill("/tdd 写个测试")).toEqual({ skillId: "tdd", arguments: "写个测试" });
  expect(parseManualSkill("  /web:deploy")).toEqual({ skillId: "web:deploy", arguments: "" });
  expect(parseManualSkill("/review\n第一行\n第二行  ")).toEqual({ skillId: "review", arguments: "第一行\n第二行" });
  expect(parseManualSkill("/3d-print now")).toEqual({ skillId: "3d-print", arguments: "now" });
});

test("parseManualSkill ignores everything that is not a leading skill call", () => {
  for (const text of ["说 /tdd", "/", "/Tdd", "/tdd/x", "/-x", "", "  ", "x/tdd", "/tdd:"]) {
    expect(parseManualSkill(text), text).toBeNull();
  }
});

test("parseManualSkill leaves built-in commands alone", () => {
  expect(parseManualSkill("/thread x")).toBeNull();
  expect(parseManualSkill("/progress")).toBeNull();
  expect(parseManualSkill("/diagram:flow")).toBeNull();
});

test("a / name with a part longer than 64 characters is not a Skill call", () => {
  expect(parseManualSkill(`/${"a".repeat(64)} x`)).toEqual({ skillId: "a".repeat(64), arguments: "x" });
  expect(parseManualSkill(`/${"a".repeat(65)} x`)).toBeNull();
  expect(parseManualSkill(`/web:${"a".repeat(65)}`)).toBeNull();
});
