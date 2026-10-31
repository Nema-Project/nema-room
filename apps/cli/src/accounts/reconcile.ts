import type { NemaConfig } from "../config.js";
import { applyProjection, syncDefaultAccountProjection } from "./implicit.js";
import { readAccounts } from "./store.js";
import type { Account } from "./schema.js";

/**
 * The default account as the projection says it should be, computed **in memory only**.
 *
 * D-6 is "synthesize on read, write only on the first edit": starting the daemon must not create or
 * rewrite `accounts.json`, so this returns the reconciled list for the caller to use and never writes.
 * The one place that persists a projection is the settings page, when the user actually opens it and
 * changes something (S2).
 *
 * The direction is still the rollback's: 0.2.0 edits `config.json`, so after a rollback the projection
 * wins over the stored account.
 */
export function projectedAccounts(accounts: Account[], config: NemaConfig): Account[] {
  const sync = syncDefaultAccountProjection(accounts, config);
  if (sync === null) return accounts;
  return accounts.map((a) => (a.id === sync.accountId ? applyProjection(a, sync.patch) : a));
}

/** Whether the projection differs from the stored rows. Pure; used by the settings page to decide to save. */
export function projectionDiffers(nemaHome: string, config: NemaConfig): boolean {
  const read = readAccounts(nemaHome);
  if (read.status !== "ok") return false;
  return syncDefaultAccountProjection(read.file.accounts, config) !== null;
}
