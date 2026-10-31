import { lstatSync } from "node:fs";
import path from "node:path";

/**
 * Path checks shared by the account store and the credential helpers.
 *
 * `openPrivateFile` already refuses a symlinked *file*, but a link anywhere above it would still move the
 * whole directory somewhere else and `rmSync` would then delete the target. Every component between
 * `nemaHome` and the account directory is therefore checked, and the account directory itself too.
 */

const SYMLINK_REASON = "账户凭据目录的上级目录是符号链接，已拒绝。";

/**
 * True when any existing component of `target` between `root` (exclusive) and `target` (inclusive) is a
 * symlink. Components that do not exist yet are skipped: they will be created as real directories.
 */
export function hasSymlinkedComponent(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return true; // outside the tree: never allowed
  let current = root;
  for (const part of relative.split(path.sep).filter((p) => p !== "")) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (e) {
      // A missing component cannot be a link; anything else (permissions, I/O) is not trusted either.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

/** Throws unless every component of `dir` under `root` is a real directory (or still absent). */
export function assertNoSymlinkedComponent(root: string, dir: string): void {
  if (hasSymlinkedComponent(root, dir)) throw new Error(SYMLINK_REASON);
}
