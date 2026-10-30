import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ATTACHMENT_LIMITS } from "@nema/shared";

export type Snapshot = {
  schemaVersion: 1;
  appVersion: string;
  tableData: Record<string, Record<string, unknown>[]>;
  knowledgeManifest: KnowledgeManifestEntry[];
  settings?: { adapter?: "codex-direct" | "claude-code" | "codex" | "codex-cli"; model?: string; reasoningEffort?: "low" | "medium" | "high"; authMode?: "siwc" | "compat" | "byok"; byokBaseUrl?: string };
};

export type KnowledgeManifestEntry = {
  workspaceId: string;
  path: string;
  bundle: string;
  sha256: string;
  refs: Record<string, string>;
  head: string;
};

export const TABLE_COLUMNS = {
  workspaces: ["id", "name", "confidential", "knowledge_language", "created_at", "archived_at"],
  evidence_events: ["id", "workspace_id", "kind", "entry_id", "target_basis", "revision", "content_hash", "refs_hash", "snapshot_hash", "payload_hash", "actor", "created_at", "consumed_commit", "consumed_at", "consumable"],
  source_import_receipts: ["workspace_id", "provider", "resource_id", "revision_key", "content_hash", "entry_id", "phase", "knowledge_commit", "created_at"],
  source_freshness: ["workspace_id", "entry_id", "freshness", "checked_revision", "reason", "checked_at"],
  messages: ["id", "workspace_id", "role", "content", "meta", "task_id", "created_at", "seq", "edited_at", "thread_id"],
  threads: ["id", "workspace_id", "title", "opened_by", "last_read_seq", "created_at"],
  question_threads: ["workspace_id", "question_id", "thread_id"],
  tasks: ["id", "workspace_id", "message_id", "status", "run_token", "daemon_id", "error", "created_at", "started_at", "finished_at", "seq", "interruptions", "kind"],
  task_changes: ["task_id", "entry_id", "kind", "title", "op", "created_at"],
  entry_index: ["workspace_id", "entry_id", "kind", "title", "status", "priority", "business_date", "updated_at"],
  workspace_repos: ["id", "workspace_id", "path", "git_common_dir", "label", "main_branch", "has_origin", "remote_url", "last_main_sha", "last_fetch_at", "last_fetch_error", "created_at"],
  workspace_plugins: ["workspace_id", "plugin_id", "enabled", "disabled_functions", "settings"],
  plugin_calls: ["id", "task_id", "name", "args_summary", "ok", "result_bytes", "ms", "created_at"],
  diagram_status: ["workspace_id", "entry_id", "stale", "checked_sha"],
  repo_hooks: ["id", "repo_id", "agent", "branch", "head", "session_id", "at"],
  main_moves: ["id", "repo_id", "from_sha", "to_sha", "at", "handled"],
  message_versions: ["message_id", "version", "content", "created_at"],
  message_attachments: ["id", "workspace_id", "message_id", "kind", "mime", "name", "size", "sha256", "upload_key", "status", "created_at", "attached_at", "deleted_at"],
} as const;

/** Snapshots taken before this table existed still import. */
const OPTIONAL_TABLES = new Set<keyof typeof TABLE_COLUMNS>(["message_versions", "threads", "question_threads", "evidence_events", "source_import_receipts", "source_freshness", "message_attachments"]);

/** Same rules as AttachmentRefSchema and the message_attachments check constraints. */
const ATTACHMENT_KINDS: Record<string, { mimes: readonly string[]; maxBytes: number }> = {
  image: { mimes: ["image/png", "image/jpeg", "image/gif", "image/webp"], maxBytes: ATTACHMENT_LIMITS.imageBytes },
  pdf: { mimes: ["application/pdf"], maxBytes: ATTACHMENT_LIMITS.pdfBytes },
  text: { mimes: ["text/plain"], maxBytes: ATTACHMENT_LIMITS.textBytes },
};
const attachmentIdPattern = /^att_[A-Za-z0-9_-]{16}$/;
/** Rows whose bytes travel with the snapshot under attachments/<workspace>/<id>. */
export const attachmentHasFile = (row: Record<string, unknown>) => row.status === "staged" || row.status === "attached";

export const TABLE_ORDER = Object.keys(TABLE_COLUMNS) as (keyof typeof TABLE_COLUMNS)[];
const workspaceIdPattern = /^ws_[A-Za-z0-9_-]{1,32}$/;
const shaPattern = /^[0-9a-f]{40}$/i;
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));

export function validateSnapshot(value: unknown): Snapshot {
  if (!isObject(value) || Object.keys(value).some((key) => !["schemaVersion", "appVersion", "tableData", "knowledgeManifest", "settings"].includes(key)) || value.schemaVersion !== 1 || typeof value.appVersion !== "string" || !value.appVersion.trim() ||
      !isObject(value.tableData) || !Array.isArray(value.knowledgeManifest)) throw new Error("Invalid snapshot envelope");
  let settings: Snapshot["settings"];
  if (value.settings !== undefined) {
    if (!isObject(value.settings) || Object.keys(value.settings).some((key) => !["adapter", "model", "reasoningEffort", "authMode", "byokBaseUrl"].includes(key))) throw new Error("Snapshot contains unsafe settings");
    const s = value.settings;
    if (s.adapter !== undefined && !["codex-direct", "claude-code", "codex", "codex-cli"].includes(String(s.adapter))) throw new Error("Invalid adapter setting");
    if (s.model !== undefined && (typeof s.model !== "string" || !s.model.trim())) throw new Error("Invalid model setting");
    if (s.reasoningEffort !== undefined && !["low", "medium", "high"].includes(String(s.reasoningEffort))) throw new Error("Invalid reasoning setting");
    if (s.authMode !== undefined && !["siwc", "compat", "byok"].includes(String(s.authMode))) throw new Error("Invalid auth mode setting");
    if (s.byokBaseUrl !== undefined) {
      if (typeof s.byokBaseUrl !== "string") throw new Error("Invalid BYOK base URL setting");
      const url = new URL(s.byokBaseUrl);
      if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error("Invalid BYOK base URL setting");
    }
    settings = s as Snapshot["settings"];
  }
  const keys = Object.keys(value.tableData);
  if (keys.some((key) => !TABLE_ORDER.includes(key as keyof typeof TABLE_COLUMNS))) throw new Error("Snapshot contains an unknown or missing table");
  if (TABLE_ORDER.some((table) => !keys.includes(table) && !OPTIONAL_TABLES.has(table))) throw new Error("Snapshot contains an unknown or missing table");
  const tableData: Record<string, Record<string, unknown>[]> = {};
  for (const table of TABLE_ORDER) {
    const rows = value.tableData[table] ?? (OPTIONAL_TABLES.has(table) ? [] : undefined);
    if (!Array.isArray(rows)) throw new Error(`Snapshot table ${table} must be an array`);
    const allowed = TABLE_COLUMNS[table] as readonly string[];
    tableData[table] = rows.map((row, i) => {
      if (!isObject(row)) throw new Error(`Invalid ${table} row ${i}`);
      const columns = Object.keys(row);
      if (columns.some((column) => !allowed.includes(column))) throw new Error(`Snapshot table ${table} contains an unknown column`);
      return table === "messages" && row.thread_id === undefined ? { ...row, thread_id: null } : row;
    });
  }
  const workspaces = tableData.workspaces!;
  const ids = new Set<string>();
  for (const row of workspaces) {
    if (typeof row.id !== "string" || !workspaceIdPattern.test(row.id) || ids.has(row.id)) throw new Error("Invalid or duplicate workspace id");
    ids.add(row.id);
    if (typeof row.name !== "string" || !row.name.trim() || typeof row.confidential !== "boolean" || !["ja", "en", "zh", "follow"].includes(String(row.knowledge_language))) throw new Error("Invalid workspace fields");
  }
  const requireWorkspace = (row: Record<string, unknown>) => {
    if (typeof row.workspace_id !== "string" || !ids.has(row.workspace_id)) throw new Error("Snapshot contains a missing workspace reference");
  };
  const validHash = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
  for (const row of tableData.evidence_events!) {
    requireWorkspace(row);
    if (!["promote_basis", "confirm_revision", "confirm_entry"].includes(String(row.kind)) || row.actor !== "user" || typeof row.consumable !== "boolean" ||
        (row.target_basis != null && !["stated", "decided"].includes(String(row.target_basis))) ||
        (row.kind === "promote_basis" && row.target_basis == null) || (row.kind === "confirm_entry" && row.target_basis != null)) throw new Error("Invalid evidence event fields");
    if (![row.content_hash, row.refs_hash, row.payload_hash].every(validHash) || (row.snapshot_hash != null && !validHash(row.snapshot_hash))) throw new Error("Invalid evidence hash");
    if (row.kind === "confirm_revision" && row.snapshot_hash == null) throw new Error("confirm_revision requires a snapshot hash");
    if ((row.consumed_commit == null) !== (row.consumed_at == null)) throw new Error("Invalid consumed columns");
  }
  for (const row of tableData.source_import_receipts!) {
    requireWorkspace(row);
    if (!["reserved", "committed", "indexed"].includes(String(row.phase))) throw new Error("Invalid source import phase");
    if (!validHash(row.content_hash)) throw new Error("Invalid source import hash");
  }
  for (const row of tableData.source_freshness!) {
    requireWorkspace(row);
    if (!((row.freshness === "current" && row.reason === "match" && row.checked_revision != null) ||
          (row.freshness === "changed" && row.reason === "mismatch" && row.checked_revision != null) ||
          (row.freshness === "unavailable" && ["not_found", "forbidden"].includes(String(row.reason))) ||
          (row.freshness === "unknown" && ["offline", "timeout", "incomparable"].includes(String(row.reason))))) throw new Error("Invalid source freshness fields");
  }
  const messageIds = new Set<string>();
  for (const row of tableData.messages!) {
    if (typeof row.id !== "string" || messageIds.has(row.id) || typeof row.content !== "string" || !["user", "agent", "system", "report"].includes(String(row.role))) throw new Error("Invalid message row");
    messageIds.add(row.id);
    if (row.workspace_id !== null && row.workspace_id !== undefined) requireWorkspace(row);
  }
  const messagesById = new Map(tableData.messages!.map((row) => [String(row.id), row]));
  for (const row of tableData.messages!) {
    if (row.thread_id == null) continue;
    const anchor = messagesById.get(String(row.thread_id));
    if (!anchor) throw new Error("Snapshot contains a missing thread anchor message reference");
    if (anchor.thread_id != null) throw new Error("Snapshot thread anchors must be main-chat messages");
  }
  const threadIds = new Set<string>();
  for (const row of tableData.threads!) {
    if (typeof row.id !== "string" || !messageIds.has(row.id) || messagesById.get(row.id)?.thread_id != null || threadIds.has(row.id) || !["agent", "user", "grill"].includes(String(row.opened_by)) || typeof row.title !== "string") throw new Error("Invalid thread row");
    requireWorkspace(row);
    threadIds.add(row.id);
  }
  for (const row of tableData.question_threads!) {
    requireWorkspace(row);
    if (typeof row.question_id !== "string" || !threadIds.has(String(row.thread_id))) throw new Error("Snapshot contains a missing thread reference");
  }
  const taskIds = new Set<string>();
  for (const row of tableData.tasks!) {
    if (typeof row.id !== "string" || taskIds.has(row.id) || !["queued", "running", "done", "failed"].includes(String(row.status))) throw new Error("Invalid task row");
    taskIds.add(row.id);
    if (row.workspace_id !== null && row.workspace_id !== undefined) requireWorkspace(row);
    if (row.message_id !== null && row.message_id !== undefined && !messageIds.has(String(row.message_id))) throw new Error("Snapshot contains a missing message reference");
  }
  for (const row of tableData.message_versions!) {
    if (typeof row.message_id !== "string" || !messageIds.has(row.message_id)) throw new Error("Snapshot contains a missing message reference");
  }
  const attachmentIds = new Set<string>();
  for (const row of tableData.message_attachments!) {
    requireWorkspace(row);
    const kind = ATTACHMENT_KINDS[String(row.kind)];
    if (typeof row.id !== "string" || !attachmentIdPattern.test(row.id) || attachmentIds.has(row.id) || !kind || !kind.mimes.includes(String(row.mime)) ||
        typeof row.size !== "number" || !Number.isSafeInteger(row.size) || row.size <= 0 || row.size > kind.maxBytes || !/^[0-9a-f]{64}$/.test(String(row.sha256)) ||
        typeof row.name !== "string" || !row.name || typeof row.upload_key !== "string" || !["staged", "attached", "deleted", "missing"].includes(String(row.status)) ||
        (row.status === "staged") !== (row.message_id == null)) throw new Error("Invalid message attachment row");
    attachmentIds.add(row.id);
    if (row.message_id != null) {
      const message = messagesById.get(String(row.message_id));
      if (!message || message.workspace_id !== row.workspace_id) throw new Error("Snapshot contains a missing message reference (message_attachments)");
    }
  }
  for (const [table, rows] of Object.entries(tableData)) for (const row of rows) {
    if (["task_changes", "plugin_calls"].includes(table) && row.task_id && !taskIds.has(String(row.task_id))) throw new Error(`Snapshot contains a missing task reference (${table})`);
    if (["entry_index", "diagram_status"].includes(table)) requireWorkspace(row);
    if (table === "workspace_repos") {
      requireWorkspace(row);
      if (typeof row.remote_url === "string") {
        try { const url = new URL(row.remote_url); if (url.username || url.password) throw new Error("credential"); }
        catch { throw new Error("Snapshot repository remote contains credentials or is invalid"); }
      }
    }
  }
  const manifest = value.knowledgeManifest.map((item) => {
    if (!isObject(item) || typeof item.workspaceId !== "string" || !workspaceIdPattern.test(item.workspaceId) || !isObject(item.refs) ||
      typeof item.path !== "string" || item.path !== `repos/${item.workspaceId}` || typeof item.bundle !== "string" ||
      item.bundle !== `knowledge/${item.workspaceId}.bundle` || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256) ||
      typeof item.head !== "string" || !shaPattern.test(item.head)) throw new Error("Invalid knowledge manifest entry");
    for (const [ref, sha] of Object.entries(item.refs)) if (!/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..") || typeof sha !== "string" || !shaPattern.test(sha)) throw new Error("Invalid knowledge Git ref");
    return item as unknown as KnowledgeManifestEntry;
  });
  if (manifest.length !== ids.size || manifest.some((m) => !ids.has(m.workspaceId)) || new Set(manifest.map((m) => m.workspaceId)).size !== manifest.length) throw new Error("Knowledge manifest does not match workspaces");
  return { schemaVersion: 1, appVersion: value.appVersion, tableData, knowledgeManifest: manifest, ...(settings ? { settings } : {}) };
}

export function sha256(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }

export async function readSnapshot(sourceDir: string): Promise<Snapshot> {
  const root = await realpath(sourceDir);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Snapshot source must be a real directory");
  const entries = await readdir(root);
  if (entries.some((name) => !["snapshot.json", "knowledge", "attachments"].includes(name))) throw new Error("Snapshot has unexpected top-level entries");
  const snapshotFile = await lstat(join(root, "snapshot.json"));
  if (!snapshotFile.isFile() || snapshotFile.isSymbolicLink()) throw new Error("Snapshot file path is unsafe");
  const snapshot = validateSnapshot(JSON.parse(await readFile(join(root, "snapshot.json"), "utf8")));
  const knowledgeRoot = join(root, "knowledge");
  // A symlink or Windows junction here would let the bundles (and their hashes) come from outside the snapshot.
  const knowledgeInfo = snapshot.knowledgeManifest.length > 0 ? await lstat(knowledgeRoot) : null;
  if (knowledgeInfo && (!knowledgeInfo.isDirectory() || knowledgeInfo.isSymbolicLink())) throw new Error("Knowledge bundle path is unsafe");
  for (const item of snapshot.knowledgeManifest) {
    const file = join(knowledgeRoot, basename(item.bundle));
    const st = await lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || relative(knowledgeRoot, file).startsWith(`..${sep}`)) throw new Error("Knowledge bundle path is unsafe");
    const bytes = await readFile(file);
    if (sha256(bytes) !== item.sha256) throw new Error("Knowledge bundle hash mismatch");
  }
  await verifyAttachmentFiles(join(root, "attachments"), snapshot);
  return snapshot;
}

const realDirectory = async (dir: string) => {
  const st = await lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("Attachment path is unsafe");
};

/** Every staged or attached row has exactly one regular file with its size and hash, and nothing else is shipped. */
async function verifyAttachmentFiles(attachmentsRoot: string, snapshot: Snapshot): Promise<void> {
  const expected = new Map<string, Map<string, Record<string, unknown>>>();
  for (const row of snapshot.tableData.message_attachments ?? []) {
    if (!attachmentHasFile(row)) continue;
    const ws = String(row.workspace_id);
    if (!expected.has(ws)) expected.set(ws, new Map());
    expected.get(ws)!.set(String(row.id), row);
  }
  let present: string[];
  try { await realDirectory(attachmentsRoot); present = await readdir(attachmentsRoot); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (expected.size > 0) throw new Error("Snapshot attachment files are missing");
    return;
  }
  if (present.some((ws) => !expected.has(ws))) throw new Error("Snapshot has unexpected attachment entries");
  for (const [ws, rows] of expected) {
    const dir = join(attachmentsRoot, ws);
    await realDirectory(dir);
    const files = await readdir(dir);
    if (files.some((name) => !rows.has(name))) throw new Error("Snapshot has unexpected attachment entries");
    for (const [id, row] of rows) {
      const file = join(dir, id);
      const st = await lstat(file);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error("Attachment path is unsafe");
      const bytes = await readFile(file);
      if (bytes.length !== row.size || sha256(bytes) !== row.sha256) throw new Error("Attachment hash mismatch");
    }
  }
}
