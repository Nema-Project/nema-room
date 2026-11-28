import type { Account } from "../accounts/schema.js";

/**
 * The account a task runs on when nobody chose one: the adapter's enabled accounts, by `order` then id.
 *
 * This is the rule `resolveRoute` applies on its default branch. `resolveRoute` is deliberately left as it is
 * (#302 spec "不做"), so readiness uses this function and a test checks the two against each other on the same
 * account sets; a change to either rule fails that test instead of drifting silently.
 */
export function defaultAccountFor(accounts: readonly Account[], adapter: Account["adapter"]): Account | undefined {
  return accounts
    .filter((a) => a.adapter === adapter && a.enabled)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))[0];
}
