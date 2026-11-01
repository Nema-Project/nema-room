import type { RouteDecision, TaskAssign } from "@nema/shared";
import type { NemaConfig } from "../config.js";
import { IMPLICIT_ACCOUNT_ID, type Account } from "../accounts/schema.js";
import type { CredentialState } from "../accounts/credentials.js";
import type { Cooldowns } from "./cooldown.js";
import { UNUSABLE_FILE_MESSAGE } from "../direct/authStore.js";
import { BYOK_MODEL_REQUIRED, MISSING_BYOK_KEY, MISSING_CLAUDE_TOKEN, MISSING_CODEX_LOGIN, NOT_LOGGED_IN } from "./messages.js";
import { computeCandidates, type Excluded } from "./candidates.js";
import { taskNeeds } from "./capabilities.js";

/**
 * Turning one task into one account and one model (spec 2026-10-31 §4.1 step 2).
 *
 * This batch has one path: the account the user named, on the message, in the thread, or in the workspace,
 * and otherwise the machine's default. Automatic routing arrives in the next batch, and until then an
 * explicit request for it fails rather than quietly running on the default — a user who asked for automatic
 * failover must not get a silent single-account run instead.
 *
 * A named account is not filtered: not by capability, not by enabled, not by cooldown (D-4 A). The user
 * said which one, and the job here is to run it and report what happened. Only the credential is checked,
 * because a missing key cannot produce a result and failing here names the account instead of surfacing a
 * provider 401 later.
 */

/**
 * Why a task could not be given an account at all, as opposed to why one account's model call failed.
 *
 * Named `RouteRefusal`, not `RouteFailure`: `./errors.ts` already exports a `RouteFailure` for the *model
 * call* classification (`rate_limit` / `quota` / ...). The two answer different questions — "could this task
 * start" versus "did this request fail, and is another account worth trying" — and having one name for both
 * meant an import could silently pick up the wrong vocabulary. The failure kinds keep the name because that
 * is the one the plan and the spec use for them; this one is a refusal.
 *
 * `account_disabled` is gone: a named account is no longer refused for being disabled (see `checkNamed`).
 */
export type RouteRefusal = "unknown_account" | "adapter_mismatch" | "credential_missing" | "credential_unusable" | "model_missing" | "no_account" | "auto_unavailable";

export type RouteSource = "user_message" | "user_thread" | "user_workspace" | "default";

export type RouteResult =
  | { ok: true; account: Account; model: string; mode: "manual" | "auto"; reason: RouteSource; excluded: Excluded[] }
  | { ok: false; failure: RouteRefusal; error: string; excluded: Excluded[] };

export type RouteRequest = {
  task: TaskAssign;
  config: NemaConfig;
  /**
   * The adapter that is actually running this task. Not derived from the task or the config here: the runner
   * already chose it by name, and re-deriving it from `config.adapter` would route a Claude task among the
   * Codex accounts whenever the file names the other adapter.
   */
  adapter: Account["adapter"];
  accounts: Account[];
  bindings: Record<string, string>;
  cooldowns: Cooldowns;
  credentialOf: (a: Account) => CredentialState;
  resolveModel: (a: Account) => string | null;
  /**
   * The machine-wide automatic routing switch (D-3). Passed in rather than read from the file here, so this
   * function stays a pure decision over its arguments and a caller cannot accidentally route automatically
   * by forgetting to read the file.
   */
  autoRouting: boolean;
};

/** A name is user text and can be anything; one that looks like a credential is replaced by the id. */
const SECRET_LIKE = /^[A-Za-z0-9_\-+/=]{20,}$/;

/** How an account is named in a sentence. A name that looks like a credential is replaced by its id. */
function label(account: Account): string {
  return SECRET_LIKE.test(account.name.trim()) ? `账户 ${account.id}` : `账户「${account.name}」`;
}

/**
 * The sentence for `routing: "auto"` while the switch is off.
 *
 * It has to be a refusal, not a fallback: automatic routing changes whose quota pays for the task and which
 * endpoint answers it, so a user who asked for it must never get a silent single-account run instead (D-3).
 * The second half says where the switch is, because a refusal with no way forward is just an error.
 */
const AUTO_OFF_MESSAGE = "自动路由未开启。请在设置页的账户分组里打开「自动路由」，或在这条消息、这个 thread、这个工作区里指定一个账户。";

/**
 * The account id the choice resolves to, with where the choice came from. `"auto"` is a real value in a
 * binding (spec §2.2), and this version cannot honour it, so it is reported as such rather than skipped.
 */
function choose(task: TaskAssign, bindings: Record<string, string>): { kind: "account"; id: string; source: RouteSource } | { kind: "auto"; source: RouteSource } | null {
  if (task.accountId !== undefined) return { kind: "account", id: task.accountId, source: "user_message" };
  if (task.threadId !== undefined) {
    const bound = bindings[`thread:${task.threadId}`];
    if (bound !== undefined) return bound === "auto" ? { kind: "auto", source: "user_thread" } : { kind: "account", id: bound, source: "user_thread" };
  }
  const ws = bindings[`ws:${task.workspaceId}`];
  if (ws !== undefined) return ws === "auto" ? { kind: "auto", source: "user_workspace" } : { kind: "account", id: ws, source: "user_workspace" };
  return null;
}

/**
 * One task, one account and one model — the whole decision in one place, in manual mode only (this batch).
 *
 * Order of precedence is the message, then the thread, then the workspace, then the machine's default, and
 * the resulting record says which of those it was. A named account is honoured as given: capability,
 * enabled state and cooldown are not consulted, only the credential, because the user already decided and
 * a missing key is the one thing that cannot produce an answer. Automatic routing is refused here rather
 * than approximated, so a user who asked for failover is never handed a silent single-account run.
 */
export function resolveRoute(req: RouteRequest): RouteResult {
  const { task, adapter } = req;
  const needs = taskNeeds(task);

  // Computed once for every path: the details panel shows why the other accounts were not used, whether the
  // answer is an account or a failure.
  const set = computeCandidates({
    accounts: req.accounts,
    adapter,
    needs,
    credentialOf: req.credentialOf,
    coolingUntil: (id) => req.cooldowns.until(id),
    now: Date.now,
    resolveModel: req.resolveModel,
  });

  if (task.routing === "auto") return { ok: false, failure: "auto_unavailable", error: AUTO_OFF_MESSAGE, excluded: set.excluded };
  const choice = choose(task, req.bindings);
  if (choice !== null && choice.kind === "auto") {
    return { ok: false, failure: "auto_unavailable", error: AUTO_OFF_MESSAGE, excluded: set.excluded };
  }

  if (choice === null) {
    const enabled = req.accounts
      .filter((a) => a.adapter === adapter && a.enabled)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const target = enabled[0];
    if (target === undefined) {
      return {
        ok: false,
        failure: "no_account",
        error: `这台机器上没有启用的 ${adapter} 账户。请在设置页添加一个账户并填写凭据。`,
        excluded: set.excluded,
      };
    }
    return { ...checkNamed(target, "default", req, adapter), excluded: set.excluded };
  }

  const target = req.accounts.find((a) => a.id === choice.id);
  if (target === undefined) {
    // The id came from another machine's database, or a binding outlived the account. Say so instead of
    // falling back: the user's choice silently becoming a different account is exactly what this must not do.
    return {
      ok: false,
      failure: "unknown_account",
      error: `本条消息指定的账户 ${choice.id} 在这台机器上不存在。请在设置页确认账户，或改用默认账户。`,
      excluded: set.excluded,
    };
  }
  return { ...checkNamed(target, choice.source, req, adapter), excluded: set.excluded };
}

/**
 * The sentence for a credential that is not there.
 *
 * The synthesized account keeps the wording 0.2.0 printed, including the command it names: its credential
 * really does live at the old path, so `nema auth login` is still the thing to run. A stored account's
 * credential is in its own directory, which none of those commands writes, so it is named and pointed at the
 * settings page instead.
 */
function credentialMessage(account: Account, state: CredentialState): string {
  if (account.id === IMPLICIT_ACCOUNT_ID) {
    // The 0.2.0 sentence for a login that is there but cannot be trusted, verbatim: it names the one thing
    // to run, and this account's file is the file that command rewrites.
    if (state === "unusable") return UNUSABLE_FILE_MESSAGE;
    if (account.adapter === "claude-code") return MISSING_CLAUDE_TOKEN;
    if (account.authMode === "byok") return MISSING_BYOK_KEY;
    if (account.authMode === "compat") return MISSING_CODEX_LOGIN;
    return NOT_LOGGED_IN;
  }
  return state === "unusable"
    ? `${label(account)} 的凭据不可用（权限、符号链接或内容有问题），请在设置页重新填写。`
    : `${label(account)} 还没有凭据，请在设置页填写后再运行。`;
}

/** The same for a missing model: the old command for the synthesized account, the settings page otherwise. */
function modelMessage(account: Account): string {
  if (account.id === IMPLICIT_ACCOUNT_ID && account.adapter === "codex-direct" && account.authMode === "byok") {
    return BYOK_MODEL_REQUIRED;
  }
  return `${label(account)} 没有默认模型。请在设置页为它指定一个模型。`;
}

/**
 * The checks a named (or default) account still gets. Deliberately short: capability, enabled state and
 * cooldown are not consulted for an account the user chose.
 */
function checkNamed(
  account: Account,
  source: RouteSource,
  req: RouteRequest,
  adapter: Account["adapter"],
): Omit<Extract<RouteResult, { ok: true }>, "excluded"> | Omit<Extract<RouteResult, { ok: false }>, "excluded"> {
  if (account.adapter !== adapter) {
    return {
      ok: false,
      failure: "adapter_mismatch",
      error: `${label(account)} 属于 ${account.adapter}，这个任务按 ${adapter} 运行，不能在它上面跑。`,
    };
  }
  // Enabled state is deliberately not checked here. Spec step 2: a named account "is not excluded for
  // capability, enabled state or cooldown" — the only thing that still stops it is the credential itself.
  // Disabling an account is how a user parks it against automatic selection; it is not a reason to refuse
  // an account they then named explicitly, and refusing would also make the setting mean two different
  // things in two modes. The default path above still picks only enabled accounts, which is where the flag
  // has its effect.
  // The credential is checked before anything runs, so the sentence can name the account instead of leaving a
  // provider 401 in the chat. `credentialOf` decides what "usable" means for this account kind; a key or a
  // token whose own reader has a better sentence is left to it.
  const state = req.credentialOf(account);
  if (state !== "connected") {
    return {
      ok: false,
      failure: state === "unusable" ? "credential_unusable" : "credential_missing",
      error: credentialMessage(account, state),
    };
  }
  const model = req.resolveModel(account);
  if (model === null) {
    return { ok: false, failure: "model_missing", error: modelMessage(account) };
  }
  return { ok: true, account, model, mode: "manual", reason: source };
}

/** The record stored on the message. Attempts stay empty in this batch: nothing is retried or switched. */
export function routeDecision(result: Extract<RouteResult, { ok: true }>, model: string): RouteDecision {
  return {
    accountId: result.account.id,
    accountName: result.account.name,
    model,
    mode: result.mode,
    reason: result.reason,
  };
}

export { taskNeeds } from "./capabilities.js";
export { computeCandidates, type Candidate, type CandidateSet, type Excluded } from "./candidates.js";
export { Cooldowns, cooldownFor } from "./cooldown.js";
export { classifyFailure, shouldSwitch, type RouteFailure as FailureKind, type SwitchDecision } from "./errors.js";
