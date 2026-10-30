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

test("a trusted repository's Skill is in the catalog and read from git", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  base = realpathSync(mkdtempSync(join(tmpdir(), "nema-direct-skills-")));
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".agents", "skills", "deploy"), { recursive: true });
  writeFileSync(join(repo, ".agents", "skills", "deploy", "SKILL.md"), skillText("deploy", "Ship it.", "# Deploy\n"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "x"]]) execFileSync("git", ["-C", repo, ...args], { env });
  const skills = await prepareDirectSkills({
    nemaHome: join(base, "nema"),
    prompt: "P",
    projectSkills: [{ repoId: "repo_1", label: "web", path: repo, mainBranch: "main" }],
    onEvent: () => {},
  });
  expect(skills.instructions).toContain("<skill><name>deploy</name><description>Ship it.</description></skill>");
  const out = await skills.reader!.read(JSON.stringify({ name: "deploy" }));
  expect(out).toMatch(/^<skill_content name="deploy" revision="web@[0-9a-f]{7}">\n# Deploy\n/);
});
