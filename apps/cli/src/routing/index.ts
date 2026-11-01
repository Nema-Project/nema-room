import type { RouteDecision, TaskAssign } from "@nema/shared";
import type { NemaConfig } from "../config.js";
import { IMPLICIT_ACCOUNT_ID, type Account } from "../accounts/schema.js";
import type { CredentialState } from "../accounts/credentials.js";
import type { Cooldowns } from "./cooldown.js";
import { UNUSABLE_FILE_MESSAGE } from "../direct/authStore.js";
import { BYOK_MODEL_REQUIRED, MISSING_BYOK_KEY, MISSING_CLAUDE_TOKEN, MISSING_CODEX_LOGIN, NOT_LOGGED_IN } from "./messages.js";
import { computeCandidates, type Candidate, type CandidateSet, type Excluded } from "./candidates.js";
import { taskNeeds, type TaskNeeds } from "./capabilities.js";

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
export type RouteRefusal = "unknown_account" | "adapter_mismatch" | "credential_missing" | "credential_unusable" | "model_missing" | "no_account" | "no_candidate" | "auto_unavailable";

/**
 * Why this account was chosen. The four user/default codes are what manual mode reports; the three automatic
 * ones are what automatic mode reports, and they are the same vocabulary `RouteDecision.reason` uses.
 */
export type RouteSource = "user_message" | "user_thread" | "user_workspace" | "default" | "auto_primary";

export type RouteResult =
  | {
    ok: true;
    account: Account;
    model: string;
    mode: "manual" | "auto";
    reason: RouteSource;
    excluded: Excluded[];
    /**
     * The candidates automatic routing may move to, best first, starting with `account`. Present only in
     * automatic mode: a manual choice is the user's decision and a failover would override it.
     *
     * Handed back rather than recomputed by the adapter, so the list the details panel shows and the order a
     * switch follows are the same decision.
     */
    autoCandidates?: Candidate[];
  }
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
function label(account: Pick<Account, "id" | "name">): string {
  return SECRET_LIKE.test(account.name.trim()) ? `账户 ${account.id}` : `账户「${account.name}」`;
}

/** The same rule for every sentence that names an account, including the failover progress line. */
export { label as accountLabel };

/** Why an account was set aside, in the user's terms. The code itself stays in `excluded` for the UI. */
const EXCLUSION_WORDS: Record<Excluded["reason"], string> = {
  disabled: "已停用",
  credential_missing: "没有凭据",
  credential_unusable: "凭据不可用",
  compat_unreadable: "读不到 Codex 登录",
  cooling: "刚被限流，冷却中",
  capability: "没有声明所需能力",
  model_missing: "没有默认模型",
};

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

  // A choice that asks for automatic routing — on this message or through a binding — is honoured only when
  // the switch is on. With it off the request fails and says where the switch is (D-3): running the task on
  // the default account instead would spend an account the user did not choose.
  const choice = choose(task, req.bindings);
  if (task.routing === "auto" || choice?.kind === "auto") {
    if (!req.autoRouting) return { ok: false, failure: "auto_unavailable", error: AUTO_OFF_MESSAGE, excluded: set.excluded };
    return autoRoute(set, req);
  }

  // The `auto` case returned above, so what is left is an account id or nothing to go on.
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
 * Automatic mode: the first candidate answers, the rest are what a failure may move to (spec §4.2, D-4).
 *
 * With no candidate at all the task fails *before any request*, naming what every other account was missing.
 * That is the whole point of D-4 A: an automatic choice must never be a guess, so an account that has not
 * declared the ability this task needs is not picked, and the user is told which declaration to add rather
 * than handed a provider error later.
 */
function autoRoute(set: CandidateSet, req: RouteRequest): RouteResult {
  const first = set.candidates[0];
  if (first === undefined) {
    return { ok: false, failure: "no_candidate", error: refusalMessage(req.adapter, taskNeeds(req.task), set.excluded), excluded: set.excluded };
  }
  // The credential is checked for the head of the list only. The rest were filtered on it by
  // `computeCandidates`, and a later one that has become unusable since then fails when it is tried.
  const state = req.credentialOf(first.account);
  if (state !== "connected") {
    return { ok: false, failure: state === "unusable" ? "credential_unusable" : "credential_missing", error: credentialMessage(first.account, state), excluded: set.excluded };
  }
  return {
    ok: true,
    account: first.account,
    model: first.model,
    mode: "auto",
    reason: "auto_primary",
    excluded: set.excluded,
    autoCandidates: set.candidates,
  };
}

/**
 * Why no account could take this task, in terms of the task's attachments.
 *
 * The sentence names the missing abilities and lists the accounts set aside for them, because "no account"
 * alone leaves the user with nothing to do: the fix is either declaring the ability on an account or naming
 * one that has it.
 */
function refusalMessage(adapter: Account["adapter"], needs: TaskNeeds, excluded: Excluded[]): string {
  const missing = (["image", "pdf"] as const).filter((need) => needs[need] === true);
  const names = missing.map((need) => (need === "image" ? "图片" : "PDF")).join("、");
  const describe = (e: Excluded): string => label({ id: e.accountId, name: e.accountName });
  const incapable = excluded.filter((e) => e.reason === "capability");
  // An image or PDF on the task is not itself a capability refusal. That sentence is only honest when at
  // least one account was set aside for capability; a cooldown or a missing credential has to name itself.
  if (missing.length > 0 && incapable.length > 0) {
    const who = `：${incapable.map(describe).join("、")} 没有声明这项能力`;
    return `没有账户声明支持${names}，无法自动选择${who}。请在设置页为账户打开对应的能力声明，或在这条消息上指定一个支持它的账户。`;
  }
  // No capability was the obstacle, so the other exclusions are: name them rather than say "none".
  const why = excluded.length > 0 ? `：${excluded.map((e) => `${describe(e)}（${EXCLUSION_WORDS[e.reason]}）`).join("、")}` : "";
  return `没有可用的 ${adapter} 账户，无法自动选择${why}。请在设置页检查账户的启用状态与凭据。`;
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
