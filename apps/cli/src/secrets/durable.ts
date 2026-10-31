import { closeSync, fsyncSync, openSync } from "node:fs";
import path from "node:path";
import { isWithin } from "../pathWithin.js";

/**
 * Flushes a directory entry (a rename, a create, a delete) to durable storage.
 *
 * A file's own fsync makes its bytes durable; the name it is reachable by lives in the directory, so a
 * credential copied into place is not safe from a power cut until its directory is synced too. Best
 * effort: Windows has no way to fsync a directory handle.
 */
export function fsyncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* not supported here (Windows): the rename itself is still atomic */
  }
}

/**
 * Flushes every directory entry created by a multi-level `mkdir` below `top`.
 *
 * Syncing only the deepest directory persists the name of the leaf inside its parent, not the parent's own
 * name: a power cut can then drop `secrets/` or `accounts/` and take the whole credential with it, even
 * though the file inside was synced. Each level from `top` down to `dir` is therefore synced, in order, so
 * every name that had to be created is on disk. `top` itself is included because creating its first child
 * changes its own entry.
 *
 * A `dir` that is not inside `top` (or is `top` itself) is synced on its own: there is no chain to walk,
 * and a caller that reached here with a path outside its root has a different bug to report. Containment is
 * the shared lexical rule (`isWithin`), so a directory named `..foo` inside `top` still gets its chain.
 */
export function fsyncPathChain(top: string, dir: string): void {
  if (!isWithin(top, dir)) {
    fsyncDirectory(dir);
    return;
  }
  const relative = path.relative(top, dir);
  fsyncDirectory(top);
  let current = top;
  for (const part of relative.split(path.sep).filter((part) => part !== "")) {
    current = path.join(current, part);
    fsyncDirectory(current);
  }
}
