import type { SkillAdapter, SkillGap, SkillNote, SkillRuntimeSupport, SkillUsage } from "@nema/shared";
import type { SkillMeta } from "./frontmatter.js";

// What a Skill needs that a runtime in Nema does not provide (spec §5). Judged from files and fields only.

export type SkillFileInfo = { path: string; executable: boolean; binary: boolean };

const INLINE_INJECTION = /!`[^`\n]+`/;
const FENCED_INJECTION = /^```!/m;

function runtimeSupport(adapter: SkillAdapter, missing: SkillGap[], notes: SkillNote[]): SkillRuntimeSupport {
  return { adapter, support: missing.length === 0 ? "full" : "partial", missing, notes };
}

export function skillUsage(input: {
  meta: SkillMeta;
  body: string;
  files: SkillFileInfo[];
  diagnostics: string[];
  claudeCodeOk: boolean;
  reservedSlash: boolean;
}): SkillUsage {
  const { meta, body, files } = input;
  const shared: SkillGap[] = [];
  if (files.some((file) => file.path.startsWith("scripts/") || file.executable)) shared.push("scripts");
  if (INLINE_INJECTION.test(body) || FENCED_INJECTION.test(body)) shared.push("shell-injection");
  if (meta.allowedTools !== null) shared.push("allowed-tools");
  if (meta.context === "fork" || meta.agent !== null) shared.push("subagent");
  if (meta.hooks) shared.push("hooks");
  if (meta.paths !== null) shared.push("paths");

  const codexMissing = [...shared];
  if (files.some((file) => file.binary)) codexMissing.push("binary-assets");
  if (body.includes("${CLAUDE_SKILL_DIR}")) codexMissing.push("skill-dir-variable");

  const slash: SkillNote[] = input.reservedSlash ? ["reserved-slash-name"] : [];
  const claudeNotes: SkillNote[] = [];
  if (meta.model !== null || meta.effort !== null) claudeNotes.push("model-override");
  claudeNotes.push("stop-not-enforced", ...slash);

  const claude: SkillRuntimeSupport = input.claudeCodeOk
    ? runtimeSupport("claude-code", shared, claudeNotes)
    : { adapter: "claude-code", support: "none", missing: ["claude-code-too-old"], notes: [] };

  return {
    runtimes: [claude, runtimeSupport("codex-direct", codexMissing, slash)],
    compatibility: meta.compatibility,
    diagnostics: input.diagnostics,
    invocation: meta.disableModelInvocation ? "user-only" : meta.userInvocable ? "model-and-user" : "model-only",
  };
}
