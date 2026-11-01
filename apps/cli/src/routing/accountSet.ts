import type { NemaConfig } from "../config.js";
import { implicitAccount } from "../accounts/implicit.js";
import { readAccounts } from "../accounts/store.js";
import { projectedAccounts } from "../accounts/reconcile.js";
import { autoRoutingEnabled, type Account } from "../accounts/schema.js";

/**
 * The accounts this daemon can route over, read fresh for a task.
 *
 * Reading is what `loadAccounts` does — including synthesizing the one account D-6 describes when
 * `accounts.json` does not exist — plus the config projection, so a model changed by a rolled-back 0.2.0
 * applies before a task runs rather than only after the settings page is opened. Nothing is written: a
 * daemon start must not create `accounts.json`.
 *
 * The file is read **once**, and the accounts, the bindings and the error all come from that one result.
 * Reading it twice would let the two halves describe different versions of the file — the settings page
 * writes `accounts.json` under a lock that this read does not take — and a second read that failed would
 * quietly hand back `{}` for every binding, so every scope would lose the account it is bound to.
 *
 * An `accounts.json` that exists but cannot be trusted is an error, not a reason to route on the synthesized
 * account. The two are different situations and only one of them is the user's intent: a missing file means
 * "never configured accounts, keep doing what 0.2.0 did", while a corrupt or world-readable one means "there
 * are accounts here and none of them can be read". Falling back in the second case would run the task on the
 * legacy single credential and a config-projected endpoint — a different account from the one this machine is
 * set up for — without saying so. The adapters report this before routing; the sentence names the file.
 */
const UNUSABLE = "账户设置文件不可用（{reason}），已停止运行任务以免用错账户。请修好或移走 accounts.json 后重试。";

export type RoutingAccounts = {
  accounts: Account[];
  bindings: Record<string, string>;
  /**
   * The machine-wide automatic routing switch (D-3), from the same single read as everything else. A
   * missing file means the switch has never been set, which is off — the shipped default, and the reason a
   * machine that never configured accounts keeps behaving exactly as 0.2.0 did.
   */
  autoRouting: boolean;
};

export function loadRoutingAccounts(nemaHome: string, config: NemaConfig, codexHome: string): RoutingAccounts {
  // `codexHome` is accepted but not read here: `accounts.json` holds no credential and no Codex login, so
  // routing only needs the metadata. It stays in the signature because both adapters already hold it and
  // pass it, and because the next batch (automatic routing) needs it to tell a usable compat account from
  // one whose Codex login is gone. Marked unused on purpose rather than silently dropped.
  void codexHome;
  const read = readAccounts(nemaHome);
  if (read.status === "unusable") {
    // The same reason vocabulary `loadAccounts` reports, so the settings page and this sentence agree.
    throw new Error(UNUSABLE.replace("{reason}", read.reason));
  }
  if (read.status === "missing") {
    // First run, or a machine that never configured accounts: exactly what 0.2.0 did.
    return { accounts: projectedAccounts([implicitAccount(config, new Date())], config), bindings: {}, autoRouting: false };
  }
  return { accounts: projectedAccounts(read.file.accounts, config), bindings: read.file.bindings, autoRouting: autoRoutingEnabled(read.file) };
}
