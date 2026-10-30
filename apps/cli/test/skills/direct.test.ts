import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { TaskEvent } from "@nema/shared";
import { prepareDirectSkills } from "../../src/skills/direct.js";
import { managedSkill, skillText } from "./helpers.js";

let base: string;
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("a plugin tool named read_skill keeps its name; the task runs without Skills", async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "nema-direct-skills-")));
  const nemaHome = join(base, "nema");
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd") });
  const events: TaskEvent[] = [];
  const clash = await prepareDirectSkills({ nemaHome, prompt: "P", pluginToolNames: ["read_skill"], onEvent: (e) => events.push(e) });
  expect(clash).toMatchObject({ instructions: "P", tools: [], reader: null });
  expect(events).toEqual([{ type: "progress", text: "插件工具与 read_skill 同名，本任务不使用 Skills。" }]);
  const normal = await prepareDirectSkills({ nemaHome, prompt: "P", pluginToolNames: ["code__read"], onEvent: () => {} });
  expect(normal.tools.map((t) => t.name)).toEqual(["read_skill"]);
  expect(normal.reader).not.toBeNull();
});
