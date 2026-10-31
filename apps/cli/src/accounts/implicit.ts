import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { protectPrivatePath } from "../secrets/permissions.js";
import type { NemaConfig } from "../config.js";
import { readAccountSecret, saveAccountSecret } from "../secrets/accounts.js";
import { accountDir, readAccounts, writeAccounts } from "./store.js";
import { IMPLICIT_ACCOUNT_ID, newAccountId, type Account } from "./schema.js";

/**
 * The pre-accounts single-key setup, expressed as one account (spec 2026-10-31 D-6).
 *
 * Reading synthesizes it in memory and writes nothing: a user who never touches account settings keeps
 * `config.json` and their credential files exactly as 0.2.0 left them, and a rollback to 0.2.0 still
 * starts. Only the first account edit materializes it, at which point the old credential is moved (not
 * copied) so two accounts can never share one key.
 */

/** The legacy credential path for this config, or null when the combination owns no file. */
function legacyCredentialPath(nemaHome: string, config: NemaConfig): string | null {
  if (config.adapter === "claude-code") return path.join(nemaHome, "claude-code-token");
  if (config.authMode === "byok") return path.join(nemaHome, "byok-key");
  if (config.authMode === "siwc") return path.join(nemaHome, "auth.json");
  return null;
}

function implicitAccount(config: NemaConfig, now: Date): Account {
  return {
    id: IMPLICIT_ACCOUNT_ID,
    name: "默认账户",
    enabled: true,
    adapter: config.adapter,
    ...(config.adapter === "codex-direct" ? { authMode: config.authMode } : {}),
    ...(config.adapter === "codex-direct" && config.authMode === "byok" && config.byokBaseUrl !== undefined
      ? { baseUrl: config.byokBaseUrl }
      : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    costTier: "standard",
    order: 0,
    createdAt: now.toISOString(),
  };
}

export type LoadedAccounts = { accounts: Account[]; implicit: boolean; unusableReason?: "symlink" | "mode" | "corrupt" | "invalid" };

/**
 * The accounts this machine has. A missing or unusable `accounts.json` yields the synthesized account so
 * the rest of the daemon always has exactly one usable account, the way 0.2.0 always had exactly one
 * credential.
 */
export function loadAccounts(nemaHome: string, config: NemaConfig, _codexHome: string, now: Date = new Date()): LoadedAccounts {
  const read = readAccounts(nemaHome);
  if (read.status === "ok") return { accounts: read.file.accounts, implicit: false };
  const reason = read.status === "unusable" ? read.reason : undefined;
  return {
    accounts: [implicitAccount(config, now)],
    implicit: true,
    ...(reason !== undefined ? { unusableReason: reason } : {}),
  };
}

/**
 * Writes the synthesized account down under a fresh id and moves the old credential into its directory.
 * `movedFrom` is the path the credential came from, for the caller to report; it never carries a value.
 */
export function materializeImplicit(o: {
  nemaHome: string;
  config: NemaConfig;
  codexHome: string;
  name: string;
  now?: Date;
  random?: () => string;
}): { account: Account; movedFrom: string | null } {
  const from = implicitAccount(o.config, o.now ?? new Date());
  const account: Account = { ...from, id: newAccountId(o.random), name: o.name };

  const existing = readAccounts(o.nemaHome);
  const bindings = existing.status === "ok" ? { ...existing.file.bindings } : {};
  // Re-point bindings that named the synthesized account so a workspace keeps its choice.
  for (const [scope, value] of Object.entries(bindings)) {
    if (value === IMPLICIT_ACCOUNT_ID) bindings[scope] = account.id;
  }
  const others = existing.status === "ok" ? existing.file.accounts : [];

  const legacy = legacyCredentialPath(o.nemaHome, o.config);
  let movedFrom: string | null = null;
  if (legacy !== null && existsSync(legacy)) {
    const dir = accountDir(o.nemaHome, account.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    protectPrivatePath(dir, 0o700);
    // The account layout names the file by kind: `key`, `token`, or `auth.json` for a whole siwc login.
    const target = path.join(dir, path.basename(legacy) === "auth.json" ? "auth.json" : path.basename(legacy) === "byok-key" ? "key" : "token");
    try {
      renameSync(legacy, target);
      movedFrom = legacy;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      // Across filesystems: write the new copy, read it back, and only then drop the old file.
      if (o.config.adapter === "claude-code") {
        const value = readAccountSecret(o.nemaHome, IMPLICIT_ACCOUNT_ID, "token");
        saveAccountSecret(o.nemaHome, account.id, "token", value);
        if (readAccountSecret(o.nemaHome, account.id, "token") !== value) throw new Error("账户凭据写入后读不回");
      } else if (o.config.authMode === "byok") {
        const value = readAccountSecret(o.nemaHome, IMPLICIT_ACCOUNT_ID, "key");
        saveAccountSecret(o.nemaHome, account.id, "key", value);
        if (readAccountSecret(o.nemaHome, account.id, "key") !== value) throw new Error("账户凭据写入后读不回");
      } else {
        copyFileSync(legacy, target);
        protectPrivatePath(target, 0o600);
      }
      rmSync(legacy, { force: true });
      movedFrom = legacy;
    }
  }

  writeAccounts(o.nemaHome, { version: 1, accounts: [...others, account], bindings });
  return { account, movedFrom };
}

/**
 * The direction of truth for a rollback (D-6). 0.2.0 only edits `config.json`, so after a rollback the
 * projection is what the user last chose: the default account is updated to match it, never the other way
 * round. Returns the account patch to apply, or null when they already agree.
 */
export function syncDefaultAccountProjection(
  accounts: Account[],
  config: NemaConfig,
): { accountId: string; patch: Partial<Account> } | null {
  const enabled = accounts.filter((a) => a.enabled).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const target = enabled[0];
  if (!target) return null;

  const patch: Partial<Account> = {};
  if (target.adapter !== config.adapter) patch.adapter = config.adapter;
  if (config.adapter === "codex-direct" && target.authMode !== config.authMode) patch.authMode = config.authMode;
  if (config.model !== undefined && target.model !== config.model) patch.model = config.model;
  // A byok account must keep a baseUrl, so a rollback that left it unset only means "keep the current one".
  if (config.adapter === "codex-direct" && config.authMode === "byok"
    && config.byokBaseUrl !== undefined && target.baseUrl !== config.byokBaseUrl) {
    patch.baseUrl = config.byokBaseUrl;
  }
  return Object.keys(patch).length > 0 ? { accountId: target.id, patch } : null;
}
