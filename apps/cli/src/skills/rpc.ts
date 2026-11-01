import { skillSlashCommand, type SkillUsage } from "@nema/shared";
import type { RpcRouter } from "../daemon/rpc.js";
import { claudeSkillsSupported } from "./claudeVersion.js";
import { takeTaskSnapshot, type ProjectSkillRepo } from "./repoSkills.js";

/** One Skill the user can call from the composer. `command` is what selecting it inserts. */
export type SkillCatalogRow = {
  id: string;
  name: string;
  description: string;
  command: string;
  invocation: SkillUsage["invocation"];
  runtimes: SkillUsage["runtimes"];
  /** Diagnostic codes only (`name-folder-mismatch`, …). No paths and no file contents. */
  diagnostics: string[];
  repoId: string | null;
};

function parseProjectSkills(params: unknown): ProjectSkillRepo[] {
  const list = (params as { projectSkills?: unknown } | null)?.projectSkills;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error("invalid skills params");
  return list.map((item) => {
    const r = item as Record<string, unknown> | null;
    const text = (key: string) => {
      const value = r?.[key];
      if (typeof value !== "string" || value === "") throw new Error("invalid skills params");
      return value;
    };
    const gitCommonDir = r?.gitCommonDir;
    if (gitCommonDir !== undefined && typeof gitCommonDir !== "string") throw new Error("invalid skills params");
    return { repoId: text("repoId"), label: text("label"), path: text("path"), mainBranch: text("mainBranch"), ...(gitCommonDir ? { gitCommonDir } : {}) };
  });
}

/** The Skills a user can call by hand, user-level and from the given trusted repositories, sorted by id. */
export async function skillCatalog(o: { nemaHome: string; projectSkills: ProjectSkillRepo[]; claudeCodeOk: boolean }): Promise<SkillCatalogRow[]> {
  const snapshot = await takeTaskSnapshot({ nemaHome: o.nemaHome, claudeCodeOk: o.claudeCodeOk, projectSkills: o.projectSkills });
  return snapshot.skills
    .filter((skill) => skill.usage.invocation !== "model-only")
    .map((skill) => ({
      id: skill.id,
      name: skill.meta.name,
      description: skill.meta.description,
      command: skillSlashCommand(skill.id),
      invocation: skill.usage.invocation,
      runtimes: skill.usage.runtimes,
      diagnostics: skill.usage.diagnostics,
      repoId: skill.repo?.repoId ?? null,
    }));
}

/** `skills.catalog`: what the composer's `/` menu offers. */
export function registerSkillHandlers(rpc: RpcRouter, nemaHome: string, o: { claudeSkillsOk?: () => Promise<boolean> } = {}): void {
  const claudeOk = o.claudeSkillsOk ?? (async () => (await claudeSkillsSupported()).ok);
  rpc.register("skills.catalog", async (params) => skillCatalog({ nemaHome, projectSkills: parseProjectSkills(params), claudeCodeOk: await claudeOk() }));
}
