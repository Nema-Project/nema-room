import { closeSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { AuthStore } from "../direct/authStore.js";
import { readCodexCliTokens } from "../direct/codexLogin.js";
import { openPrivateFile, privateModeMatches } from "../secrets/permissions.js";
import { accountDir } from "./store.js";
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
  if (account.adapter === "claude-code") return [path.join(accountDir(nemaHome, account.id), TOKEN_FILE)];
  if (account.authMode === "byok") return [path.join(accountDir(nemaHome, account.id), KEY_FILE)];
  if (account.authMode === "siwc") return [path.join(accountDir(nemaHome, account.id), AUTH_FILE)];
  return []; // compat
}

/**
 * The pre-accounts file for the synthesized account (D-6). These are the paths 0.2.0 used, unchanged, so
 * a user who never touches account settings keeps exactly the layout and files they had.
 */
function legacyFiles(nemaHome: string, account: Account): string[] {
  if (account.adapter === "claude-code") return [path.join(nemaHome, "claude-code-token")];
  if (account.authMode === "byok") return [path.join(nemaHome, "byok-key")];
  if (account.authMode === "siwc") return [path.join(nemaHome, "auth.json")];
  return [];
}

/** A file we can open privately and read. Symlinks, foreign owners and wider modes all count as unusable. */
function fileState(file: string): CredentialState {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return "unusable";
    if (!stat.isFile()) return "unusable";
    if (!privateModeMatches(stat)) return "unusable";
    closeSync(openPrivateFile(file));
    return "connected";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unusable";
  }
}

/**
 * Names of credential files this account should not have. Spec §3.2: a directory holding more than one
 * kind, or a kind that does not belong to this account, is ambiguous; none of them is trusted.
 */
function foreignCredentialFiles(nemaHome: string, account: Account): string[] {
  if (account.id === IMPLICIT_ACCOUNT_ID) return [];
  const dir = accountDir(nemaHome, account.id);
  const expected = path.basename(accountCredentialFiles(nemaHome, account)[0] ?? "");
  return [KEY_FILE, TOKEN_FILE, AUTH_FILE].filter((name) => name !== expected && existsSync(path.join(dir, name)));
}

export function accountCredentialState(
  nemaHome: string,
  account: Account,
  codexHome: string,
): { state: CredentialState; files: string[] } {
  const files = accountCredentialFiles(nemaHome, account);

  if (account.adapter === "codex-direct" && account.authMode === "compat") {
    try {
      readCodexCliTokens(codexHome);
      return { state: "connected", files };
    } catch {
      return { state: "missing", files };
    }
  }

  if (foreignCredentialFiles(nemaHome, account).length > 0) return { state: "unusable", files };

  const expected = files[0];
  if (expected === undefined) return { state: "missing", files };

  // A siwc login is a whole StoredAuth record. AuthStore already knows how to judge one (trusted stat,
  // O_NOFOLLOW open, schema), so ask it rather than half-checking the file here.
  if (account.adapter === "codex-direct" && account.authMode === "siwc") {
    const inspected = new AuthStore(nemaHome, neverRefresh, Date.now, { baseDir: path.dirname(expected) }).inspect();
    if (inspected.auth) return { state: "connected", files };
    return { state: inspected.reason === "unusable" ? "unusable" : "missing", files };
  }

  return { state: fileState(expected), files };
}
