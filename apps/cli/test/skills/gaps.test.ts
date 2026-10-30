import { expect, test } from "vitest";
import type { SkillMeta } from "../../src/skills/frontmatter.js";
import { skillUsage, type SkillFileInfo } from "../../src/skills/gaps.js";

const meta = (extra: Partial<SkillMeta> = {}): SkillMeta => ({
  name: "x",
  description: "d",
  whenToUse: null,
  license: null,
  compatibility: null,
  metadata: {},
  allowedTools: null,
  disableModelInvocation: false,
  userInvocable: true,
  context: null,
  agent: null,
  hooks: false,
  paths: null,
  model: null,
  effort: null,
  ...extra,
});
const md: SkillFileInfo = { path: "SKILL.md", executable: false, binary: false };

function usage(o: { meta?: Partial<SkillMeta>; body?: string; files?: SkillFileInfo[]; claudeCodeOk?: boolean; reservedSlash?: boolean } = {}) {
  return skillUsage({
    meta: meta(o.meta),
    body: o.body ?? "Plain instructions.",
    files: o.files ?? [md],
    diagnostics: [],
    claudeCodeOk: o.claudeCodeOk ?? true,
    reservedSlash: o.reservedSlash ?? false,
  });
}
const runtime = (u: ReturnType<typeof usage>, adapter: "claude-code" | "codex-direct") => u.runtimes.find((r) => r.adapter === adapter)!;

test("a plain instruction Skill is fully usable in both runtimes", () => {
  const u = usage();
  expect(u).toEqual({
    runtimes: [
      { adapter: "claude-code", support: "full", missing: [], notes: ["stop-not-enforced"] },
      { adapter: "codex-direct", support: "full", missing: [], notes: [] },
    ],
    compatibility: null,
    diagnostics: [],
    invocation: "model-and-user",
  });
});

test("scripts: a scripts/ file or any executable file", () => {
  for (const files of [[md, { path: "scripts/run.py", executable: false, binary: false }], [md, { path: "tool.sh", executable: true, binary: false }]]) {
    const u = usage({ files });
    expect(runtime(u, "claude-code")).toMatchObject({ support: "partial", missing: ["scripts"] });
    expect(runtime(u, "codex-direct")).toMatchObject({ support: "partial", missing: ["scripts"] });
  }
});

test("shell injection, inline and fenced", () => {
  for (const body of ["Today is !`date`.", "```!\ngit status\n```"]) {
    expect(runtime(usage({ body }), "claude-code").missing).toEqual(["shell-injection"]);
    expect(runtime(usage({ body }), "codex-direct").missing).toEqual(["shell-injection"]);
  }
  expect(runtime(usage({ body: "Use `!important` in CSS" }), "codex-direct").missing).toEqual([]);
});

test("front matter features neither runtime provides", () => {
  expect(runtime(usage({ meta: { allowedTools: "Bash" } }), "codex-direct").missing).toEqual(["allowed-tools"]);
  expect(runtime(usage({ meta: { allowedTools: "Bash" } }), "claude-code").missing).toEqual(["allowed-tools"]);
  expect(runtime(usage({ meta: { context: "fork" } }), "claude-code").missing).toEqual(["subagent"]);
  expect(runtime(usage({ meta: { agent: "Explore" } }), "codex-direct").missing).toEqual(["subagent"]);
  expect(runtime(usage({ meta: { hooks: true } }), "claude-code").missing).toEqual(["hooks"]);
  expect(runtime(usage({ meta: { paths: ["src/**"] } }), "codex-direct").missing).toEqual(["paths"]);
});

test("binary assets and the Skill dir variable only fail under codex-direct", () => {
  const image = usage({ files: [md, { path: "assets/logo.png", executable: false, binary: true }] });
  expect(runtime(image, "codex-direct")).toMatchObject({ support: "partial", missing: ["binary-assets"] });
  expect(runtime(image, "claude-code")).toMatchObject({ support: "full", missing: [] });
  const dir = usage({ body: "Run ${CLAUDE_SKILL_DIR}/x" });
  expect(runtime(dir, "codex-direct").missing).toEqual(["skill-dir-variable"]);
  expect(runtime(dir, "claude-code").missing).toEqual([]);
});

test("model and effort overrides are a Claude Code note", () => {
  expect(runtime(usage({ meta: { model: "opus" } }), "claude-code").notes).toEqual(["model-override", "stop-not-enforced"]);
  expect(runtime(usage({ meta: { effort: "high" } }), "codex-direct").notes).toEqual([]);
});

test("Claude Code too old", () => {
  expect(runtime(usage({ claudeCodeOk: false, files: [md, { path: "scripts/a", executable: false, binary: false }] }), "claude-code")).toEqual({
    adapter: "claude-code",
    support: "none",
    missing: ["claude-code-too-old"],
    notes: [],
  });
});

test("reserved slash names and invocation", () => {
  const u = usage({ reservedSlash: true });
  expect(runtime(u, "claude-code").notes).toContain("reserved-slash-name");
  expect(runtime(u, "codex-direct").notes).toEqual(["reserved-slash-name"]);
  expect(usage({ meta: { disableModelInvocation: true } }).invocation).toBe("user-only");
  expect(usage({ meta: { userInvocable: false } }).invocation).toBe("model-only");
});

test("scripts and an image together", () => {
  const u = usage({ files: [md, { path: "scripts/a.py", executable: true, binary: false }, { path: "a.png", executable: false, binary: true }] });
  expect(runtime(u, "codex-direct").missing).toEqual(["scripts", "binary-assets"]);
  expect(runtime(u, "claude-code").missing).toEqual(["scripts"]);
});

test("compatibility and diagnostics pass through", () => {
  const u = skillUsage({ meta: meta({ compatibility: "python3" }), body: "", files: [md], diagnostics: ["name-folder-mismatch"], claudeCodeOk: true, reservedSlash: false });
  expect(u).toMatchObject({ compatibility: "python3", diagnostics: ["name-folder-mismatch"] });
});
