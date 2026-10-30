import type { TaskEvent } from "@nema/shared";
import type { FunctionTool } from "../direct/transport.js";
import { codexCatalog } from "./catalog.js";
import { READ_SKILL, SkillReader, readSkillTool } from "./readSkill.js";
import type { SkillSnapshot, SnapshotSkill } from "./snapshot.js";
import { readRepoSkillFile, takeTaskSnapshot, type ProjectSkillRepo } from "./repoSkills.js";
import { manualSection, preloadSection, readSkillBody } from "./preload.js";

/** What a codex-direct task adds for Skills: the catalog after the hub prompt, `read_skill`, and its reader. */
export type DirectSkills = { instructions: string; tools: FunctionTool[]; reader: SkillReader | null; snapshot: SkillSnapshot };

/**
 * Takes the task's snapshot and builds the codex-direct pieces. With no listable Skill the prompt and the
 * tool list are exactly what they were before Skills existed. A snapshot that cannot be taken at all is
 * reported as progress and the task runs without Skills.
 */
export async function prepareDirectSkills(o: {
  nemaHome: string;
  prompt: string;
  /** The task's plugin tools; one named `read_skill` would clash, and then the task runs without Skills. */
  pluginToolNames?: string[];
  onEvent: (event: TaskEvent) => void;
  onActivated?: (id: string, revision: string) => Promise<void>;
  /** The thread's activated Skills, most recent first (`task.assign.retainedSkills`). */
  retained?: string[];
  /** Trusted repositories (`task.assign.projectSkills`). */
  projectSkills?: ProjectSkillRepo[];
  /** The Skill the user called with `/name` (`task.assign.manualSkill`). */
  manual?: { skillId: string; arguments: string };
}): Promise<DirectSkills> {
  let snapshot: SkillSnapshot;
  try {
    // Claude Code's version does not matter to codex-direct.
    snapshot = await takeTaskSnapshot({ nemaHome: o.nemaHome, claudeCodeOk: true, ...(o.projectSkills ? { projectSkills: o.projectSkills } : {}) });
  } catch (error) {
    o.onEvent({ type: "progress", text: `Skills 读取失败，本任务不使用 Skills：${error instanceof Error ? error.message : String(error)}` });
    return { instructions: o.prompt, tools: [], reader: null, snapshot: { skills: [], warnings: [] } };
  }
  if (snapshot.warnings.length > 0) o.onEvent({ type: "progress", text: `部分 Skill 未载入：${snapshot.warnings.join("；")}` });
  const catalog = codexCatalog(snapshot);
  const called = o.manual ? snapshot.skills.find((skill) => skill.id === o.manual!.skillId) : undefined;
  const clash = (catalog !== null || called !== undefined) && (o.pluginToolNames?.includes(READ_SKILL) ?? false);
  if (clash) o.onEvent({ type: "progress", text: `插件工具与 ${READ_SKILL} 同名，本任务不使用 Skills。` });
  // A Skill called by hand is readable even when the model may not pick it itself.
  const extraIds = called ? [called.id] : [];
  const tool = clash ? null : readSkillTool(snapshot, { listed: catalog?.listed ?? [], extraIds });
  const reader = tool
    ? new SkillReader({
        nemaHome: o.nemaHome,
        snapshot,
        listed: catalog?.listed ?? [],
        extraIds,
        readRepoFile: readRepoSkillFile,
        onRead: (text) => o.onEvent({ type: "tool_call", text }),
        onActivated: o.onActivated ?? (async () => {}),
      })
    : null;
  const readBody = (skill: SnapshotSkill) => readSkillBody(o.nemaHome, skill, readRepoSkillFile);
  const sections: string[] = [];
  if (catalog && reader) sections.push(catalog.text);
  if (o.manual) {
    // Called by hand: the body goes in whether or not read_skill is offered, and counts as one load.
    const manual = await manualSection({
      snapshot,
      manual: o.manual,
      readBody,
      ...(reader ? { more: (skill: SnapshotSkill, at: { offset: number }) => `剩下的部分用 ${READ_SKILL}（name: ${skill.id}, offset: ${at.offset}）读取。` } : {}),
    });
    sections.push(manual.text);
    if (manual.skill) {
      if (reader) reader.activated(manual.skill);
      else void (o.onActivated ?? (async () => {}))(manual.skill.id, manual.skill.revision).catch(() => {});
    }
  }
  if (reader && o.retained && o.retained.length > 0) {
    const preload = await preloadSection({ snapshot, retained: o.retained.filter((id) => id !== called?.id), readBody });
    for (const id of preload.loaded) reader.markLoaded(id);
    if (preload.text) sections.push(preload.text);
    if (preload.dropped.length > 0) o.onEvent({ type: "progress", text: `这些 Skill 放不下，没有预载：${preload.dropped.join("、")}` });
  }
  const instructions = sections.length > 0 ? `${o.prompt}\n\n${sections.join("\n\n")}` : o.prompt;
  return { instructions, tools: tool ? [tool] : [], reader, snapshot };
}
