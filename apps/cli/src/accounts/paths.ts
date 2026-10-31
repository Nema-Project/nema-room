import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { isWithin } from "../pathWithin.js";

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
  // A lexical containment test, not `startsWith("..")`: a real directory whose name begins with two dots
  // (`nema/..foo`) is inside the tree, and treating it as outside skipped the walk below for it.
  if (!isWithin(nemaHome, target)) return true; // outside the tree: never allowed
  const relative = path.relative(nemaHome, target);
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

/**
 * Credential copies left under a retirement claim name: `<name>.retire-<pid>-<uuid>`.
 *
 * `removeLegacyIfUnchanged` moves the legacy file to such a name before deciding whether to delete it, and
 * restores it when the bytes turned out to be a newer credential. A crash — or a restore that failed
 * because the name was taken again — leaves the copy under the claim name, where nothing reads it: the
 * account has the credential, but the file is a duplicate of one sitting in a private directory.
 *
 * Only file *names* are returned, never their contents: the caller is a diagnostic that tells the user a
 * leftover exists, and the file may still hold a usable credential.
 */
export function strandedRetireClaims(nemaHome: string): string[] {
  // `<name>.retire-<pid>-<token>`: the pid is what makes each claim name unique per process. The token is
  // a uuid in practice, but the shape is all this check relies on — a stricter pattern would report nothing
  // for a claim written by an older build, which is exactly when the leftover most needs finding.
  const CLAIM = /^.+\.retire-\d+-[^/\\]+$/;
  let names: string[];
  try {
    names = readdirSync(nemaHome);
  } catch {
    return []; // no home yet: there is nothing stranded in it
  }
  return names
    .filter((name) => CLAIM.test(name) && isRegularFile(path.join(nemaHome, name)))
    .sort();
}

/** A claim is only reported when it is a plain file: a directory of that name holds no credential copy. */
function isRegularFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}
