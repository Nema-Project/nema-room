import type { NemaConfig } from "../config.js";
import { syncDefaultAccountProjection } from "./implicit.js";
import { readAccounts, writeAccounts } from "./store.js";
import type { Account } from "./schema.js";

/**
 * Applies a rollback's `config.json` edits to the default account (D-6). Called once at daemon start and
 * once when the settings page first reads: 0.2.0 can only edit the projection, so the projection wins.
 *
 * Writes `accounts.json` and never `config.json`, so a user still on 0.2.0 sees the file it expects.
 * Returns whether the account had to change; a missing or unusable accounts file is not an error.
 */
export function reconcileDefaultAccount(nemaHome: string, config: NemaConfig): boolean {
  const read = readAccounts(nemaHome);
  if (read.status !== "ok") return false;

  const sync = syncDefaultAccountProjection(read.file.accounts, config);
  if (sync === null) return false;

  const accounts: Account[] = read.file.accounts.map((a) => (a.id === sync.accountId ? { ...a, ...sync.patch } : a));
  writeAccounts(nemaHome, { ...read.file, accounts });
  return true;
}
