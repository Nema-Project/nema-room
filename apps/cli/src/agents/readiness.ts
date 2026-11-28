// First-run agent readiness (#302): can the machine running this daemon run each model runtime? Judged from
// local files and one `--version`, never from a request (D-3), so "configured" means configured, not verified.
import type { ReadinessReason, ReadinessReply, ReadinessRuntime, RuntimeReadiness } from "@nema/shared";
import { AGENT_CLIS, classifyVersion, type VersionProbe } from "../agentClis.js";
import { implicitCredentialReadiness, type CredentialState } from "../accounts/credentials.js";
import { IMPLICIT_ACCOUNT_ID, type Account } from "../accounts/schema.js";
import type { NemaConfig } from "../config.js";
import { loadRoutingAccounts, type RoutingAccounts } from "../routing/accountSet.js";
import { credentialStateOf, preferredModel } from "../routing/accountAuth.js";
import { defaultAccountFor } from "../routing/defaultAccount.js";

export type ReadinessInput = {
  nemaHome: string;
  codexHome: string;
  config: NemaConfig;
  /** Bypass the `--version` success cache (the "check again" button). */
  force?: boolean;
  probe: VersionProbe;
  now?: () => Date;
  /** The environment whose PATH the ENOENT lookup walks; the daemon's own by default, as `--version` uses. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Tests only: the account list and the credential check. */
  loadAccounts?: (nemaHome: string, config: NemaConfig, codexHome: string) => RoutingAccounts;
  inspect?: (account: Account) => CredentialState;
};

const CLAUDE = AGENT_CLIS.find((cli) => cli.id === "claude-code")!;

const unknown = (runtime: ReadinessRuntime, reason: ReadinessReason): RuntimeReadiness => ({ runtime, state: "unknown", reason });

/** Which account was judged: its id, whether it is the synthesized one, and its auth mode. Nothing else. */
function accountRef(account: Account): NonNullable<RuntimeReadiness["account"]> {
  return {
    id: account.id,
    implicit: account.id === IMPLICIT_ACCOUNT_ID,
    ...(account.adapter === "codex-direct" && account.authMode !== undefined ? { authMode: account.authMode } : {}),
  };
}

/**
 * The runtime's default account (the one a task with no choice runs on), judged. A stored account uses the
 * routing check; the synthesized account its own legacy file, since routing's check passes every non-SIWC
 * synthesized account through and would call a first-run user with no key "configured" (D-1).
 */
function judgeAccount(runtime: ReadinessRuntime, accounts: Account[], inspect: (account: Account) => CredentialState): Omit<RuntimeReadiness, "cli"> {
  const account = defaultAccountFor(accounts, runtime);
  if (account === undefined) return { runtime, state: "not_signed_in", reason: "no_enabled_account" };
  const ref = accountRef(account);
  let credential: CredentialState;
  try {
    credential = inspect(account);
  } catch {
    return { runtime, state: "unknown", reason: "inspect_failed", account: ref };
  }
  if (credential === "missing") return { runtime, state: "not_signed_in", account: ref };
  if (credential === "unusable") return { runtime, state: "credential_unusable", account: ref };
  // The same check `checkNamed` makes after the credential: a BYOK account with no model is refused.
  if (preferredModel(account) === null) return { runtime, state: "needs_model", account: ref };
  return { runtime, state: "configured", account: ref };
}

export async function computeReadiness(o: ReadinessInput): Promise<ReadinessReply> {
  const now = o.now ?? (() => new Date());
  const load = o.loadAccounts ?? loadRoutingAccounts;
  const inspect = o.inspect ?? ((account: Account) => account.id === IMPLICIT_ACCOUNT_ID
    ? implicitCredentialReadiness(o.nemaHome, account, o.codexHome)
    : credentialStateOf(o.nemaHome, account, o.codexHome));
  const reply = (runtimes: RuntimeReadiness[]): ReadinessReply => ({ current: o.config.adapter, runtimes, checkedAt: now().toISOString() });

  // One read for both rows, so they describe the same version of the file.
  let accounts: Account[];
  try {
    accounts = load(o.nemaHome, o.config, o.codexHome).accounts;
  } catch {
    return reply([unknown("codex-direct", "inspect_failed"), unknown("claude-code", "inspect_failed")]);
  }

  const codex: RuntimeReadiness = judgeAccount("codex-direct", accounts, inspect);

  // claude-code: the command first; only a command that answers gets its account judged.
  const probed = classifyVersion(CLAUDE.command, await o.probe.version(CLAUDE.command, { force: o.force === true }), o.env ?? process.env, o.platform ?? process.platform);
  const cli = { command: CLAUDE.command, version: probed.kind === "ok" ? probed.version : null, installUrl: CLAUDE.installUrl };
  let claude: RuntimeReadiness;
  if (probed.kind === "ok") claude = { ...judgeAccount("claude-code", accounts, inspect), cli };
  else if (probed.kind === "not_found") claude = { runtime: "claude-code", state: "not_installed", cli };
  else if (probed.kind === "broken") claude = { ...unknown("claude-code", "cli_broken"), cli };
  else if (probed.kind === "timeout") claude = { ...unknown("claude-code", "cli_timeout"), cli };
  else claude = { ...unknown("claude-code", "cli_error"), cli };

  return reply([codex, claude]);
}
