// Removes the daemon's per-workspace isolation dirs (`<nemaHome>/ws/<id>`, see codex/isolation.ts) for
// workspaces the hub no longer has. The hub may run in a container that cannot see the host's ~/.nema,
// so the daemon cleans up itself when the hub says so (`workspace.deleted`, or the id list in `welcome`).
//
// Safety: only names matching the hub's workspace-id pattern are touched, only directly inside
// `<nemaHome>/ws/`, `<nemaHome>/ws` itself must be a real directory (not a symlink), and symlinks are
// never followed (fs.rm removes a link itself, and recursive removal does not descend into links).
import fs from "node:fs/promises";
import path from "node:path";

export const WORKSPACE_ID_RE = /^ws_[A-Za-z0-9_-]{1,32}$/;

/** `<nemaHome>/ws` if it is a real directory (not a symlink to somewhere else), otherwise null. */
async function wsRoot(nemaHome: string): Promise<string | null> {
  const root = path.join(nemaHome, "ws");
  try {
    const st = await fs.lstat(root);
    return st.isDirectory() && !st.isSymbolicLink() ? root : null;
  } catch {
    return null;
  }
}

/** Removes `<nemaHome>/ws/<id>`. Returns whether something was removed; invalid ids are ignored. */
export async function removeWorkspaceDir(nemaHome: string, workspaceId: string): Promise<boolean> {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return false;
  const root = await wsRoot(nemaHome);
  if (!root) return false;
  const target = path.join(root, workspaceId);
  if (path.dirname(target) !== root) return false; // defence in depth; the pattern already forbids separators
  try {
    await fs.lstat(target);
  } catch {
    return false;
  }
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

/** Removes the isolation dirs of every workspace not in `existingIds`. Returns the removed ids. */
export async function reconcileWorkspaceDirs(nemaHome: string, existingIds: Iterable<string>): Promise<string[]> {
  const root = await wsRoot(nemaHome);
  if (!root) return [];
  const keep = new Set(existingIds);
  const removed: string[] = [];
  for (const name of await fs.readdir(root)) {
    if (keep.has(name) || !WORKSPACE_ID_RE.test(name)) continue;
    if (await removeWorkspaceDir(nemaHome, name)) removed.push(name);
  }
  return removed;
}
