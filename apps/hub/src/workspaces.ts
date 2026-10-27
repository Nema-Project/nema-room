import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { KnowledgeStore } from "@nema/knowledge";
import { KNOWLEDGE_LANGUAGES, type KnowledgeLanguage } from "@nema/shared";
import type { Db } from "./db/db.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

export type Workspace = {
  id: string;
  name: string;
  confidential: boolean;
  knowledgeLanguage: KnowledgeLanguage;
  createdAt: string;
  archivedAt: string | null;
};

type Row = {
  id: string;
  name: string;
  confidential: boolean;
  knowledge_language: KnowledgeLanguage;
  created_at: Date | string;
  archived_at: Date | string | null;
};

const COLS = "id, name, confidential, knowledge_language, created_at, archived_at";
const ID_RE = /^ws_[A-Za-z0-9_-]{1,32}$/;

function toWorkspace(r: Row): Workspace {
  return {
    id: r.id,
    name: r.name,
    confidential: r.confidential,
    knowledgeLanguage: r.knowledge_language,
    createdAt: new Date(r.created_at).toISOString(),
    archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null,
  };
}

export function repoPath(dataDir: string, workspaceId: string): string {
  return path.join(dataDir, "repos", workspaceId);
}

function checkName(name: string): string {
  const n = name.trim();
  if (!n) throw new Error("workspace name must not be empty");
  return n;
}

function checkLanguage(l: string): KnowledgeLanguage {
  if (!(KNOWLEDGE_LANGUAGES as readonly string[]).includes(l)) throw new Error(`invalid knowledge language: ${l}`);
  return l as KnowledgeLanguage;
}

export async function createWorkspace(db: Db, dataDir: string, name: string, ownedHelpers?: OwnedHelperScope): Promise<Workspace> {
  const n = checkName(name);
  const id = `ws_${nanoid(12)}`;
  await new KnowledgeStore(repoPath(dataDir, id), ownedHelpers).init();
  const rows = await db.query<Row>(`insert into workspaces(id, name) values ($1, $2) returning ${COLS}`, [id, n]);
  return toWorkspace(rows[0]!);
}

export async function listWorkspaces(db: Db): Promise<Workspace[]> {
  const rows = await db.query<Row>(`select ${COLS} from workspaces order by created_at, id`);
  return rows.map(toWorkspace);
}

export async function getWorkspace(db: Db, id: string): Promise<Workspace | null> {
  const rows = await db.query<Row>(`select ${COLS} from workspaces where id = $1`, [id]);
  return rows[0] ? toWorkspace(rows[0]) : null;
}

export async function updateWorkspace(
  db: Db,
  id: string,
  patch: { name?: string; confidential?: boolean; knowledgeLanguage?: KnowledgeLanguage; archived?: boolean },
): Promise<Workspace> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (patch.name !== undefined) (params.push(checkName(patch.name)), sets.push(`name = $${params.length}`));
  if (patch.confidential !== undefined) (params.push(patch.confidential), sets.push(`confidential = $${params.length}`));
  if (patch.knowledgeLanguage !== undefined)
    (params.push(checkLanguage(patch.knowledgeLanguage)), sets.push(`knowledge_language = $${params.length}`));
  if (patch.archived === true) sets.push("archived_at = now()");
  if (patch.archived === false) sets.push("archived_at = null");
  if (sets.length === 0) {
    const cur = await getWorkspace(db, id);
    if (!cur) throw new Error(`workspace not found: ${id}`);
    return cur;
  }
  // Only a running task blocks archiving; queued tasks stay put and are not claimed while archived.
  const guard = patch.archived === true ? " and not exists (select 1 from tasks where workspace_id = $1 and status = 'running')" : "";
  const rows = await db.query<Row>(`update workspaces set ${sets.join(", ")} where id = $1${guard} returning ${COLS}`, params);
  if (!rows[0]) {
    if (!(await getWorkspace(db, id))) throw new Error(`workspace not found: ${id}`);
    throw new Error("workspace is busy");
  }
  return toWorkspace(rows[0]);
}

/**
 * Deletes a workspace and its knowledge repo. `nemaHome` (the daemon's `~/.nema`) is only passed when the
 * hub shares a filesystem with the daemon; otherwise (e.g. hub in a container) the daemon removes its own
 * `<nemaHome>/ws/<id>` when told via the `workspace.deleted` / `welcome` protocol messages.
 */
export async function deleteWorkspace(db: Db, dataDir: string, id: string, nemaHome?: string): Promise<void> {
  if (!ID_RE.test(id)) throw new Error("invalid workspace id");
  await db.tx(async (t) => {
    const locked = await t.query<{ id: string }>("select id from workspaces where id = $1 for update", [id]);
    if (!locked[0]) throw new Error(`workspace not found: ${id}`);
    // Only a running task blocks deletion; queued tasks (and their changes) are deleted below.
    const busy = await t.query("select 1 from tasks where workspace_id = $1 and status = 'running' limit 1", [id]);
    if (busy.length > 0) throw new Error("workspace is busy");
    await t.query("delete from task_changes where task_id in (select id from tasks where workspace_id = $1)", [id]);
    await t.query("delete from tasks where workspace_id = $1", [id]);
    await t.query("delete from question_threads where workspace_id = $1", [id]);
    await t.query("delete from threads where workspace_id = $1", [id]);
    await t.query("delete from messages where workspace_id = $1", [id]);
    await t.query("delete from entry_index where workspace_id = $1", [id]);
    await t.query("delete from evidence_events where workspace_id = $1", [id]);
    await t.query("delete from source_import_receipts where workspace_id = $1", [id]);
    await t.query("delete from source_freshness where workspace_id = $1", [id]);
    await t.query("delete from workspaces where id = $1", [id]);
  });
  await fs.rm(repoPath(dataDir, id), { recursive: true, force: true });
  if (nemaHome) await fs.rm(path.join(nemaHome, "ws", id), { recursive: true, force: true });
}
