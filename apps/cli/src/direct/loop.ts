import { createHash } from "node:crypto";
import type { PluginToolSpec } from "@nema/shared";
import type { RoomClient } from "../room/client.js";
import { dispatchTool, type RoomApi } from "./tools.js";
import { READ_SKILL, type SkillReader } from "../skills/readSkill.js";
import type { CollectedResponse, InputContentPart, InputItem, OutputItem, OutputTextPart, SummaryTextPart } from "./transport.js";
import { isFunctionCall, isMessage } from "./transport.js";

// The codex-direct tool loop (spec 6.7 item 4). Stateless: every model call re-sends the whole history
// (store:false), with function calls and their outputs paired by call_id.

export type LoopLimits = { maxModelCalls: number; maxToolCalls: number; maxUnknownTools: number; maxContinuations: number };
export const DEFAULT_LIMITS: LoopLimits = { maxModelCalls: 24, maxToolCalls: 60, maxUnknownTools: 5, maxContinuations: 3 };

export const CONTINUE_TEXT = "请继续。";
const MAX_CALL_ID = 64;

export type ToolLoopOptions = {
  /** Sent as the request `instructions` by `call`; kept here so callers pass the hub prompt in one place. */
  instructions: string;
  userText: string;
  /** Extra parts after `userText` in the first user message (attachments); re-sent with the history on every call. */
  userParts?: InputContentPart[];
  call: (input: InputItem[]) => Promise<CollectedResponse>;
  room: RoomClient | RoomApi;
  /** Plugin functions from `task.assign`. Routed through `dispatchTool`, so they count toward the tool limit. */
  pluginTools?: PluginToolSpec[];
  /** Reads Skills for `read_skill`; only set when the task has Skills. */
  skills?: SkillReader;
  /** Short progress notes (e.g. which Room function is being called). */
  onProgress: (text: string) => void;
  limits?: LoopLimits;
  /** Once aborted (timeout / run end) the loop stops and emits no further progress. */
  signal?: AbortSignal;
};

const userMessage = (text: string, parts: InputContentPart[] = []): InputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }, ...parts] });

const sha32 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** call_ids sent to the API must be ≤ 64 chars and unique within a request (= within the whole history). */
class CallIds {
  private readonly used = new Set<string>();

  assign(raw: unknown): string {
    let base = typeof raw === "string" && raw !== "" ? raw : "call_missing";
    if (base.length > MAX_CALL_ID) base = `call_${sha32(base)}`;
    let id = base;
    for (let n = 1; this.used.has(id); n++) {
      const suffix = `_dup${n}`;
      id = base.length + suffix.length > MAX_CALL_ID ? `call_${sha32(base)}${suffix}` : base + suffix;
    }
    this.used.add(id);
    return id;
  }
}

const textParts = (m: { content?: unknown }): OutputTextPart[] =>
  (Array.isArray(m.content) ? m.content : [])
    .filter((p): p is { type: "output_text"; text: string } => !!p && p.type === "output_text" && typeof p.text === "string")
    .map((p) => ({ type: "output_text", text: p.text }));

/**
 * Runs the model until it answers without function calls. Returns the final assistant text (all text of the
 * final answer, joined across continuations). Throws an Error with a user-facing Chinese message on any limit.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<{ reply: string }> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const history: InputItem[] = [userMessage(opts.userText, opts.userParts)];
  const ids = new CallIds();
  let modelCalls = 0;
  let toolCalls = 0;
  let unknownTools = 0;
  let continuations = 0;
  // Assistant text since the last round of function calls: the reply, possibly split over continuations.
  let answer = "";
  const signal = opts.signal;
  const progress = (text: string) => {
    if (!signal?.aborted) opts.onProgress(text);
  };

  for (;;) {
    signal?.throwIfAborted();
    if (modelCalls >= limits.maxModelCalls) throw new Error(`Agent 超出单次运行上限（模型调用 ${limits.maxModelCalls} 次）`);
    modelCalls++;
    const res = await opts.call([...history]);
    signal?.throwIfAborted();

    const calls: { call_id: string; name: string; arguments: string }[] = [];
    let text = "";
    for (const item of res.items as OutputItem[]) {
      if (item.type === "reasoning") {
        // Replayed without its id (store:false has nothing to look up); only the encrypted form carries the
        // reasoning across stateless calls, so an item without it is dropped.
        const enc = (item as { encrypted_content?: unknown }).encrypted_content;
        if (typeof enc !== "string" || enc === "") continue;
        const summary = (item as { summary?: unknown }).summary;
        const parts = (Array.isArray(summary) ? summary : [])
          .filter((p): p is SummaryTextPart => !!p && p.type === "summary_text" && typeof p.text === "string")
          .map((p) => ({ type: "summary_text" as const, text: p.text }));
        history.push({ type: "reasoning", summary: parts, encrypted_content: enc });
      } else if (isMessage(item)) {
        const parts = textParts(item);
        if (parts.length === 0) continue;
        history.push({ type: "message", role: "assistant", content: parts });
        text += parts.map((p) => p.text).join("");
      } else if (isFunctionCall(item)) {
        const call = {
          call_id: ids.assign(item.call_id),
          name: typeof item.name === "string" ? item.name : "",
          arguments: typeof item.arguments === "string" ? item.arguments : "",
        };
        history.push({ type: "function_call", ...call });
        calls.push(call);
      }
      // Any other output item type is ignored: no other tool exists.
    }

    if (calls.length > 0) {
      answer = "";
      for (const c of calls) {
        if (toolCalls >= limits.maxToolCalls) throw new Error(`Agent 超出单次运行上限（工具调用 ${limits.maxToolCalls} 次）`);
        toolCalls++;
        const r = await dispatchTool(c.name, c.arguments, opts.room, opts.pluginTools ?? [], opts.skills);
        signal?.throwIfAborted();
        if (!r.known) {
          unknownTools++;
          if (unknownTools > limits.maxUnknownTools) throw new Error("Agent 多次请求未提供的工具，已中止");
        } else {
          // A Skill read reports itself, with the Skill and its version.
          if (!(opts.skills && c.name === READ_SKILL)) progress(`调用 ${c.name}`);
        }
        history.push({ type: "function_call_output", call_id: c.call_id, output: r.output });
      }
      continue;
    }

    answer += text;
    if (res.status === "completed") {
      const reply = answer.trim();
      if (reply === "") throw new Error("Agent 没有返回回复");
      return { reply };
    }
    if (continuations >= limits.maxContinuations) {
      throw new Error(`Agent 输出不完整，续写 ${limits.maxContinuations} 次后仍未完成（${res.incompleteReason ?? "incomplete"}）`);
    }
    continuations++;
    history.push(userMessage(CONTINUE_TEXT));
  }
}
