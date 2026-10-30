import type { TaskEvent } from "@nema/shared";
import type { FunctionTool } from "../direct/transport.js";
import { codexCatalog } from "./catalog.js";
import { SkillReader, readSkillTool } from "./readSkill.js";
import { takeSnapshot, type SkillSnapshot } from "./snapshot.js";

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
  onEvent: (event: TaskEvent) => void;
  onActivated?: (id: string, revision: string) => Promise<void>;
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
  const tool = readSkillTool(snapshot);
  if (!catalog || !tool) return { instructions: o.prompt, tools: [], reader: null, snapshot };
  const reader = new SkillReader({
    nemaHome: o.nemaHome,
    snapshot,
    onRead: (text) => o.onEvent({ type: "tool_call", text }),
    onActivated: o.onActivated ?? (async () => {}),
  });
  return { instructions: `${o.prompt}\n\n${catalog.text}`, tools: [tool], reader, snapshot };
}
