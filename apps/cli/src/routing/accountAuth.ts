import { accountDir } from "../accounts/store.js";
import { IMPLICIT_ACCOUNT_ID, type Account } from "../accounts/schema.js";
import { accountCredentialState, implicitCredentialState, type CredentialState } from "../accounts/credentials.js";
import { DEFAULT_BYOK_BASE_URL, type NemaConfig } from "../config.js";
import { readAccountSecret } from "../secrets/accounts.js";
import { AuthStore, type Refresher, type StoredAuth } from "../direct/authStore.js";
import { ByokTokenSource } from "../direct/byok.js";
import { CodexFileTokenSource, defaultCodexHome } from "../direct/codexLogin.js";
import { siwcRefresher } from "../direct/siwc.js";
import { BYOK_PROFILE, COMPAT_PROFILE, SIWC_PROFILE, type TokenSource, type TransportProfile } from "../direct/transport.js";

/**
 * Where a routed account's credential comes from at run time, and which endpoint it talks to.
 *
 * The synthesized account keeps exactly the paths 0.2.0 used (`auth.json`, `byok-key`, `claude-code-token`
 * in the home directory): its files are never moved unless the user edits account settings (D-6), so a user
 * who never did keeps running with the layout they had. Every stored account reads its own directory.
 */

/** The model an account runs when it names none and the adapter picks one at run time. */
export const MODEL_FROM_LIST = "auto";

/**
 * The model this account would run, without asking any provider. `null` means the account cannot run at all:
 * a BYOK account with no default model has nothing to send, and the existing refusal names the command that
 * sets one.
 */
export function preferredModel(account: Account): string | null {
  if (account.model !== undefined) return account.model;
  // BYOK has no model catalog to fall back to: the endpoint is whatever the user pointed at.
  if (account.adapter === "codex-direct" && account.authMode === "byok") return null;
  // Claude Code runs its own default when no `--model` is given; the route record says so rather than
  // guessing a name it never sent.
  if (account.adapter === "claude-code") return CLAUDE_DEFAULT_MODEL;
  return MODEL_FROM_LIST;
}

/** What the route record says when the run passed no `--model`. Not a model name, and not presented as one. */
export const CLAUDE_DEFAULT_MODEL = "default";

/**
 * Whether this account can be started. The synthesized account is judged by the rules its single file has
 * always had (`implicitCredentialState`); a stored account by the account layout's.
 */
export function credentialStateOf(nemaHome: string, account: Account, codexHome: string): CredentialState {
  if (account.id === IMPLICIT_ACCOUNT_ID) return implicitCredentialState(nemaHome, account);
  return accountCredentialState(nemaHome, account, codexHome).state;
}

/** Reads a stored account's key or token; the implicit account keeps its old single file. */
export class AccountSecretTokenSource implements TokenSource {
  constructor(
    private readonly nemaHome: string,
    private readonly accountId: string,
    private readonly kind: "key" | "token",
  ) {}

  async getAccessToken(): Promise<{ accessToken: string; auth: StoredAuth }> {
    const accessToken = readAccountSecret(this.nemaHome, this.accountId, this.kind);
    return {
      accessToken,
      auth: { version: 1, mode: this.kind === "key" ? "byok" : "compat", clientId: "", tokens: { access_token: accessToken, refresh_token: "" }, lastRefresh: "" },
    };
  }

  async recordAuthError(): Promise<void> {
    /* A key or token file carries no place to record an error, and rewriting it would lose the value. */
  }
}

export type AccountTransport = { source: TokenSource; profile: TransportProfile };

const isImplicit = (account: Account): boolean => account.id === IMPLICIT_ACCOUNT_ID;

/**
 * The token source and endpoint for one codex-direct account. `profile` overrides win, so a test can point
 * every account at one fake server without the account's own base URL.
 */
export function codexTransportFor(o: {
  nemaHome: string;
  account: Account;
  codexHome: string;
  now?: () => number;
  refresher?: Refresher;
  profile?: TransportProfile;
}): AccountTransport {
  const { account } = o;
  if (account.adapter !== "codex-direct") throw new Error("account is not codex-direct");
  if (account.authMode === "compat") {
    return { source: new CodexFileTokenSource(o.codexHome, o.now), profile: o.profile ?? COMPAT_PROFILE };
  }
  if (account.authMode === "byok") {
    return {
      source: isImplicit(account) ? new ByokTokenSource(o.nemaHome) : new AccountSecretTokenSource(o.nemaHome, account.id, "key"),
      profile: o.profile ?? { ...BYOK_PROFILE, baseUrl: account.baseUrl ?? DEFAULT_BYOK_BASE_URL },
    };
  }
  return {
    source: new AuthStore(
      o.nemaHome,
      o.refresher ?? siwcRefresher,
      o.now ?? Date.now,
      // An account refreshes its own login under its own lock; the synthesized one keeps the home layout.
      isImplicit(account) ? {} : { baseDir: accountDir(o.nemaHome, account.id) },
    ),
    profile: o.profile ?? SIWC_PROFILE,
  };
}

/** The Claude Code token for one account: its own file, or the old single file for the synthesized account. */
export function claudeTokenFor(nemaHome: string, account: Account): string {
  if (isImplicit(account)) throw new Error("implicit claude account has no stored token path");
  return readAccountSecret(nemaHome, account.id, "token");
}

export { defaultCodexHome };
export type { NemaConfig };
