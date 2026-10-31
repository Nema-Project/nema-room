import { rmSync } from "node:fs";
import path from "node:path";
import { accountDir } from "../accounts/store.js";
import { withAccountsLock } from "../accounts/lock.js";
import { protectPrivatePath } from "./permissions.js";
import { readSecretLine, saveSecretLine } from "./file.js";

/**
 * One credential file per account directory, written with the same private-file helpers the single-key
 * setup already used: an exclusive 0600 temp file, fsync, rename, and a 0700 directory. Nothing here
 * reads a value back except `readAccountSecret`, and no message ever includes one.
 *
 * Saves take the accounts lock. The migration of the first edit copies the legacy credential into an
 * account directory and then retires the legacy file; a save for that same account running in between
 * could be overwritten by the copy and lost. Holding the same lock makes the two orders strictly serial.
 */

export type AccountSecretKind = "key" | "token";

const FILE_NAME: Record<AccountSecretKind, string> = { key: "key", token: "token" };

const MISSING = "没有这个账户的凭据。请在设置页重新填写。";
const INVALID = "账户凭据文件内容无效，或权限不是私有的。请重新填写。";

export function accountSecretPath(nemaHome: string, accountId: string, kind: AccountSecretKind): string {
  return path.join(accountDir(nemaHome, accountId), FILE_NAME[kind]);
}

export function saveAccountSecret(nemaHome: string, accountId: string, kind: AccountSecretKind, value: string): void {
  const dir = accountDir(nemaHome, accountId);
  const file = accountSecretPath(nemaHome, accountId, kind);
  withAccountsLock(nemaHome, () => {
    saveSecretLine(file, value);
  });
  // saveSecretLine already created the directory 0700; protect it explicitly so a pre-existing
  // directory with wider permissions is tightened rather than trusted.
  protectPrivatePath(dir, 0o700);
}

export function readAccountSecret(nemaHome: string, accountId: string, kind: AccountSecretKind): string {
  return readSecretLine(accountSecretPath(nemaHome, accountId, kind), MISSING, INVALID);
}

/**
 * Deletes the account's whole credential directory. A directory that is already gone is not an error.
 * Also under the accounts lock, so it cannot interleave with a migration that is copying into it.
 */
export function removeAccountSecrets(nemaHome: string, accountId: string): void {
  const dir = accountDir(nemaHome, accountId);
  withAccountsLock(nemaHome, () => {
    rmSync(dir, { recursive: true, force: true });
  });
}
