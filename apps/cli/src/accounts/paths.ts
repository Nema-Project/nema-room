import { lstatSync } from "node:fs";
import path from "node:path";

/**
 * Path checks shared by the account store and the credential helpers.
 *
 * `openPrivateFile` already refuses a symlinked *file*, but a link anywhere above it would still move the
 * whole directory somewhere else and `rmSync` would then delete the target. Every component from
 * `nemaHome` itself down to the account directory is therefore checked.
 */

const SYMLINK_REASON = "账户凭据目录的上级目录是符号链接，已拒绝。";
const HOME_SYMLINK_REASON = "Nema 主目录是符号链接，已拒绝使用账户功能。";

/**
 * True when `nemaHome` itself, or any existing component between it and `target`, is a symlink.
 * `nemaHome` is included: a linked home would silently redirect every account file and every delete.
 */
export function hasSymlinkedComponent(nemaHome: string, target: string): boolean {
  try {
    if (lstatSync(nemaHome).isSymbolicLink()) return true;
  } catch (e) {
    // A home that does not exist yet is created as a real directory; anything else is not trusted.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return true;
  }
  const relative = path.relative(nemaHome, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return true; // outside the tree: never allowed
  let current = nemaHome;
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

/** Throws unless `nemaHome` and every component of `dir` under it are real directories (or still absent). */
export function assertNoSymlinkedComponent(nemaHome: string, dir: string): void {
  if (hasSymlinkedComponent(nemaHome, dir)) throw new Error(SYMLINK_REASON);
}

/** The same check for `nemaHome` itself, with a message that names the home directory. */
export function assertHomeNotSymlinked(nemaHome: string): void {
  try {
    if (lstatSync(nemaHome).isSymbolicLink()) throw new Error(HOME_SYMLINK_REASON);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
}
