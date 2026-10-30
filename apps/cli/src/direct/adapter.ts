import { randomUUID } from "node:crypto";
import type { TaskAssign, TaskEvent } from "@nema/shared";
import { attachmentCapabilities, refusal } from "../attachments/capabilities.js";
import { attachmentLabel, attachmentPreamble, textAttachmentBlock } from "../attachments/blocks.js";
import { loadTaskAttachments, type LoadedAttachment } from "../attachments/fetch.js";
import { configErrorMessage, DEFAULT_BYOK_BASE_URL, loadConfig, type NemaConfig } from "../config.js";
import type { AgentAdapter, AgentResult } from "../daemon/runner.js";
import { RoomClient } from "../room/client.js";
import { attachmentRejection, type ContentBlockOwner } from "./attachmentErrors.js";
import { AuthStore, ReloginRequiredError, UNUSABLE_FILE_MESSAGE, type Refresher } from "./authStore.js";
import { ByokTokenSource } from "./byok.js";
import { CodexFileTokenSource, defaultCodexHome } from "./codexLogin.js";
import { DEFAULT_LIMITS, runToolLoop } from "./loop.js";
import { siwcRefresher } from "./siwc.js";
import { roomTools } from "./tools.js";
import { prepareDirectSkills } from "../skills/direct.js";
import {
  BYOK_PROFILE,
  ByokRejectedError,
  COMPAT_PROFILE,
  listModels,
  ModelApiError,
  ModelQuotaError,
  SIWC_PROFILE,
  streamResponse,
  type InputContentPart,
  type TokenSource,
  type TransportContext,
  type TransportProfile,
} from "./transport.js";

// codex-direct (spec 6.7): runs Nema's own tool loop in the daemon against the Responses API with the user's
// Nema login. The model gets the 4 Room functions plus the task's plugin tools. Failures are reported, never retried via codex-cli.

export const NOT_LOGGED_IN = "未登录直连 Codex，请在终端运行 nema auth login";
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
};

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

export class CodexDirectAdapter implements AgentAdapter {
  readonly name = "codex-direct";

  constructor(private readonly opts: CodexDirectAdapterOptions) {}

  async run(task: TaskAssign, onEvent: (e: TaskEvent) => void, ownerSignal?: AbortSignal): Promise<AgentResult> {
    if (ownerSignal?.aborted) return { ok: false, error: "Codex 直连运行已中止" };
    let config: NemaConfig;
    try {
      config = loadConfig(this.opts.nemaHome);
    } catch (e) {
      return { ok: false, error: configErrorMessage(e) };
    }
    // An attachment this adapter cannot hand over fails the task before any login check or request (D-2).
    const refused = task.attachments?.length ? refusal(attachmentCapabilities({ ...config, adapter: "codex-direct" }), task.attachments) : null;
    if (refused) return { ok: false, error: refused };
    let source: TokenSource;
    let profile: TransportProfile;
    let configuredModel: string | undefined;
    if (config.authMode === "compat") {
      source = new CodexFileTokenSource(this.opts.codexHome ?? defaultCodexHome(), this.opts.now);
      profile = this.opts.profile ?? COMPAT_PROFILE;
      try {
        await source.getAccessToken();
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
      if (ownerSignal?.aborted) return { ok: false, error: "Codex 直连运行已中止" };
    } else if (config.authMode === "byok") {
      if (!config.model) return { ok: false, error: "BYOK 需要指定模型，请运行 nema config set model <名称>" };
      source = new ByokTokenSource(this.opts.nemaHome);
      profile = { ...BYOK_PROFILE, baseUrl: config.byokBaseUrl ?? DEFAULT_BYOK_BASE_URL };
      configuredModel = config.model;
      try {
        await source.getAccessToken();
      } catch (e) {
        return { ok: false, error: errorMessage(e) };
      }
      if (ownerSignal?.aborted) return { ok: false, error: "Codex 直连运行已中止" };
    } else {
      const store = new AuthStore(this.opts.nemaHome, this.opts.refresher ?? siwcRefresher);
      const { auth, reason } = store.inspect();
      if (!auth) return { ok: false, error: reason === "unusable" ? UNUSABLE_FILE_MESSAGE : NOT_LOGGED_IN };
      source = store;
      profile = this.opts.profile ?? SIWC_PROFILE;
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
    // What each block of the first user message carries, so a provider error that points at one block names that file.
    const sent: { blocks?: ContentBlockOwner[] } = {};
    const execution = this.execute(task, onEvent, source, profile, ac.signal, sent, configuredModel);
    try {
      // The race makes the timeout win even while waiting on a hub call or a token refresh.
      return await Promise.race([execution, timeout]);
    } catch (e) {
      const cause = ac.signal.reason instanceof RunTimeoutError ? ac.signal.reason : e;
      return { ok: false, error: attachmentRejection(cause, task.attachments ?? [], sent.blocks) ?? errorMessage(cause) };
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

  private async execute(task: TaskAssign, rawOnEvent: (e: TaskEvent) => void, source: TokenSource, profile: TransportProfile, signal: AbortSignal, sent: { blocks?: ContentBlockOwner[] }, configuredModel?: string): Promise<AgentResult> {
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
    const ctx: TransportContext = {
      auth: source, profile, version: this.opts.version, signal,
      ...(this.opts.maxRequestBytes !== undefined ? { maxRequestBytes: this.opts.maxRequestBytes } : {}),
    };
    const model = configuredModel ?? config.model ?? (await this.defaultModel(ctx));
    const room = new RoomClient(task.hubUrl, task.runToken, signal);
    const sessionId = randomUUID();
    const now = this.opts.now ?? Date.now;
    const skills = await prepareDirectSkills({
      nemaHome: this.opts.nemaHome,
      prompt: task.prompt,
      pluginToolNames: (task.pluginTools ?? []).map((tool) => tool.name),
      onEvent,
      ...(task.retainedSkills ? { retained: task.retainedSkills } : {}),
      ...(task.projectSkills ? { projectSkills: task.projectSkills } : {}),
      onActivated: async (id, revision) => {
        const reported = await room.reportSkillActivation(id, revision);
        if (!reported.ok) throw new Error(reported.error);
      },
    });
    const instructions = skills.instructions;
    const tools = [...roomTools(task.pluginTools), ...skills.tools];

    const first = attachmentParts(loaded.attachments);
    sent.blocks = first.blocks;
    const { reply } = await runToolLoop({
      instructions,
      userText: DIRECT_USER_TEXT,
      userParts: first.parts,
      room,
      pluginTools: task.pluginTools,
      ...(skills.reader ? { skills: skills.reader } : {}),
      signal,
      ...(task.limits ? { limits: { ...DEFAULT_LIMITS, maxModelCalls: task.limits.maxModelCalls, maxToolCalls: task.limits.maxToolCalls } } : {}),
      onProgress: (text) => onEvent({ type: "tool_call", text }),
      call: async (input) => {
        // Throttled progress: the accumulated text of this model call, at most every PROGRESS_INTERVAL_MS.
        let text = "";
        let sent = "";
        let lastAt = -Infinity;
        const flush = () => {
          if (text === sent) return;
          sent = text;
          lastAt = now();
          onEvent({ type: "agent_message", text: text.slice(-PROGRESS_MAX_CHARS) });
        };
        try {
          return await streamResponse(
            { model, instructions, input, tools, reasoning: { effort: config.reasoningEffort, summary: "auto" }, sessionId },
            {
              ...ctx,
              onTextDelta: (d) => {
                text += d;
                if (now() - lastAt >= PROGRESS_INTERVAL_MS) flush();
              },
            },
          );
        } finally {
          if (!signal.aborted) flush();
        }
      },
    });
    // Activation reports go to the hub; give them a moment, but a lost one must not fail the task.
    if (skills.reader) {
      const reports = await skills.reader.settleReports(5000);
      if (reports.timedOut) onEvent({ type: "progress", text: "Skill 激活记录未能及时上报" });
      else if (reports.failed > 0) onEvent({ type: "progress", text: `${reports.failed} 条 Skill 激活记录上报失败` });
    }
    return { ok: true, reply };
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
