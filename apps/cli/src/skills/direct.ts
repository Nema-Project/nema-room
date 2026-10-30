import type { TaskEvent } from "@nema/shared";
import type { FunctionTool } from "../direct/transport.js";
import { codexCatalog } from "./catalog.js";
import { READ_SKILL, SkillReader, readSkillTool } from "./readSkill.js";
import { takeSnapshot, type SkillSnapshot } from "./snapshot.js";
import { preloadSection, readSkillBody } from "./preload.js";

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
}): Promise<DirectSkills> {
  let snapshot: SkillSnapshot;
  try {
    // Claude Code's version does not matter to codex-direct.
    snapshot = await takeSnapshot({ nemaHome: o.nemaHome, claudeCodeOk: true });
  } catch (error) {
    o.onEvent({ type: "progress", text: `Skills 读取失败，本任务不使用 Skills：${error instanceof Error ? error.message : String(error)}` });
    return { instructions: o.prompt, tools: [], reader: null, snapshot: { skills: [], warnings: [] } };
  }
  if (snapshot.warnings.length > 0) o.onEvent({ type: "progress", text: `部分 Skill 未载入：${snapshot.warnings.join("；")}` });
  const catalog = codexCatalog(snapshot);
  if (catalog && o.pluginToolNames?.includes(READ_SKILL)) {
    o.onEvent({ type: "progress", text: `插件工具与 ${READ_SKILL} 同名，本任务不使用 Skills。` });
    return { instructions: o.prompt, tools: [], reader: null, snapshot };
  }
  const tool = catalog ? readSkillTool(snapshot, { listed: catalog.listed }) : null;
  if (!catalog || !tool) return { instructions: o.prompt, tools: [], reader: null, snapshot };
  const reader = new SkillReader({
    nemaHome: o.nemaHome,
    snapshot,
    listed: catalog.listed,
    onRead: (text) => o.onEvent({ type: "tool_call", text }),
    onActivated: o.onActivated ?? (async () => {}),
  });
  let instructions = `${o.prompt}\n\n${catalog.text}`;
  if (o.retained && o.retained.length > 0) {
    const preload = await preloadSection({ snapshot, retained: o.retained, readBody: (skill) => readSkillBody(o.nemaHome, skill) });
    for (const id of preload.loaded) reader.markLoaded(id);
    if (preload.text) instructions += `\n\n${preload.text}`;
    if (preload.dropped.length > 0) o.onEvent({ type: "progress", text: `这些 Skill 放不下，没有预载：${preload.dropped.join("、")}` });
  }
  return { instructions, tools: [tool], reader, snapshot };
}
