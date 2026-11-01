import type { NemaConfig } from "../config.js";
import { loadAccounts } from "../accounts/implicit.js";
import { readAccounts } from "../accounts/store.js";
import { projectedAccounts } from "../accounts/reconcile.js";
import type { Account } from "../accounts/schema.js";

/**
 * The accounts this daemon can route over, read fresh for a task.
 *
 * Reading is what `loadAccounts` does — including synthesizing the one account D-6 describes when
 * `accounts.json` does not exist — plus the config projection, so a model changed by a rolled-back 0.2.0
 * applies before a task runs rather than only after the settings page is opened. Nothing is written: a
 * daemon start must not create `accounts.json`.
 *
 * `bindings` is empty when the file is missing or unusable, which is also when there is only the synthesized
 * account: nothing can be bound to a file that does not exist, and an unreadable one already makes the
 * settings page report why.
 */
export function loadRoutingAccounts(nemaHome: string, config: NemaConfig, codexHome: string): { accounts: Account[]; bindings: Record<string, string> } {
  const loaded = loadAccounts(nemaHome, config, codexHome);
  const read = readAccounts(nemaHome);
  const bindings = read.status === "ok" ? read.file.bindings : {};
  return { accounts: projectedAccounts(loaded.accounts, config), bindings };
}
