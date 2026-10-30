import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { resetRepoFetchTimes } from "../../src/skills/repoSkills.js";
import { registerSkillHandlers } from "../../src/skills/rpc.js";
import { managedSkill, skillText } from "./helpers.js";

let base: string;
let nemaHome: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "nema-skill-rpc-")));
  nemaHome = join(base, "nema");
  resetRepoFetchTimes();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

async function call(params: unknown) {
  const rpc = new RpcRouter();
  registerSkillHandlers(rpc, nemaHome, { claudeSkillsOk: async () => true });
  return rpc.handle({ type: "rpc.request", id: "1", method: "skills.catalog", params });
}

test("lists what the user can call: model-only Skills are left out, a built-in name gets /skill:", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd", "Test first.") });
  managedSkill(nemaHome, "deploy", { "SKILL.md": skillText("deploy", "Ship.", "x\n", "disable-model-invocation: true\n") });
  managedSkill(nemaHome, "helper", { "SKILL.md": skillText("helper", "Background.", "x\n", "user-invocable: false\n") });
  managedSkill(nemaHome, "thread", { "SKILL.md": skillText("thread", "Threads.") });
  const out = await call({});
  expect(out).toMatchObject({ ok: true });
  const rows = (out as { result: Array<Record<string, unknown>> }).result;
  expect(rows.map((r) => [r.id, r.command, r.invocation, r.repoId])).toEqual([
    ["deploy", "/deploy", "user-only", null],
    ["tdd", "/tdd", "model-and-user", null],
    ["thread", "/skill:thread", "model-and-user", null],
  ]);
  expect(rows[1]).toMatchObject({ name: "tdd", description: "Test first." });
  expect((rows[1]!.runtimes as Array<{ adapter: string }>).map((r) => r.adapter).sort()).toEqual(["claude-code", "codex-direct"]);
});

test("a trusted repository's Skills come with their repo id and prefix", async () => {
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd") });
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".agents", "skills", "tdd"), { recursive: true });
  writeFileSync(join(repo, ".agents", "skills", "tdd", "SKILL.md"), skillText("tdd", "Repo TDD."));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "x"]]) execFileSync("git", ["-C", repo, ...args], { env });
  const out = (await call({ projectSkills: [{ repoId: "repo_1", label: "web", path: repo, mainBranch: "main" }] })) as { result: Array<Record<string, unknown>> };
  expect(out.result.map((r) => [r.id, r.command, r.repoId])).toEqual([
    ["tdd", "/tdd", null],
    ["web:tdd", "/skill:web:tdd", "repo_1"],
  ]);
});

test("malformed params are an error", async () => {
  expect(await call({ projectSkills: "x" })).toMatchObject({ ok: false, error: "invalid skills params" });
  expect(await call({ projectSkills: [{ repoId: "r" }] })).toMatchObject({ ok: false, error: "invalid skills params" });
});
