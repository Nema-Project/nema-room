import { SkillInstallOffer } from "@nema/shared";
import type { Db } from "./db/db.js";
import { DaemonRpcError, type DaemonRpc } from "./daemonRpc.js";
import { getMessage } from "./messages.js";
import { daemonHttpStatus, resolveExtensionSource } from "./plugins.js";
import { getTask } from "./tasks.js";

/** One reply offers a handful of skills at most; a longer list is not a choice anyone can review. */
export const MAX_SKILL_OFFERS = 5;
const MAX_SOURCE_LENGTH = 2000;

export const OFFER_NOTE =
  "Nothing was installed. The user sees this skill as a card under your reply and installs it only by pressing Install there. Do not say it is installed.";

type Outcome = { status: 200; body: { offer: SkillInstallOffer; note: string } } | { status: 400 | 403 | 404 | 409 | 502 | 503; body: { error: string } };

type PreviewSkill = { id: unknown; name: unknown; description: unknown; path: unknown; problem: unknown; target: unknown; installed: unknown };

const fail = (status: Exclude<Outcome["status"], 200>, error: string): Outcome => ({ status, body: { error } });

function listing(skills: PreviewSkill[]): string {
  return skills.map((skill) => `${String(skill.path)} (${String(skill.name)})`).join(", ") || "none";
}

/** Why a skill in the preview cannot be offered, or null when it can. */
function refusal(skill: PreviewSkill): string | null {
  if (skill.installed === true) return `${String(skill.id)} is already installed`;
  if (skill.problem !== null) return `${String(skill.path)} cannot be installed (${String(skill.problem)})`;
  if (typeof skill.id !== "string" || typeof skill.target !== "string") return `${String(skill.path)} cannot be installed`;
  return null;
}

/**
 * Resolve a source the user asked for and remember one of its skills as an offer on this task.
 *
 * The agent only proposes. The daemon pins the source exactly as it does for the Plugins page, and the
 * offer is that pinned preview; installing stays a request the user sends by pressing Install. A task
 * that no user message started (a system request, a coding agent's report) offers nothing, since text
 * from outside should not be able to put an install button in front of the user.
 */
export async function offerSkillInstall(db: Db, daemon: DaemonRpc, taskId: string, workspaceId: string, raw: unknown): Promise<Outcome> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "body must be an object with a string source");
  const { source, path } = raw as { source?: unknown; path?: unknown };
  if (typeof source !== "string" || source.trim() === "" || source.length > MAX_SOURCE_LENGTH) {
    return fail(400, `source must be a non-empty string of at most ${MAX_SOURCE_LENGTH} characters`);
  }
  if (path !== undefined && (typeof path !== "string" || path === "")) return fail(400, "path must be a non-empty string when given");

  const task = await getTask(db, taskId);
  const message = task && task.workspaceId === workspaceId ? await getMessage(db, task.messageId) : null;
  if (message?.role !== "user") return fail(403, "only a task started by the user's own message can offer to install a skill");

  const offered = await listSkillOffers(db, taskId);
  let preview: Record<string, unknown>;
  try {
    preview = await resolveExtensionSource(daemon, source.trim());
  } catch (error) {
    if (error instanceof DaemonRpcError) return fail(daemonHttpStatus(error.message) as 502 | 503, error.message);
    throw error;
  }
  const invalid = fail(502, "extensions.resolveSource returned an invalid result");
  if (!(preview.skills as unknown[]).every((item) => item !== null && typeof item === "object" && !Array.isArray(item))) return invalid;
  const skills = preview.skills as PreviewSkill[];
  let chosen: PreviewSkill | undefined;
  if (path !== undefined) {
    chosen = skills.find((skill) => skill.path === path);
    if (!chosen) return fail(404, `no skill at ${path}; this source has: ${listing(skills)}`);
    const why = refusal(chosen);
    if (why) return fail(409, why);
  } else {
    const open = skills.filter((skill) => refusal(skill) === null);
    if (open.length === 0) {
      return fail(409, `nothing to install here: ${skills.map((skill) => refusal(skill) ?? String(skill.path)).join("; ") || "no skills found"}`);
    }
    if (open.length > 1) return fail(409, `several skills are here; call again with path set to one of: ${listing(open)}`);
    chosen = open[0];
  }
  const parsed = SkillInstallOffer.safeParse({
    id: chosen!.id,
    name: chosen!.name,
    description: chosen!.description,
    source: source.trim(),
    repository: preview.repository,
    commit: preview.commit,
    path: chosen!.path,
    license: typeof preview.license === "string" ? preview.license : null,
    target: chosen!.target,
  });
  if (!parsed.success) return invalid;
  const offer = parsed.data;
  if (!offered.some((row) => row.id === offer.id) && offered.length >= MAX_SKILL_OFFERS) {
    return fail(409, `a reply can offer at most ${MAX_SKILL_OFFERS} skills`);
  }
  await db.query(
    `insert into task_skill_offers (task_id, skill_id, offer) values ($1, $2, $3::jsonb)
     on conflict (task_id, skill_id) do update set offer = excluded.offer`,
    [taskId, offer.id, JSON.stringify(offer)],
  );
  return { status: 200, body: { offer, note: OFFER_NOTE } };
}

export async function listSkillOffers(db: Db, taskId: string): Promise<SkillInstallOffer[]> {
  const rows = await db.query<{ offer: unknown }>(`select offer from task_skill_offers where task_id = $1 order by created_at, skill_id`, [taskId]);
  return rows.map((row) => SkillInstallOffer.parse(typeof row.offer === "string" ? JSON.parse(row.offer) : row.offer));
}

export async function clearSkillOffers(db: Db, taskId: string): Promise<void> {
  await db.query(`delete from task_skill_offers where task_id = $1`, [taskId]);
}
