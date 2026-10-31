import { lstatSync } from "node:fs";
import path from "node:path";
import { AuthStore, usableSiwcLogin } from "../direct/authStore.js";
import { readCodexCliTokens } from "../direct/codexLogin.js";
import { privateModeMatches, privateOwnerMatches } from "../secrets/permissions.js";
import { readSecretLine } from "../secrets/file.js";
import { accountDir } from "./store.js";
import { hasSymlinkedComponent } from "./paths.js";
import { legacyFileName } from "./legacy.js";
import { IMPLICIT_ACCOUNT_ID, type Account } from "./schema.js";

/**
 * Where an account keeps its credential, and whether that credential can be used right now. A state is
 * only ever "connected" / "missing" / "unusable": the value itself never leaves `readAccountSecret`,
 * and no caller of this module needs it (spec 2026-10-31 §3.3).
 */

export type CredentialState = "connected" | "missing" | "unusable";

/** `inspect()` never refreshes, so it needs no refresher; a throwing one keeps that true by accident-proof. */
const neverRefresh = async (): Promise<never> => {
  throw new Error("credential inspection never refreshes");
};

const KEY_FILE = "key";
const TOKEN_FILE = "token";
const AUTH_FILE = "auth.json";

/** The paths this account is expected to own. `compat` owns none: it reads the Codex CLI's own login. */
export function accountCredentialFiles(nemaHome: string, account: Account): string[] {
  if (account.id === IMPLICIT_ACCOUNT_ID) return legacyFiles(nemaHome, account);
  const dir = accountDir(nemaHome, account.id);
  if (account.adapter === "claude-code") return [path.join(dir, TOKEN_FILE)];
  if (account.authMode === "byok") return [path.join(dir, KEY_FILE)];
  if (account.authMode === "siwc") return [path.join(dir, AUTH_FILE)];
  return []; // compat
}

/**
 * The pre-accounts file for the synthesized account (D-6). These are the paths 0.2.0 used, unchanged, so
 * a user who never touches account settings keeps exactly the layout and files they had.
 *
 * The path is checked exactly like the account layout's: a linked home (or a linked component below it)
 * is not a layout this store would read, so reporting a credential as connected through it would claim a
 * file the rest of the account code refuses to touch. Throws instead; the caller reports "unusable".
 */
function legacyFiles(nemaHome: string, account: Account): string[] {
  const name = legacyFileName(account);
  if (name === null) return [];
  const file = path.join(nemaHome, name);
  if (hasSymlinkedComponent(nemaHome, file)) {
    throw new Error("Nema 主目录或凭据路径是符号链接，已拒绝读取旧凭据。");
  }
  return [file];
}

/** True when the file is a private, owned, regular file. Symlinks, foreign owners and wider modes fail. */
function privateStat(file: string): boolean {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  if (!privateModeMatches(stat) || !privateOwnerMatches(stat)) return false;
  return true;
}

/**
 * A key or token file's state, judged by the same rules `readAccountSecret` applies when the value is
 * actually used: private, owned, and one non-empty line without control characters. An empty or malformed
 * file is "unusable", not "connected", so the settings page cannot claim a credential works when it does not.
 */
function fileState(file: string): CredentialState {
  try {
    if (!privateStat(file)) return "unusable";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unusable";
  }
  try {
    // Route through the real reader with its real rules rather than re-implementing them here: one
    // non-empty line, no control characters, private and owned.
    return readSecretLine(file, "missing", "invalid") !== "" ? "connected" : "unusable";
  } catch {
    return "unusable";
  }
}

/**
 * Names of credential files this account should not have. Spec §3.2: a directory holding more than one
 * kind, or a kind that does not belong to this account, is ambiguous; none of them is trusted.
 *
 * Only "no such file" counts as absent. Any other failure to look (permissions, I/O) means the check did
 * not happen, and a check that did not happen must not be reported as "none found": that would let a
 * compat account claim connected while an unreadable conflicting credential sits in its directory.
 */
function foreignCredentialFiles(nemaHome: string, account: Account): string[] {
  if (account.id === IMPLICIT_ACCOUNT_ID) return [];
  const dir = accountDir(nemaHome, account.id);
  const expected = path.basename(accountCredentialFiles(nemaHome, account)[0] ?? "");
  const foreign: string[] = [];
  for (const name of [KEY_FILE, TOKEN_FILE, AUTH_FILE]) {
    if (name === expected) continue;
    try {
      lstatSync(path.join(dir, name));
      foreign.push(name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
  }
  return foreign;
}


/** Why the Codex CLI login cannot be used, or null when it can be. */
function codexLoginProblem(codexHome: string): "missing" | "unusable" | null {
  const file = path.join(codexHome, "auth.json");
  try {
    if (!privateStat(file)) return "unusable";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unusable";
  }
  try {
    readCodexCliTokens(codexHome);
    return null;
  } catch {
    // The file is there but Nema cannot use it: expired, tokenless, keyring-backed or unreadable.
    return "unusable";
  }
}

export function accountCredentialState(
  nemaHome: string,
  account: Account,
  codexHome: string,
): { state: CredentialState; files: string[] } {
  let files: string[];
  try {
    files = accountCredentialFiles(nemaHome, account);
  } catch {
    // A symlinked or reserved account directory: nothing under it can be trusted.
    return { state: "unusable", files: [] };
  }

  let foreign: string[];
  try {
    foreign = foreignCredentialFiles(nemaHome, account);
  } catch {
    // The directory could not be inspected: an unverified account is not a connected one.
    return { state: "unusable", files };
  }

  if (account.adapter === "codex-direct" && account.authMode === "compat") {
    // A compat account owns no files, so any credential of its own contradicts what it claims to be.
    if (foreign.length > 0) return { state: "unusable", files };
    const problem = codexLoginProblem(codexHome);
    return { state: problem === null ? "connected" : problem, files };
  }

  if (foreign.length > 0) return { state: "unusable", files };

  const expected = files[0];
  if (expected === undefined) return { state: "missing", files };

  // A siwc login is a whole StoredAuth record. AuthStore already knows how to judge one (trusted stat,
  // owner, O_NOFOLLOW open, schema), so ask it rather than half-checking the file here.
  if (account.adapter === "codex-direct" && account.authMode === "siwc") {
    const inspected = new AuthStore(nemaHome, neverRefresh, Date.now, { baseDir: path.dirname(expected) }).inspect();
    // SIWC has its own requirements on top of "the file parses"; the store's parser cannot know them.
    if (inspected.auth) return { state: usableSiwcLogin(inspected.auth) ? "connected" : "unusable", files };
    return { state: inspected.reason === "unusable" ? "unusable" : "missing", files };
  }

  return { state: fileState(expected), files };
}
