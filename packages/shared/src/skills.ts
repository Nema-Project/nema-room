/** Skill types shared by the daemon, the hub and the web app (Skills progressive loading spec §1, §5, §9). */

export type SkillAdapter = "claude-code" | "codex-direct";

/** A capability a Skill relies on that the runtime does not provide in Nema. */
export type SkillGap =
  | "scripts"
  | "shell-injection"
  | "allowed-tools"
  | "subagent"
  | "hooks"
  | "paths"
  | "binary-assets"
  | "skill-dir-variable"
  | "claude-code-too-old";

/** Something the page should say about a Skill that is not a missing capability. */
export type SkillNote = "model-override" | "stop-not-enforced" | "reserved-slash-name";

/**
 * A static estimate for one runtime, read from the Skill's declared fields and files; Nema does not run
 * the Skill to confirm it. `missing` and `notes` are the evidence behind `support`.
 */
export type SkillRuntimeSupport = {
  adapter: SkillAdapter;
  support: "full" | "partial" | "none";
  missing: SkillGap[];
  notes: SkillNote[];
};

export type SkillInvocation = "model-and-user" | "user-only" | "model-only";

export type SkillUsage = {
  runtimes: SkillRuntimeSupport[];
  compatibility: string | null;
  diagnostics: string[];
  invocation: SkillInvocation;
};

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]$|^[a-z0-9]$/;

/** The Agent Skills `name` rule: 1-64 of `[a-z0-9-]`, no leading, trailing or doubled hyphen. */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name);
}

/** Built-in `/` commands of the composer (`apps/web/lib/slash.ts`); a Skill cannot take these over. */
export const RESERVED_SLASH_NAMES: readonly string[] = ["thread", "progress", "update"];

/** `/skill:<id>` always names a Skill, so a Skill whose id a built-in command takes is still callable. */
export const SKILL_SLASH_PREFIX = "skill:";

/** Built-in names, every `diagram:<type>` command, and the `skill:` prefix itself. */
export function isReservedSlashName(id: string): boolean {
  return RESERVED_SLASH_NAMES.includes(id) || id.startsWith("diagram:") || id.startsWith(SKILL_SLASH_PREFIX);
}

/** What the composer inserts for a Skill: `/<id>`, or `/skill:<id>` when the id is reserved. */
export function skillSlashCommand(id: string): string {
  return isReservedSlashName(id) ? `/${SKILL_SLASH_PREFIX}${id}` : `/${id}`;
}

// An external id: a Skill name, optionally after one `<repo slug>:` prefix; `/skill:` may come first.
const SEGMENT = "[a-z0-9]+(?:-[a-z0-9]+)*";
const MANUAL = new RegExp(`^/(${SKILL_SLASH_PREFIX})?(${SEGMENT}(?::${SEGMENT})?)(?:\\s+([\\s\\S]*))?$`);

/**
 * A message that starts with `/skill-id` or `/skill:skill-id`, with the rest as its arguments; `null` for
 * anything else. Without the prefix, built-in names stay with the built-in commands.
 */
export function parseManualSkill(content: string): { skillId: string; arguments: string } | null {
  const match = MANUAL.exec(content.trimStart());
  if (!match) return null;
  const skillId = match[2]!;
  // Each part follows the Skill name rule, 64 characters at most.
  if (!skillId.split(":").every(isSkillName)) return null;
  if (skillId.startsWith(SKILL_SLASH_PREFIX)) return null;
  if (!match[1] && isReservedSlashName(skillId)) return null;
  return { skillId, arguments: (match[3] ?? "").trim() };
}
