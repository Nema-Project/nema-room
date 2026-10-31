import { closeSync, fsyncSync, openSync } from "node:fs";

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
