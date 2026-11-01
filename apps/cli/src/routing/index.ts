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

export type RouteFailure = "unknown_account" | "account_disabled" | "adapter_mismatch" | "credential_missing" | "credential_unusable" | "model_missing" | "no_account" | "auto_unavailable";

export type RouteSource = "user_message" | "user_thread" | "user_workspace" | "default";

export type RouteResult =
  | { ok: true; account: Account; model: string; mode: "manual" | "auto"; reason: RouteSource; excluded: Excluded[] }
  | { ok: false; failure: RouteFailure; error: string; excluded: Excluded[] };

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
};

/** A name is user text and can be anything; one that looks like a credential is replaced by the id. */
const SECRET_LIKE = /^[A-Za-z0-9_\-+/=]{20,}$/;

function label(account: Account): string {
  return SECRET_LIKE.test(account.name.trim()) ? `账户 ${account.id}` : `账户「${account.name}」`;
}

const AUTO_MESSAGE = "自动路由将在后续版本提供，本版本请指定账户或不指定（用默认账户）";

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

  if (task.routing === "auto") return { ok: false, failure: "auto_unavailable", error: AUTO_MESSAGE, excluded: set.excluded };
  const choice = choose(task, req.bindings);
  if (choice !== null && choice.kind === "auto") {
    return { ok: false, failure: "auto_unavailable", error: AUTO_MESSAGE, excluded: set.excluded };
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
  if (!account.enabled) {
    return { ok: false, failure: "account_disabled", error: `${label(account)} 已停用。请在设置页启用它，或换一个账户。` };
  }
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
