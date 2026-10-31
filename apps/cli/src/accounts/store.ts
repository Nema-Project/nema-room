import { closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { AccountsFileSchema, IMPLICIT_ACCOUNT_ID, validateAccountsFile, type AccountsFile } from "./schema.js";
import { assertHomeNotSymlinked, assertNoSymlinkedComponent, hasSymlinkedComponent } from "./paths.js";
import { openPrivateFile, privateModeMatches, protectPrivatePath } from "../secrets/permissions.js";

/**
 * `<nemaHome>/accounts.json` holds account metadata and the workspace/thread bindings. It never holds a
 * credential: those live under `secrets/accounts/<id>/` (spec 2026-10-31 §2.2, D-1).
 */

export const accountsPath = (nemaHome: string): string => path.join(nemaHome, "accounts.json");

const ACCOUNT_ID = /^acct_[a-z0-9]{10}$/;

/**
 * The account's credential directory. The id is re-checked so a stored value cannot escape `secrets/`,
 * the reserved implicit id is refused (it only ever names the synthesized account, whose files stay at
 * the legacy paths), and no component under `nemaHome` may be a symlink.
 */
export function accountDir(nemaHome: string, accountId: string): string {
  if (!ACCOUNT_ID.test(accountId)) throw new Error("账户 id 不合法");
  if (accountId === IMPLICIT_ACCOUNT_ID) throw new Error("保留的账户 id 不能用作凭据目录");
  const dir = path.join(nemaHome, "secrets", "accounts", accountId);
  assertNoSymlinkedComponent(nemaHome, dir);
  return dir;
}

export type AccountsRead =
  | { status: "ok"; file: AccountsFile }
  | { status: "missing" }
  | { status: "unusable"; reason: "symlink" | "mode" | "owner" | "corrupt" | "invalid"; problems?: string[] };

/** A private file is also this user's file: a foreign 0600 file is not a credential we should trust. */
function ownerMatches(st: { uid?: number }, uid: number | null = process.getuid?.() ?? null): boolean {
  if (uid === null) return true; // no POSIX ownership on this platform
  return st.uid === undefined || st.uid === uid;
}

/**
 * Never throws: the settings page has to show why the file cannot be used. `invalid` means the rows
 * contradict each other (duplicate names or ids, a missing baseUrl, a binding to an absent account).
 */
export function readAccounts(nemaHome: string): AccountsRead {
  const file = accountsPath(nemaHome);
  // A linked home means the file we would read is somebody else's; treat the whole layout as untrusted.
  if (hasSymlinkedComponent(nemaHome, file)) return { status: "unusable", reason: "symlink" };
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return { status: "unusable", reason: "symlink" };
    if (!privateModeMatches(stat)) return { status: "unusable", reason: "mode" };
    if (!ownerMatches(stat)) return { status: "unusable", reason: "owner" };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "unusable", reason: "corrupt" };
  }

  let raw: string;
  try {
    // O_NOFOLLOW: a symlink swapped in after lstat neither redirects nor hangs the open, and fstat
    // re-checks the file actually opened.
    const fd = openPrivateFile(file);
    try {
      // Re-check the file actually opened, not just the one lstat named.
      const opened = fstatSync(fd);
      if (!privateModeMatches(opened)) return { status: "unusable", reason: "mode" };
      if (!ownerMatches(opened)) return { status: "unusable", reason: "owner" };
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return { status: "unusable", reason: "corrupt" };
  }

  let parsed: AccountsFile;
  try {
    parsed = AccountsFileSchema.parse(JSON.parse(raw));
  } catch {
    return { status: "unusable", reason: "corrupt" };
  }
  const problems = validateAccountsFile(parsed);
  if (problems.length > 0) return { status: "unusable", reason: "invalid", problems };
  return { status: "ok", file: parsed };
}

/**
 * Validates first, then writes atomically (exclusive 0600 temp file, fsync, rename) under a 0700
 * directory. A refused write leaves the existing file exactly as it was.
 */
export function writeAccounts(nemaHome: string, file: AccountsFile): void {
  const problems = validateAccountsFile(file);
  if (problems.length > 0) throw new Error(problems.join("；"));

  // Before mkdir: creating `nemaHome` through a link would write somewhere the user did not name.
  assertHomeNotSymlinked(nemaHome);
  mkdirSync(nemaHome, { recursive: true, mode: 0o700 });
  protectPrivatePath(nemaHome, 0o700);
  const target = accountsPath(nemaHome);
  assertNoSymlinkedComponent(nemaHome, target);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      writeSync(fd, JSON.stringify(file, null, 2) + "\n");
      // Without this an acknowledged write can be lost when the machine loses power after the rename.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    protectPrivatePath(tmp, 0o600);
    renameSync(tmp, target);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw e;
  }
  try {
    const dfd = openSync(nemaHome, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* directory fsync is best effort: Windows has no equivalent */
  }
}
