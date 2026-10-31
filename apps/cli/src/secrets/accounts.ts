import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { accountDir } from "../accounts/store.js";
import { holdsAccountsLock, withAccountsLock } from "../accounts/lock.js";
import { protectPrivatePath } from "./permissions.js";
import { fsyncDirectory, fsyncPathChain } from "./durable.js";
import { readSecretLine, saveSecretLine } from "./file.js";

/**
 * One credential file per account directory, written with the same private-file helpers the single-key
 * setup already used: an exclusive 0600 temp file, fsync, rename, and a 0700 directory. Nothing here
 * reads a value back except `readAccountSecret`, and no message ever includes one.
 *
 * Saves take the accounts lock. The migration of the first edit copies the legacy credential into an
 * account directory and then retires the legacy file; a save for that same account running in between
 * could be overwritten by the copy and lost. Holding the same lock makes the two orders strictly serial.
 *
 * Everything that touches the directory happens inside that lock: resolving it (which asserts that no
 * component is a symlink), the write or delete, and the permission tightening. Resolving it outside would
 * check one path and use whatever the name means a moment later.
 */

export type AccountSecretKind = "key" | "token";

const FILE_NAME: Record<AccountSecretKind, string> = { key: "key", token: "token" };

const MISSING = "没有这个账户的凭据。请在设置页重新填写。";
const INVALID = "账户凭据文件内容无效，或权限不是私有的。请重新填写。";

export function accountSecretPath(nemaHome: string, accountId: string, kind: AccountSecretKind): string {
  return path.join(accountDir(nemaHome, accountId), FILE_NAME[kind]);
}

/**
 * Runs `fn` under the accounts lock, or directly when this process already holds it: a caller inside the
 * lock (a migration) must not wait for the lock it is holding, and the critical section it is already in
 * is exactly the one this function needs. Same rule as `writeAccounts` in `store.ts`.
 */
function withAccountsLockUnlessHeld<T>(nemaHome: string, fn: () => T): T {
  return holdsAccountsLock(nemaHome) ? fn() : withAccountsLock(nemaHome, fn);
}

export function saveAccountSecret(nemaHome: string, accountId: string, kind: AccountSecretKind, value: string): void {
  withAccountsLockUnlessHeld(nemaHome, () => {
    // Resolved inside the lock: the symlink assertion in `accountDir` has to describe the path that is
    // actually written, not one that was checked before a peer had a chance to swap a component.
    const dir = accountDir(nemaHome, accountId);
    const file = path.join(dir, FILE_NAME[kind]);
    // `saveSecretLine` creates the directory (0700) when it is missing. Whether it did is recorded first:
    // a directory chain created by this call needs every one of its names synced, not just the deepest.
    const created = !existsSync(dir);
    saveSecretLine(file, value);
    // `saveSecretLine` fsyncs the file; the directory entry the rename created lives in the directory, so
    // without this a power cut can leave the saved credential without its name.
    if (created) fsyncPathChain(nemaHome, dir);
    else fsyncDirectory(dir);
    // saveSecretLine created the directory 0700; protect it explicitly so a pre-existing directory with
    // wider permissions is tightened rather than trusted. Inside the lock, with the write it belongs to.
    protectPrivatePath(dir, 0o700);
  });
}

export function readAccountSecret(nemaHome: string, accountId: string, kind: AccountSecretKind): string {
  return readSecretLine(accountSecretPath(nemaHome, accountId, kind), MISSING, INVALID);
}

/**
 * Deletes the account's whole credential directory. A directory that is already gone is not an error.
 * Also under the accounts lock, so it cannot interleave with a migration that is copying into it.
 */
export function removeAccountSecrets(nemaHome: string, accountId: string): void {
  withAccountsLockUnlessHeld(nemaHome, () => {
    const dir = accountDir(nemaHome, accountId);
    rmSync(dir, { recursive: true, force: true });
    // The deletion is a change to the parent directory's entries: without this the credential's name can
    // come back after a power cut, which would make a "removed" credential still readable.
    fsyncDirectory(path.dirname(dir));
  });
}
