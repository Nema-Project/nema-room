import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BYOK_BASE_URL, type NemaConfig } from "../config.js";
import { accountsUnusableMessage, accountDir, readAccounts, updateAccounts, writeAccounts, withAccountsLock } from "./store.js";
import {
  accountFileName,
  credentialFileName,
  isUsableCredentialFile,
  legacyCredentialPath,
  legacyUnchanged,
  readLegacyCredential,
  removeLegacyIfUnchanged,
  writeCredentialCopy,
  type LegacyCredential,
} from "./legacy.js";
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
 *   1. validate the legacy file and copy it into `secrets/accounts/<id>/`, fsyncing the file and its
 *      directory (the legacy file is untouched);
 *   2. merge the account record into `accounts.json` and fsync it;
 *   3. remove the legacy file, but only while it is still the exact file that was copied. If it was
 *      replaced meanwhile, the replacement is the newer credential: adopt it and retry, and if it keeps
 *      changing leave it in place. The next materialize finishes the move.
 */

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

/** The credential file this account keeps, or null for a kind that owns none (`compat`). */
function targetFile(nemaHome: string, account: Account): string | null {
  const name = credentialFileName(account);
  return name === null ? null : path.join(accountDir(nemaHome, account.id), name);
}

/** True when this account is of the kind the legacy file holds (same adapter, same credential kind). */
function takesLegacyFile(account: Account, legacyName: string, config: NemaConfig): boolean {
  if (account.adapter !== config.adapter) return false;
  return credentialFileName(account) === accountFileName(legacyName);
}

/**
 * The bytes of a credential file this layer would accept as an account's own copy, or null.
 *
 * It is not enough for the file to be a regular file with the right bytes: it must also be private and
 * owned by us. A world-readable or foreign-owned copy with matching bytes means the credential is already
 * exposed, so treating the move as complete would retire the only private copy.
 */
function usableCopyBytes(file: string): Buffer | null {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const bytes = readFileSync(file);
    return isUsableCredentialFile(file, st.mode, st.uid, bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/** What an existing `accounts.json` says about a legacy file that is still on disk. */
type LegacySituation =
  /** Exactly one account of this kind has no credential yet: that account is waiting for this file. */
  | { kind: "awaiting"; account: Account }
  /** One account already holds these exact bytes: the move happened and the legacy file was re-planted. */
  | { kind: "already-moved"; account: Account }
  /** No account of this kind exists, so this is a fresh first edit. */
  | { kind: "none" }
  /** Several accounts could own it; guessing would put the credential in the wrong one. */
  | { kind: "ambiguous"; ids: string[] }
  /** Accounts of this kind exist and all own a different credential; none of them is this file's owner. */
  | { kind: "conflict"; ids: string[] };

/**
 * Which account owns the legacy file, decided from what is actually on disk rather than from "the first
 * row of the right kind". An account whose credential file exists is never a pending owner unless those
 * bytes are exactly the legacy credential: its file is either a verified copy (the move is done) or a
 * different credential that a guess must not overwrite.
 */
function legacySituation(
  nemaHome: string,
  accounts: Account[],
  config: NemaConfig,
  legacy: string,
  legacyBytes: Buffer,
): LegacySituation {
  const legacyName = path.basename(legacy);
  const matching = accounts.filter((a) => takesLegacyFile(a, legacyName, config));
  const awaiting: Account[] = [];
  for (const account of matching) {
    const target = targetFile(nemaHome, account);
    if (target === null) continue;
    if (!existsSync(target)) {
      awaiting.push(account);
      continue;
    }
    const existing = usableCopyBytes(target);
    // Byte comparison, not "a file is there": a partial copy or an older credential is not this move.
    if (existing !== null && existing.equals(legacyBytes)) return { kind: "already-moved", account };
  }
  if (matching.length === 0) return { kind: "none" };
  // Only an account that is the *sole* candidate can be assumed to own this file. If other accounts of
  // the same kind exist, one of them may be the file's real owner (a rollback can write the legacy path
  // after an account was materialized), and guessing would hand the credential to the wrong account.
  if (matching.length === 1 && awaiting.length === 1) return { kind: "awaiting", account: awaiting[0]! };
  if (awaiting.length > 1) return { kind: "ambiguous", ids: awaiting.map((a) => a.id) };
  return { kind: "conflict", ids: matching.map((a) => a.id) };
}

/**
 * True when the account's credential can be written by this migration: the file is missing, or it holds
 * exactly the bytes this migration last copied (so replacing it loses nothing).
 *
 * Anything else was written by somebody else — a settings save for this account is the realistic case —
 * and it is newer than the legacy file, so the copy must not happen. The caller keeps the legacy file and
 * reports that the move did not finish.
 */
function accountTargetIsReplaceable(nemaHome: string, account: Account, copiedBytes: Buffer | null): boolean {
  const target = targetFile(nemaHome, account);
  if (target === null) return false;
  let existing: Buffer;
  try {
    existing = readFileSync(target);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT";
  }
  return copiedBytes !== null && existing.equals(copiedBytes);
}

/** How many times a legacy file replaced mid-move is re-read and adopted before it is left in place. */
const LEGACY_ADOPT_ATTEMPTS = 3;

/**
 * Retires the legacy file once its bytes are safely in `account` — but only while it is still the exact
 * file that was copied. A replacement (an older daemon or `authByok` saving a refreshed credential) is
 * newer than our copy, so it is adopted: its bytes are copied in, and the check runs again. A file that
 * keeps being replaced is left where it is, which loses nothing and lets the next run finish.
 *
 * Returns the path the credential was retired from, or null when the legacy file could not be retired.
 */
export function retireLegacyFile(
  nemaHome: string,
  account: Account,
  initial: LegacyCredential,
  opts: { alreadyCopied?: boolean; afterCopy?: (legacyPath: string) => void } = {},
): string | null {
  // Runs under the accounts lock (see `materializeImplicit`), the same lock a credential save takes, so a
  // settings request cannot write this account's credential between the copy below and the legacy removal.
  const name = credentialFileName(account);
  if (name === null) return null;
  let source = initial;
  // The bytes this migration itself put in the account, and therefore the only ones it may replace.
  let copied: Buffer | null = opts.alreadyCopied === true ? initial.bytes : null;
  for (let attempt = 0; attempt < LEGACY_ADOPT_ATTEMPTS; attempt++) {
    // The first copy may already be in place from before the commit; only a changed source needs another.
    const copiedEarlier = attempt === 0 && opts.alreadyCopied === true;
    if (!copiedEarlier || !legacyUnchanged(nemaHome, source)) {
      // Re-check the destination immediately before copying: a credential saved for this account since the
      // situation was computed is newer than the legacy bytes and must not be replaced by them.
      if (!accountTargetIsReplaceable(nemaHome, account, copied)) return null;
      writeCredentialCopy(nemaHome, account.id, name, source.bytes);
      copied = source.bytes;
    }
    // A hook for the caller/tests to act between "copied" and "removed", which is exactly the window a
    // peer's refresh can land in.
    opts.afterCopy?.(source.path);
    if (removeLegacyIfUnchanged(nemaHome, source)) return source.path;
    // The file changed under us: it is the newer credential, so adopt it and try to retire it again.
    try {
      source = readLegacyCredential(nemaHome, source.path);
    } catch {
      // The replacement is not a credential we can vouch for (or it vanished): keep it and stop.
      return null;
    }
  }
  return null;
}

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
  if (existing.status === "unusable") {
    // The file may hold rows and bindings that are still recoverable by hand. Replacing it with a fresh
    // snapshot would destroy them, so refuse and say what to do instead.
    throw new Error(accountsUnusableMessage(o.nemaHome, existing.reason));
  }

  const legacyPath = legacyCredentialPath(o.nemaHome, o.config);
  // Validate the legacy file before deciding anything: an untrusted source stops the migration with the
  // file untouched, rather than becoming an account credential.
  const source = legacyPath !== null && existsSync(legacyPath) ? readLegacyCredential(o.nemaHome, legacyPath) : null;

  const others = existing.status === "ok" ? existing.file.accounts : [];
  if (source !== null) {
    const situation = legacySituation(o.nemaHome, others, o.config, source.path, source.bytes);
    if (situation.kind === "ambiguous") {
      throw new Error(
        `有多个账户（${situation.ids.join("、")}）缺少凭据文件，无法确定旧凭据属于哪一个，已保留 ${source.path} 未动。请先在设置页补齐或删除多余的账户。`,
      );
    }
    if (situation.kind === "conflict") {
      throw new Error(
        `账户 ${situation.ids.join("、")} 的凭据与旧凭据 ${source.path} 内容不同，无法判断哪一个是新的，两边都未改动。请确认后手动处理。`,
      );
    }
    if (situation.kind === "awaiting") {
      // A previous run committed the account and died before deleting the legacy file: finish that move.
      const movedFrom = retireLegacyFile(o.nemaHome, situation.account, source);
      return { account: situation.account, movedFrom };
    }
    if (situation.kind === "already-moved") {
      // The bytes are already stored in that account's file; retire the leftover legacy path only while
      // it still holds exactly those bytes.
      const movedFrom = removeLegacyIfUnchanged(o.nemaHome, source) ? source.path : null;
      return { account: situation.account, movedFrom };
    }
  }

  const from = implicitAccount(o.config, o.now ?? new Date());
  const takenIds = new Set(others.map((a) => a.id));
  // An id names a credential directory: reusing one would copy this credential over that account's file.
  const account: Account = {
    ...from,
    id: newAccountId(o.random, (id) => takenIds.has(id) || existsSync(accountDir(o.nemaHome, id))),
    name: o.name,
  };

  const bindings = existing.status === "ok" ? { ...existing.file.bindings } : {};
  for (const [scope, value] of Object.entries(bindings)) {
    if (value === IMPLICIT_ACCOUNT_ID) bindings[scope] = account.id;
  }
  // `newAccountId` already refused every stored id; this is the belt to its braces.
  if (others.some((a) => a.id === account.id)) throw new Error("生成的账户 id 与已有账户冲突，未写入任何数据");
  const accounts = [...others, account];

  // 1. The credential copy is durable (file + directory fsync) before anything refers to it.
  const name = credentialFileName(account);
  if (source !== null && name !== null) writeCredentialCopy(o.nemaHome, account.id, name, source.bytes);
  // 2. Only now is the account reachable from a committed record.
  try {
    writeAccounts(o.nemaHome, { version: 1, accounts, bindings });
  } catch (e) {
    // Nothing refers to that directory: the id was fresh, so the copy is this attempt's alone. Leaving it
    // would put an unreferenced copy of the credential on disk. The legacy file is untouched either way.
    if (source !== null && name !== null) {
      try {
        rmSync(accountDir(o.nemaHome, account.id), { recursive: true, force: true });
      } catch {
        /* best effort: the legacy file is still the authoritative copy */
      }
    }
    throw e;
  }
  // 3. And only after that may the legacy file go, and only if it is still the file that was copied.
  const movedFrom = source === null ? null : retireLegacyFile(o.nemaHome, account, source, { alreadyCopied: name !== null });
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

  // A model the config no longer selects must stop applying: clear it, the same way baseUrl is cleared.
  if (config.model === undefined) {
    if (target.model !== undefined) patch.model = undefined;
  } else if (target.model !== config.model) {
    patch.model = config.model;
  }
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

/**
 * Writes the projection into the default account. Used by the settings page when it opens, not at startup.
 *
 * The read-modify-write runs under the accounts lock (`updateAccounts`), so a peer's edit between our
 * check and our write is never replaced by a snapshot taken before it. A file that turned unusable in
 * that window throws instead of being overwritten: silently reporting "nothing to do" would leave the
 * settings page showing a projection that was never saved.
 */
export function reconcileAccountProjection(nemaHome: string, config: NemaConfig): boolean {
  const read = readAccounts(nemaHome);
  // "false" means "nothing needed saving". An unusable file is a different answer: the settings page must
  // not show the user a stale projection as if it had been saved, so this is an error, not a quiet false.
  if (read.status === "unusable") throw new Error(accountsUnusableMessage(nemaHome, read.reason));
  if (read.status !== "ok") return false;
  if (syncDefaultAccountProjection(read.file.accounts, config) === null) return false;
  const next = updateAccounts(nemaHome, (current) => {
    if (current === null) return null;
    const sync = syncDefaultAccountProjection(current.accounts, config);
    if (sync === null) return null;
    return { ...current, accounts: current.accounts.map((a) => (a.id === sync.accountId ? applyProjection(a, sync.patch) : a)) };
  });
  return next !== null;
}
