import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BYOK_BASE_URL, type NemaConfig } from "../config.js";
import { protectPrivatePath } from "../secrets/permissions.js";
import { accountDir, readAccounts, writeAccounts } from "./store.js";
import { IMPLICIT_ACCOUNT_ID, newAccountId, type Account } from "./schema.js";

/**
 * The pre-accounts single-key setup, expressed as one account (spec 2026-10-31 D-6).
 *
 * Reading synthesizes it in memory and writes nothing: a user who never touches account settings keeps
 * `config.json` and their credential files exactly as 0.2.0 left them, and a rollback to 0.2.0 still
 * starts. Only the first account edit materializes it, at which point the old credential is copied into
 * the account directory and the legacy file is removed once the account record is committed, so a crash
 * at any point leaves a usable state:
 *
 *   1. copy the credential into `secrets/accounts/<id>/` (the legacy file is untouched);
 *   2. merge the account record into `accounts.json` and fsync it;
 *   3. remove the legacy file. If this does not happen, the next materialize finishes it.
 */

/** The legacy credential path for this config, or null when the combination owns no file. */
function legacyCredentialPath(nemaHome: string, config: NemaConfig): string | null {
  if (config.adapter === "claude-code") return path.join(nemaHome, "claude-code-token");
  if (config.authMode === "byok") return path.join(nemaHome, "byok-key");
  if (config.authMode === "siwc") return path.join(nemaHome, "auth.json");
  return null;
}

/** The account-layout file name for a legacy file: `key`, `token`, or `auth.json`. */
function accountFileName(legacy: string): string {
  const base = path.basename(legacy);
  if (base === "auth.json") return "auth.json";
  if (base === "byok-key") return "key";
  return "token";
}

function implicitAccount(config: NemaConfig, now: Date): Account {
  return {
    id: IMPLICIT_ACCOUNT_ID,
    name: "默认账户",
    enabled: true,
    adapter: config.adapter,
    ...(config.adapter === "codex-direct" ? { authMode: config.authMode } : {}),
    // BYOK always has an endpoint: an unset byokBaseUrl means the default one, not "no base URL", and a
    // stored byok account must keep a baseUrl (schema §2.1).
    ...(config.adapter === "codex-direct" && config.authMode === "byok"
      ? { baseUrl: config.byokBaseUrl ?? DEFAULT_BYOK_BASE_URL }
      : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    costTier: "standard",
    order: 0,
    createdAt: now.toISOString(),
  };
}

export type LoadedAccounts = { accounts: Account[]; implicit: boolean; unusableReason?: "symlink" | "mode" | "owner" | "corrupt" | "invalid" };

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

/** True when this account was materialized from the legacy single key and still has that file to move. */
function pendingLegacyMove(nemaHome: string, accounts: Account[], config: NemaConfig): Account | null {
  const legacy = legacyCredentialPath(nemaHome, config);
  if (legacy === null || !existsSync(legacy)) return null;
  // A materialized account always has the matching credential kind; find the one the legacy file belongs to.
  const wanted = accountFileName(legacy);
  return accounts.find((a) => {
    if (a.adapter !== config.adapter) return false;
    const files = a.adapter === "claude-code" ? ["token"] : [a.authMode === "byok" ? "key" : a.authMode === "siwc" ? "auth.json" : ""];
    return files.includes(wanted);
  }) ?? null;
}

/** Copies the legacy credential into the account directory. Safe to repeat: the bytes are the same. */
function copyLegacyCredential(nemaHome: string, account: Account, legacy: string, target: string): void {
  const dir = accountDir(nemaHome, account.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  protectPrivatePath(dir, 0o700);
  copyFileSync(legacy, target);
  protectPrivatePath(target, 0o600);
  // Read back before the caller may delete the original.
  if (readFileSync(target, "utf8") !== readFileSync(legacy, "utf8")) throw new Error("账户凭据写入后读不回");
}

/**
 * Serializes writers of `accounts.json` across processes. The account store's own writes are atomic, but
 * "read, decide, write" is not: two daemons editing accounts at once would each write their own snapshot
 * and the later one would drop the earlier one's account. A caller that only reads needs no lock.
 */
function withAccountsLock<T>(nemaHome: string, fn: () => T): T {
  mkdirSync(nemaHome, { recursive: true, mode: 0o700 });
  protectPrivatePath(nemaHome, 0o700);
  const lockPath = path.join(nemaHome, "accounts.lock");
  const token = randomUUID();
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    // A lock whose holder is gone is stale; this is the same rule the auth lock uses.
    let held = false;
    try {
      const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
      held = typeof raw.pid === "number" && pidAlive(raw.pid);
    } catch {
      held = false;
    }
    if (!held) {
      rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) throw new Error("等待账户文件锁超时，请稍后重试");
    // Materializing is a short synchronous step; blocking here keeps the API synchronous like the rest
    // of the account helpers, which the settings service calls without an event loop turn.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  try {
    return fn();
  } finally {
    try {
      const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: unknown };
      if (raw.token === token) unlinkSync(lockPath);
    } catch {
      /* a lock we cannot remove goes stale once this process exits */
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM: exists, owned by someone else
  }
}

/**
 * Writes the synthesized account down under a fresh id and moves the old credential into its directory.
 *
 * Order matters for recovery: copy first, commit the account record second, delete the legacy file last.
 * A failure or crash at any step leaves either the legacy file still in place (nothing lost), or an
 * account whose credential exists while the legacy file lingers (the next call finishes the move).
 */
export function materializeImplicit(o: {
  nemaHome: string;
  config: NemaConfig;
  codexHome: string;
  name: string;
  now?: Date;
  random?: () => string;
}): { account: Account; movedFrom: string | null } {
  return withAccountsLock(o.nemaHome, () => materializeLocked(o));
}

function materializeLocked(o: {
  nemaHome: string;
  config: NemaConfig;
  codexHome: string;
  name: string;
  now?: Date;
  random?: () => string;
}): { account: Account; movedFrom: string | null } {
  const existing = readAccounts(o.nemaHome);
  if (existing.status === "ok") {
    // A previous run may have committed the account and died before deleting the legacy file.
    const pending = pendingLegacyMove(o.nemaHome, existing.file.accounts, o.config);
    const legacy = legacyCredentialPath(o.nemaHome, o.config);
    if (pending !== null && legacy !== null) {
      const target = path.join(accountDir(o.nemaHome, pending.id), accountFileName(legacy));
      if (!existsSync(target)) copyLegacyCredential(o.nemaHome, pending, legacy, target);
      rmSync(legacy, { force: true });
      return { account: pending, movedFrom: legacy };
    }
  }

  const from = implicitAccount(o.config, o.now ?? new Date());
  const account: Account = { ...from, id: newAccountId(o.random), name: o.name };

  const bindings = existing.status === "ok" ? { ...existing.file.bindings } : {};
  for (const [scope, value] of Object.entries(bindings)) {
    if (value === IMPLICIT_ACCOUNT_ID) bindings[scope] = account.id;
  }
  // Under the lock nothing else can commit between the read above and the write below.
  const others = existing.status === "ok" ? existing.file.accounts : [];
  const latestBindings = bindings;
  const accounts = others.some((a) => a.id === account.id) ? others : [...others, account];

  const legacy = legacyCredentialPath(o.nemaHome, o.config);
  let movedFrom: string | null = null;
  if (legacy !== null && existsSync(legacy)) {
    copyLegacyCredential(o.nemaHome, account, legacy, path.join(accountDir(o.nemaHome, account.id), accountFileName(legacy)));
    movedFrom = legacy;
  }

  writeAccounts(o.nemaHome, { version: 1, accounts, bindings: latestBindings });
  // Only now is the credential reachable from a committed account record.
  if (movedFrom !== null) rmSync(movedFrom, { force: true });
  return { account, movedFrom };
}

/** Only the keys this projection actually changes, so a caller writes exactly what the account needs. */
function projectionPatch(target: Account, config: NemaConfig): Partial<Account> {
  const patch: Partial<Account> = {};
  if (target.adapter !== config.adapter) patch.adapter = config.adapter;

  if (config.adapter === "codex-direct") {
    if (target.authMode !== config.authMode) patch.authMode = config.authMode;
    if (config.authMode === "byok") {
      const baseUrl = config.byokBaseUrl ?? DEFAULT_BYOK_BASE_URL;
      if (target.baseUrl !== baseUrl) patch.baseUrl = baseUrl;
    } else if (target.baseUrl !== undefined) {
      // A siwc/compat account must not carry a base URL: the combination it came from is gone.
      patch.baseUrl = undefined;
    }
  } else {
    // claude-code owns no authMode and no baseUrl.
    if (target.authMode !== undefined) patch.authMode = undefined;
    if (target.baseUrl !== undefined) patch.baseUrl = undefined;
  }

  if (config.model !== undefined && target.model !== config.model) patch.model = config.model;
  return patch;
}

/**
 * The direction of truth for a rollback (D-6). 0.2.0 only edits `config.json`, so after a rollback the
 * projection is what the user last chose: the default account is updated to match it, never the other way
 * round. The patch always describes a valid combination — switching adapter or auth mode clears the fields
 * the new combination does not use, so the result passes `validateAccountsFile`.
 */
export function syncDefaultAccountProjection(
  accounts: Account[],
  config: NemaConfig,
): { accountId: string; patch: Partial<Account> } | null {
  const enabled = accounts.filter((a) => a.enabled).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const target = enabled[0];
  if (!target) return null;
  const patch = projectionPatch(target, config);
  return Object.keys(patch).length > 0 ? { accountId: target.id, patch } : null;
}

/** Applies a projection patch to an account, dropping the keys it sets to undefined. */
export function applyProjection(account: Account, patch: Partial<Account>): Account {
  const merged: Record<string, unknown> = { ...account };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged as Account;
}

/** Writes the projection into the default account. Used by the settings page when it opens, not at startup. */
export function reconcileAccountProjection(nemaHome: string, config: NemaConfig): boolean {
  const read = readAccounts(nemaHome);
  if (read.status !== "ok") return false;
  if (syncDefaultAccountProjection(read.file.accounts, config) === null) return false;
  return withAccountsLock(nemaHome, () => {
    // Re-read now that nobody else can write: a peer may have changed the file between the check and here.
    const current = readAccounts(nemaHome);
    if (current.status !== "ok") return false;
    const sync = syncDefaultAccountProjection(current.file.accounts, config);
    if (sync === null) return false;
    const accounts = current.file.accounts.map((a) => (a.id === sync.accountId ? applyProjection(a, sync.patch) : a));
    writeAccounts(nemaHome, { ...current.file, accounts });
    return true;
  });
}
