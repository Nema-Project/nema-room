import { randomUUID } from "node:crypto";
import type { RouteAttempt, RouteDecision, TaskAssign, TaskEvent } from "@nema/shared";
import { attachmentCapabilities, refusal } from "../attachments/capabilities.js";
import { attachmentLabel, attachmentPreamble, textAttachmentBlock } from "../attachments/blocks.js";
import { loadTaskAttachments, type LoadedAttachment } from "../attachments/fetch.js";
import { configErrorMessage, loadConfig, type NemaConfig } from "../config.js";
import type { AgentAdapter, AgentResult } from "../daemon/runner.js";
import type { Account } from "../accounts/schema.js";
import { RoomClient } from "../room/client.js";
import { attachmentRejection, type ContentBlockOwner } from "./attachmentErrors.js";
import { ReloginRequiredError, type Refresher } from "./authStore.js";
import { CodexFileTokenSource, defaultCodexHome } from "./codexLogin.js";
import { DEFAULT_LIMITS, runToolLoop } from "./loop.js";
import { MODEL_FROM_LIST, codexTransportFor, credentialStateOf, preferredModel } from "../routing/accountAuth.js";
import { loadRoutingAccounts, type RoutingAccounts } from "../routing/accountSet.js";
import { Cooldowns, cooldownFor } from "../routing/cooldown.js";
import { AutoRouter, ReasoningGuard } from "../routing/auto.js";
import { classifyFailure, shouldSwitch, type RouteFailure } from "../routing/errors.js";
import { resolveRoute, routeDecision, type RouteResult } from "../routing/index.js";
import type { Candidate } from "../routing/candidates.js";
import { roomTools } from "./tools.js";
import { prepareDirectSkills } from "../skills/direct.js";
import {
  ByokRejectedError,
  listModels,
  ModelApiError,
  ModelQuotaError,
  streamResponse,
  type InputContentPart,
  type InputItem,
  type TokenSource,
  type TransportContext,
  type TransportProfile,
} from "./transport.js";

// codex-direct (spec 6.7): runs Nema's own tool loop in the daemon against the Responses API with the user's
// Nema login. The model gets the 4 Room functions plus the task's plugin tools. Failures are reported, never retried via codex-cli.

export { NOT_LOGGED_IN } from "../routing/messages.js";
export const RUN_TIMEOUT_MESSAGE = "Codex 直连运行超时";
export const DIRECT_USER_TEXT = "请按上面的指令处理本次用户消息，并只通过提供的函数读写项目知识。";
export const FALLBACK_MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 600_000;
/** Minimum gap between streamed `agent_message` progress events. */
const PROGRESS_INTERVAL_MS = 500;
/** The hub shows progress as one replaced line; keep only the tail of long texts. */
const PROGRESS_MAX_CHARS = 2000;

export type CodexDirectAdapterOptions = {
  nemaHome: string;
  version: string;
  profile?: TransportProfile;
  timeoutMs?: number;
  now?: () => number;
  /** Token refresher (defaults to SIWC). Unused when authMode is compat or byok. */
  refresher?: Refresher;
  /** Codex CLI home whose auth.json compat mode reads. Defaults to $CODEX_HOME or ~/.codex. */
  codexHome?: string;
  /** Request body cap (defaults to MAX_DIRECT_REQUEST_BYTES); tests lower it. */
  maxRequestBytes?: number;
  /**
   * The accounts this daemon can route over, read fresh for each task. Defaults to reading `accounts.json`
   * (with the synthesized account when there is none) and the `config.json` projection.
   */
  accounts?: () => RoutingAccounts;
  /** Cooldowns shared by both adapters in one daemon process (spec §4.4 is process-wide). */
  cooldowns?: Cooldowns;
};

/**
 * How long the provider itself said to wait, when it said anything.
 *
 * Only a quota error carries a provider-stated reset today (`resetsAt`, from `resets_at` /
 * `resets_in_seconds`). A 429's `Retry-After` header is not surfaced by the transport, so for a plain rate
 * limit the cooldown falls back to its own documented rule of thumb rather than inventing a number here.
 */
function providerRetryAfterMs(e: unknown, now: number): number | undefined {
  if (e instanceof ModelQuotaError && e.resetsAt !== undefined) {
    const wait = e.resetsAt - now;
    return wait > 0 ? wait : undefined;
  }
  return undefined;
}

/** A route that cannot run: the sentence names the account and what is wrong with it. */
function routeFailure(result: Extract<RouteResult, { ok: false }>): AgentResult {
  return { ok: false, error: result.error };
}

/**
 * The attachment parts of the first user message: preamble, then each attachment (native ones labeled), and
 * what each block of that message carries (index 0 is the user text the tool loop puts first).
 */
function attachmentParts(attachments: readonly LoadedAttachment[]): { parts: InputContentPart[]; blocks: ContentBlockOwner[] } {
  if (attachments.length === 0) return { parts: [], blocks: [] };
  const parts: InputContentPart[] = [{ type: "input_text", text: attachmentPreamble() }];
  const blocks: ContentBlockOwner[] = [null, null];
  for (const a of attachments) {
    if (a.kind === "text") {
      parts.push({ type: "input_text", text: textAttachmentBlock(a) });
      blocks.push({ kind: a.kind, name: a.name });
      continue;
    }
    const data = `data:${a.mime};base64,${a.bytes.toString("base64")}`;
    parts.push({ type: "input_text", text: attachmentLabel(a) });
    parts.push(a.kind === "image" ? { type: "input_image", image_url: data } : { type: "input_file", filename: a.name, file_data: data });
    blocks.push(null, { kind: a.kind, name: a.name });
  }
  return { parts, blocks };
}

class RunTimeoutError extends Error {
  constructor() {
    super(RUN_TIMEOUT_MESSAGE);
    this.name = "RunTimeoutError";
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local time as `YYYY-MM-DD HH:mm`. */
export function formatLocalTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function errorMessage(e: unknown): string {
  if (e instanceof RunTimeoutError || e instanceof ReloginRequiredError || e instanceof ByokRejectedError) return e.message;
  if (e instanceof ModelQuotaError) {
    if (e.code === "subscription_sharing_usage_unavailable") return "订阅额度暂时不可用，请稍后重试";
    if (e.code === "usage_not_included") return "当前订阅不包含此用量";
    return "订阅额度已用完" + (e.resetsAt !== undefined ? `，预计 ${formatLocalTime(e.resetsAt)} 恢复` : "");
  }
  if (e instanceof ModelApiError) return "模型接口错误：" + e.message;
  return e instanceof Error ? e.message : String(e);
}

/** What has actually left the process, so a failure can say which model failed and whether text was seen. */
type SentState = { blocks?: ContentBlockOwner[]; model?: string; text?: boolean; wrote?: boolean };

/**
 * One account's credential and endpoint for as long as the task runs on it.
 *
 * A failover builds a new one rather than mutating the old: the token source is bound to a key or a login, and
 * reusing it would send the previous account's credential with the next account's model.
 */
type Session = { account: Account; model: string | undefined; source: TokenSource; profile: TransportProfile };

type AccountPlanOptions = {
  route: Extract<RouteResult, { ok: true }>;
  nemaHome: string;
  codexHome: string;
  sent: SentState;
  cooldowns: Cooldowns;
  now?: () => number;
  refresher?: Refresher;
  profile?: TransportProfile;
  onEvent: (e: TaskEvent) => void;
};

/**
 * Which account the task is on, and when to move to another one (spec 2026-10-31 §4.3, §4.4).
 *
 * It holds the two things a failover needs and keeps them consistent with each other:
 *
 *   - the current `Session`, rebuilt for each account (a new token source and a new endpoint profile);
 *   - the `ReasoningGuard`, which drops the reasoning produced before the last switch, because the next
 *     account cannot decrypt it.
 *
 * `advance()` is the only place a decision to move is made, and it takes the error rather than the call site
 * deciding: classification, the "is another account worth trying" rule, the cooldown, the progress line and the
 * reasoning drop all happen together or not at all. A manual run never reaches it.
 */
class AccountPlan {
  session: Session;
  private readonly auto: AutoRouter | null;
  private readonly guard = new ReasoningGuard();
  private readonly route: AccountPlanOptions["route"];
  private readonly o: AccountPlanOptions;

  constructor(o: AccountPlanOptions) {
    this.o = o;
    this.route = o.route;
    const candidates = o.route.autoCandidates;
    // Automatic mode only. A manual choice is the user's decision, so there is no list to move along and a
    // failure is reported rather than retried elsewhere.
    this.auto = candidates === undefined
      ? null
      : new AutoRouter({
        candidates,
        cooldowns: o.cooldowns,
        startedOutput: () => o.sent.text === true,
        onSwitch: (from, to, failure) => {
          // The guard is told before the request is made, not after: the very next call is already on the new
          // account and must not carry the old account's ciphertext.
          this.guard.switched();
          o.onEvent({ type: "progress", text: switchMessage(from.account, to.account, failure) });
        },
      });
    // The router starts on the account that was routed: `autoRoute` builds the candidate list with the chosen
    // account first, so the first pick is that account. Without it `current()` is null and every failure would
    // look like "nothing to move from", which is how a failover silently never happens.
    const first = this.auto?.next() ?? null;
    if (first === null) {
      this.session = this.build(o.route.account, o.route.model);
    } else {
      this.session = this.build(first.account, first.model);
    }
  }

  private build(account: Account, model: string): Session {
    const transport = codexTransportFor({
      nemaHome: this.o.nemaHome,
      account,
      codexHome: this.o.codexHome,
      ...(this.o.now ? { now: this.o.now } : {}),
      ...(this.o.refresher ? { refresher: this.o.refresher } : {}),
      ...(this.o.profile ? { profile: this.o.profile } : {}),
    });
    return { account, model: model === MODEL_FROM_LIST ? undefined : model, source: transport.source, profile: transport.profile };
  }

  /** The history to send on the current account: everything, minus reasoning from an account the task has left. */
  history(history: InputItem[]): InputItem[] {
    return this.guard.filter(history);
  }

  /**
   * The account that answers (or the one that just failed), and the record the message stores.
   *
   * In automatic mode both come from the router, so a reply that moved says who it ended on; in manual mode they
   * are the account the user named.
   */
  decision(model: string): RouteDecision {
    const current = this.auto?.current();
    const attempts = this.auto?.attempts() ?? [];
    const base = routeDecision(
      current === null || current === undefined ? this.route : { ...this.route, account: current.account, model: current.model },
      model,
    );
    if (attempts.length === 0) return base;
    // A failure with nowhere to move still belongs in the details panel. It is not a switch, so the reason
    // stays the one `resolveRoute` chose (`auto_primary`) rather than a code that says another account ran.
    if (!this.auto?.hasSwitched()) return { ...base, attempts };
    // Why automatic routing is on this account. A limit is worth its own code because it is the case the user
    // is most likely to want to understand afterwards ("it ran out and moved on"), while any other switch is a
    // generic failover. Both name the accounts that were passed over, in `attempts`.
    const limited = attempts.every((a) => a.failure === "rate_limit" || a.failure === "quota");
    return { ...base, reason: limited ? "auto_after_limit" : "auto_failover", attempts };
  }

  /**
   * Decides what a failed model call means, and moves the task when another account could do better.
   *
   * Returns true when the loop should call the model again on a different account. Anything else — a credential
   * problem, a policy refusal, a malformed request, output already streamed, or simply no account left — returns
   * false, and the caller rethrows the provider's own error so the user sees what actually happened.
   */
  advance(e: unknown): boolean {
    if (this.auto === null) return false;
    // A write already landed in the Room. Another account would see that call in the history and can emit
    // it again; upsert without an id creates a second entry. Read-only tools do not set this.
    if (this.o.sent.wrote === true) return false;
    const failure = classifyFailure(e, { startedOutput: this.o.sent.text === true });
    const decision = shouldSwitch(failure);
    if (!decision.switch) return false;
    const from = this.auto.current();
    if (from === null) return false;
    const now = this.o.now ?? Date.now;
    this.auto.recordFailure(failure, providerRetryAfterMs(e, now()), this.o.sent.model);
    const next = this.auto.next();
    if (next === null) return false;
    // The new account's own model and credential. `sent.model` is reset because the next request has not been
    // built yet: leaving the old value would name the failed account's model in the next failure line.
    this.session = this.build(next.account, next.model);
    this.o.sent.model = undefined;
    this.o.sent.text = false;
    return true;
  }

}

/**
 * The progress line for a switch, naming both accounts and what made the task move.
 *
 * It is a sentence rather than a code because it is shown while the task runs, where there is no metadata to
 * expand. The reason comes from the same classification that allowed the switch, so the two cannot disagree.
 */
function switchMessage(from: Account, to: Account, failure: RouteFailure): string {
  const why = failure === "rate_limit"
    ? "被限流"
    : failure === "quota"
      ? "额度用尽"
      : failure === "context"
        ? "上下文超出窗口"
        : "接口出错";
  return `${labelFor(from)} ${why}，改用 ${labelFor(to)}`;
}

/** An account in a sentence, with a name that looks like a credential replaced by its id. */
function labelFor(account: Account): string {
  return /^[A-Za-z0-9_\-+/=]{20,}$/.test(account.name.trim()) ? `账户 ${account.id}` : `账户「${account.name}」`;
}

export class CodexDirectAdapter implements AgentAdapter {
  readonly name = "codex-direct";
  /**
   * The cooldown table for this adapter. The daemon passes one shared by both adapters; a caller that does
   * not still gets a single table for the life of this object, so a failure is visible to the next task.
   */
  private readonly cooldowns: Cooldowns;

  constructor(private readonly opts: CodexDirectAdapterOptions) {
    this.cooldowns = opts.cooldowns ?? new Cooldowns({ now: opts.now });
  }

  async run(task: TaskAssign, onEvent: (e: TaskEvent) => void, ownerSignal?: AbortSignal): Promise<AgentResult> {
    if (ownerSignal?.aborted) return { ok: false, error: "Codex 直连运行已中止" };
    let config: NemaConfig;
    try {
      config = loadConfig(this.opts.nemaHome);
    } catch (e) {
      return { ok: false, error: configErrorMessage(e) };
    }
    // An attachment this adapter cannot hand over fails the task before any routing or request (D-2). It is
    // about the adapter, not the account: the account's own declaration is the candidate filter's business.
    const refused = task.attachments?.length ? refusal(attachmentCapabilities({ ...config, adapter: "codex-direct" }), task.attachments) : null;
    if (refused) return { ok: false, error: refused };

    const codexHome = this.opts.codexHome ?? defaultCodexHome();
    let picked: RoutingAccounts | null = null;
    let routeError: string | null = null;
    try {
      picked = this.accountSet(config);
    } catch (e) {
      // An unreadable account file is reported here rather than swallowed into "no account".
      routeError = e instanceof Error ? e.message : String(e);
    }
    if (!picked) return { ok: false, error: routeError ?? "无法读取账户设置" };
    const route = resolveRoute({
      task,
      config,
      adapter: "codex-direct",
      accounts: picked.accounts,
      bindings: picked.bindings,
      cooldowns: this.cooldowns,
      credentialOf: (a) => credentialStateOf(this.opts.nemaHome, a, codexHome),
      resolveModel: preferredModel,
      autoRouting: picked.autoRouting,
    });
    if (!route.ok) return routeFailure(route);

    // What each block of the first user message carries, so a provider error that points at one block names
    // that file. Created here rather than inside `execute` because the failover needs both facts while it is
    // still deciding: which model was actually sent, and whether the user has seen any text yet.
    const sent: SentState = {};

    // Built before the abort listener and the timer. `codexTransportFor` throws when the account is not a
    // codex-direct account; doing that after `setTimeout` would leave the timer running on a run that already
    // returned.
    let plan: AccountPlan;
    try {
      plan = new AccountPlan({
        route,
        nemaHome: this.opts.nemaHome,
        codexHome,
        sent,
        cooldowns: this.cooldowns,
        ...(this.opts.now ? { now: this.opts.now } : {}),
        ...(this.opts.refresher ? { refresher: this.opts.refresher } : {}),
        ...(this.opts.profile ? { profile: this.opts.profile } : {}),
        onEvent,
      });
    } catch (e) {
      return { ok: false, error: errorMessage(e), route: routeDecision(route, route.model) };
    }

    const ac = new AbortController();
    const abortFromOwner = () => ac.abort(ownerSignal?.reason ?? new Error("run stopped"));
    ownerSignal?.addEventListener("abort", abortFromOwner, { once: true });
    if (ownerSignal?.aborted) abortFromOwner();
    const timeout = new Promise<never>((_, reject) => {
      ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true });
    });
    timeout.catch(() => {});
    const timer = setTimeout(() => ac.abort(new RunTimeoutError()), task.limits?.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      await plan.session.source.getAccessToken();
    } catch (e) {
      // A credential that cannot produce a token fails the task here, before any model request. The message
      // is the token source's own (it names the specific problem: a dead login, a refused key); the account it
      // belongs to travels in `route`, so the reply line and the stored metadata still say whose credential.
      //
      // The model recorded is the one the account is configured with, not a stand-in: nothing was sent, and
      // a placeholder here would put a model name in the failure line that the user never chose and no
      // provider ever saw.
      clearTimeout(timer);
      ownerSignal?.removeEventListener("abort", abortFromOwner);
      return { ok: false, error: errorMessage(e), route: plan.decision(plan.session.model ?? route.model) };
    }
    if (ownerSignal?.aborted) {
      clearTimeout(timer);
      ownerSignal?.removeEventListener("abort", abortFromOwner);
      return { ok: false, error: "Codex 直连运行已中止" };
    }

    const execution = this.execute(task, onEvent, plan, ac.signal, sent);
    try {
      // The race makes the timeout win even while waiting on a hub call or a token refresh.
      return await Promise.race([execution, timeout]);
    } catch (e) {
      const cause = ac.signal.reason instanceof RunTimeoutError ? ac.signal.reason : e;
      // The route is recorded even though the task failed: "which account failed" is exactly what someone
      // reading this conversation later will ask, and the reply that would have carried it never came.
      return {
        ok: false,
        error: attachmentRejection(cause, task.attachments ?? [], sent.blocks) ?? errorMessage(cause),
        // `sent.model` is what reached the provider; nothing set it, so the run never got as far as a
        // request and the account's own setting is the honest answer.
        route: plan.decision(sent.model ?? plan.session.model ?? route.model),
      };
    } finally {
      clearTimeout(timer);
      if (!ac.signal.aborted) ac.abort(new Error("run finished"));
      ownerSignal?.removeEventListener("abort", abortFromOwner);
      // Owner-managed runs drain AuthStore refreshes with their independent deadline so a successful
      // token rotation is persisted before Runner releases the adapter slot. Preserve timeout return
      // behavior for legacy callers that do not supply an owner signal.
      if (ownerSignal) await execution.catch(() => {});
    }
  }

  private accountSet(config: NemaConfig): RoutingAccounts {
    if (this.opts.accounts) return this.opts.accounts();
    return loadRoutingAccounts(this.opts.nemaHome, config, this.opts.codexHome ?? defaultCodexHome());
  }

  private async execute(
    task: TaskAssign,
    rawOnEvent: (e: TaskEvent) => void,
    plan: AccountPlan,
    signal: AbortSignal,
    sent: SentState,
  ): Promise<AgentResult> {
    // After the run's signal fired (timeout or end) nothing more may reach the hub, even from late callbacks.
    const onEvent = (e: TaskEvent) => {
      if (!signal.aborted) rawOnEvent(e);
    };
    let config;
    try {
      config = loadConfig(this.opts.nemaHome);
    } catch (e) {
      throw new Error(configErrorMessage(e), { cause: e });
    }
    const loaded = await loadTaskAttachments(task, attachmentCapabilities({ ...config, adapter: "codex-direct" }), signal);
    if (!loaded.ok) throw new Error(loaded.error);
    // The transport context is per attempt, not per run: a failover swaps the credential and the endpoint
    // under it, so it is rebuilt from `plan.session` on every model call.
    const context = (): TransportContext => ({
      auth: plan.session.source, profile: plan.session.profile, version: this.opts.version, signal,
      ...(this.opts.maxRequestBytes !== undefined ? { maxRequestBytes: this.opts.maxRequestBytes } : {}),
    });
    const room = new RoomClient(task.hubUrl, task.runToken, signal);
    // Reports outlive the run's signal: a task that fails, times out or is stopped still leaves the thread
    // the Skills it read.
    const reportRoom = new RoomClient(task.hubUrl, task.runToken);
    const sessionId = randomUUID();
    const now = this.opts.now ?? Date.now;
    const skills = await prepareDirectSkills({
      nemaHome: this.opts.nemaHome,
      prompt: task.prompt,
      pluginToolNames: (task.pluginTools ?? []).map((tool) => tool.name),
      onEvent,
      ...(task.retainedSkills ? { retained: task.retainedSkills } : {}),
      ...(task.projectSkills ? { projectSkills: task.projectSkills } : {}),
      ...(task.manualSkill ? { manual: task.manualSkill } : {}),
      onActivated: async (id, revision) => {
        const reported = await reportRoom.reportSkillActivation(id, revision);
        if (!reported.ok) throw new Error(reported.error);
      },
    });
    const instructions = skills.instructions;
    const tools = [...roomTools(task.pluginTools), ...skills.tools];

    const first = attachmentParts(loaded.attachments);
    sent.blocks = first.blocks;
    let reply: string;
    try {
      ({ reply } = await runToolLoop({
        instructions,
        userText: DIRECT_USER_TEXT,
        userParts: first.parts,
        room,
        pluginTools: task.pluginTools,
        ...(skills.reader ? { skills: skills.reader } : {}),
        signal,
        ...(task.limits ? { limits: { ...DEFAULT_LIMITS, maxModelCalls: task.limits.maxModelCalls, maxToolCalls: task.limits.maxToolCalls } } : {}),
        onProgress: (text) => onEvent({ type: "tool_call", text }),
        onWrite: () => { sent.wrote = true; },
        // Only after a switch, and only for the reasoning items: the rest of the conversation is unchanged.
        // The loop-level filter: covers the normal case, where the account changed between two loop iterations.
        onBeforeCall: (history) => plan.history(history),
        call: async (input) => {
          // Throttled progress: the accumulated text of this model call, at most every PROGRESS_INTERVAL_MS.
          let text = "";
          let shown = "";
          let lastAt = -Infinity;
          const flush = () => {
            if (text === shown) return;
            shown = text;
            lastAt = now();
            onEvent({ type: "agent_message", text: text.slice(-PROGRESS_MAX_CHARS) });
          };
          for (;;) {
            // The model is resolved per attempt: a new account may name a different one, and an account with
            // no default is resolved from its own catalog the first time it is used.
            const model = plan.session.model ?? (await this.defaultModel(context()));
            plan.session.model = model;
            sent.model = model;
            // Filtered again per attempt, because a switch happens *inside* this call: the loop's own
            // `onBeforeCall` ran once, before the account changed. Filtering is idempotent — each reasoning item
            // is tagged on first sighting and the tag decides its fate — so the two sites cannot disagree.
            const outgoing = plan.history(input);
            // The call's text is reported even when it fails: the user has seen those characters.
            try {
              const response = await streamResponse(
                { model, instructions, input: outgoing, tools, reasoning: { effort: config.reasoningEffort, summary: "auto" }, sessionId },
                {
                  ...context(),
                  onTextDelta: (d) => {
                    text += d;
                    // Once a delta has reached the hub the answer has started, and no later failure may move
                    // the task to another account (spec §4.3).
                    sent.text = true;
                    if (now() - lastAt >= PROGRESS_INTERVAL_MS) flush();
                  },
                },
              );
              return response;
            } catch (e) {
              if (signal.aborted) throw e;
              // A failure the design says another account could answer. When `advance` returns false there is
              // nothing to move to, and the provider's own error is rethrown below so the user sees it.
              if (!plan.advance(e)) throw e;
              // The next attempt starts with a clean progress line: the text accumulated above belonged to the
              // account that failed, and the new account's answer must not be appended to it.
              text = "";
              shown = "";
              lastAt = -Infinity;
            } finally {
              // Whatever arrived before the failure (or the answer that succeeded) is shown once the attempt
              // settles; only the *switched-away* text is cleared, above.
              if (!signal.aborted) flush();
            }
          }
        },
      }));
    } finally {
      // A failed, timed-out or stopped task reports what it read before its run is aborted; a lost
      // report is a warning, never the task's outcome.
      if (skills.reader) {
        const reports = await skills.reader.settleReports(5000);
        if (reports.timedOut) onEvent({ type: "progress", text: "Skill 激活记录未能及时上报" });
        else if (reports.failed > 0) onEvent({ type: "progress", text: `${reports.failed} 条 Skill 激活记录上报失败` });
      }
    }
    // The record names the account that produced this reply, which after a failover is not the routed one.
    return { ok: true, reply, route: plan.decision(plan.session.model ?? sent.model ?? "") };
  }

  /** First listed model; the fallback only when the list is unavailable (API error) or empty. */
  private async defaultModel(ctx: TransportContext): Promise<string> {
    try {
      return (await listModels(ctx))[0] ?? FALLBACK_MODEL;
    } catch (e) {
      if (e instanceof ModelApiError) return FALLBACK_MODEL;
      throw e;
    }
  }
}
