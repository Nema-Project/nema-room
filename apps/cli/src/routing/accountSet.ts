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
 * An `accounts.json` that exists but cannot be trusted is an error, not a reason to route on the synthesized
 * account. The two are different situations and only one of them is the user's intent: a missing file means
 * "never configured accounts, keep doing what 0.2.0 did", while a corrupt or world-readable one means "there
 * are accounts here and none of them can be read". Falling back in the second case would run the task on the
 * legacy single credential and a config-projected endpoint — a different account from the one this machine is
 * set up for — without saying so. The adapters report this before routing; the sentence names the file.
 */
const UNUSABLE = "账户设置文件不可用（{reason}），已停止运行任务以免用错账户。请修好或移走 accounts.json 后重试。";

export function loadRoutingAccounts(nemaHome: string, config: NemaConfig, codexHome: string): { accounts: Account[]; bindings: Record<string, string> } {
  const loaded = loadAccounts(nemaHome, config, codexHome);
  if (loaded.unusableReason !== undefined) {
    throw new Error(UNUSABLE.replace("{reason}", loaded.unusableReason));
  }
  const read = readAccounts(nemaHome);
  const bindings = read.status === "ok" ? read.file.bindings : {};
  return { accounts: projectedAccounts(loaded.accounts, config), bindings };
}
