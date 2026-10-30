import { DEFAULT_BYOK_BASE_URL } from "../config.js";
import type { StoredAuth } from "./authStore.js";
import { ReloginRequiredError } from "./authStore.js";
import { codexAccountHeaders } from "./codexLogin.js";
import { SIWC } from "./siwc.js";

/*
 * Streaming Responses transport for the direct Codex adapter: one `POST {baseUrl}/responses` per model call,
 * SSE parsing into output items, error mapping, and the model list.
 *
 * Sources (see siwc.ts for the full doc list; fetched 2026-10-22/23):
 *   [MODELS] https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 *     GET /models → `models[]` with slug/display_name/visibility; keep `visibility == "list"` in server order.
 *     POST /responses with `store:false`, `stream:true`; only `response.completed` is success;
 *     `response.failed` carries `response.error.code` (else "unknown_error"); `response.incomplete`, error
 *     events and interrupted streams are handled separately; ending without completed = failure.
 *   [ERRORS] https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 *     subscription_sharing_usage_limit_exceeded 429, subscription_sharing_usage_unavailable 503 (both may arrive
 *     as response.failed after streaming began), subscription_sharing_unsupported_capability 400 (+ error.param;
 *     never resend the same body), admission failures with `{"detail": "..."}` bodies. The docs say not to
 *     infer a reset time, so resetsAt is only set when the server sends one (`resets_at` / `resets_in_seconds`,
 *     the codex backend's usage_limit_reached shape).
 *   docs/reviews/2026-10-23-codex-direct-research.md §3 — SSE event model and assembly rules: build output from
 *     `response.output_item.done` (completed.response.output may be empty), settle function calls that were
 *     added but never done, order by output_index only when every item has one, reasoning-only completed is
 *     incomplete, `tools` omitted when empty, never send max_output_tokens / prompt_cache_retention.
 * Identity (project rule): `originator: nema-room`, `User-Agent: NemaRoom/<version>`; never codex_cli_rs.
 */

// ---- request / response types ----------------------------------------------------------------------------

export type InputTextPart = { type: "input_text"; text: string };
/** User-message parts for attachments: an image as a data URL, a PDF as inline file data. */
export type InputImagePart = { type: "input_image"; image_url: string };
export type InputFilePart = { type: "input_file"; filename: string; file_data: string };
export type InputContentPart = InputTextPart | InputImagePart | InputFilePart;
export type OutputTextPart = { type: "output_text"; text: string; annotations?: unknown[] };
export type SummaryTextPart = { type: "summary_text"; text: string };

/** Typed content parts only: the backend rejects string `content`. */
export type InputItem =
  | { type: "message"; role: "user"; content: InputContentPart[] }
  | { type: "message"; role: "developer" | "system"; content: InputTextPart[] }
  | { type: "message"; role: "assistant"; content: OutputTextPart[]; id?: string; status?: "completed" }
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; summary: SummaryTextPart[]; encrypted_content?: string | null; id?: string };

export type FunctionTool = { type: "function"; name: string; description: string; strict: boolean; parameters: Record<string, unknown> };

export type OutputMessage = { type: "message"; role: "assistant"; content: Array<OutputTextPart | { type: string; [k: string]: unknown }>; id?: string; status?: string };
export type OutputFunctionCall = { type: "function_call"; call_id: string; name: string; arguments: string; id?: string; status?: string };
export type OutputReasoning = { type: "reasoning"; summary?: SummaryTextPart[]; encrypted_content?: string | null; id?: string };
/** Items are passed through as the server sent them; other item types keep their raw shape. */
export type OutputItem = OutputMessage | OutputFunctionCall | OutputReasoning | { type: string; [k: string]: unknown };

export const isFunctionCall = (i: OutputItem): i is OutputFunctionCall => i.type === "function_call";
export const isMessage = (i: OutputItem): i is OutputMessage => i.type === "message";
/** Concatenated `output_text` of all message items. */
export const outputText = (items: OutputItem[]): string =>
  items
    .filter(isMessage)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .map((p) => (p.type === "output_text" && typeof p.text === "string" ? p.text : ""))
    .join("");

export type ResponsesRequest = {
  model: string;
  instructions: string;
  input: InputItem[];
  tools: FunctionTool[];
  reasoning: { effort: string; summary: "auto" };
  sessionId: string;
};

export type CollectedResponse = { status: "completed" | "incomplete"; items: OutputItem[]; incompleteReason?: string };

/** Anything that can hand the transport a bearer token. AuthStore and CodexFileTokenSource both qualify. */
export type TokenSource = {
  getAccessToken(opts?: { force?: boolean; rejectedAccessToken?: string; signal?: AbortSignal }): Promise<{ accessToken: string; auth: StoredAuth }>;
  recordAuthError(reason: { code: string; message: string }, forAuth: StoredAuth): Promise<void>;
};

export type TransportProfile = {
  baseUrl: string;
  extraHeaders(auth: StoredAuth): Record<string, string>;
  modelsPath: string;
  /** Whether a 401 should force one token refresh. Defaults to true. */
  refreshOn401?: boolean;
  /** Tried once when modelsPath answers HTTP 400 (Codex catalog: client_version 99.0.0 then 0.0.0). */
  modelsPathFallback?: string;
  parseModels(json: unknown): string[];
};

/** [MODELS]: public API base, `GET /models`, keep `visibility === "list"` slugs in server order. */
export const SIWC_PROFILE: TransportProfile = {
  baseUrl: SIWC.apiBase,
  extraHeaders: () => ({}),
  modelsPath: "/models",
  parseModels(json: unknown): string[] {
    const models = json && typeof json === "object" ? (json as { models?: unknown }).models : undefined;
    if (!Array.isArray(models)) throw new ModelApiError({ message: "模型列表响应缺少 models 数组" });
    return models
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && (m as Record<string, unknown>).visibility === "list")
      .map((m) => m.slug)
      .filter((s): s is string => typeof s === "string" && s !== "");
  },
};

/**
 * BYOK talks to the public OpenAI API or any OpenAI-compatible server (OpenRouter, vLLM, Ollama …). Their
 * `GET /models` answers `{ object: "list", data: [{ id }] }` with no visibility field, so every non-empty `id`
 * is kept in server order. A SIWC-style `models[]` catalog behind a custom base URL is still read as before.
 */
export const BYOK_PROFILE: TransportProfile = {
  baseUrl: DEFAULT_BYOK_BASE_URL,
  extraHeaders: () => ({}),
  modelsPath: "/models",
  refreshOn401: false,
  parseModels(json: unknown): string[] {
    const record = json && typeof json === "object" ? (json as { data?: unknown; models?: unknown }) : undefined;
    if (record && !Array.isArray(record.data) && Array.isArray(record.models)) return SIWC_PROFILE.parseModels(json);
    if (!record || !Array.isArray(record.data)) throw new ModelApiError({ message: "模型列表响应缺少 data 数组" });
    return record.data
      .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).id : undefined))
      .filter((id): id is string => typeof id === "string" && id !== "");
  },
};

/**
 * Hermes Codex route: `POST https://chatgpt.com/backend-api/codex/responses` with the Codex CLI's
 * access token. Hidden catalog rows are dropped; the rest sort by (priority, slug). Identity stays
 * `nema-room` — this does not impersonate the Codex CLI.
 */
export const COMPAT_PROFILE: TransportProfile = {
  baseUrl: "https://chatgpt.com/backend-api/codex",
  extraHeaders: (auth) => codexAccountHeaders(auth.tokens.access_token),
  modelsPath: "/models?client_version=99.0.0",
  modelsPathFallback: "/models?client_version=0.0.0",
  parseModels(json: unknown): string[] {
    const models = json && typeof json === "object" ? (json as { models?: unknown }).models : undefined;
    if (!Array.isArray(models)) throw new ModelApiError({ message: "模型列表响应缺少 models 数组" });
    const rows: { rank: number; slug: string }[] = [];
    for (const item of models) {
      if (!item || typeof item !== "object") continue;
      const m = item as Record<string, unknown>;
      if (typeof m.slug !== "string" || m.slug.trim() === "") continue;
      const visibility = typeof m.visibility === "string" ? m.visibility.trim().toLowerCase() : "";
      if (visibility === "hide" || visibility === "hidden") continue;
      const rank = typeof m.priority === "number" && Number.isFinite(m.priority) ? Math.trunc(m.priority) : 10_000;
      rows.push({ rank, slug: m.slug.trim() });
    }
    rows.sort((a, b) => a.rank - b.rank || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    const seen = new Set<string>();
    const slugs: string[] = [];
    for (const row of rows) {
      if (seen.has(row.slug)) continue;
      seen.add(row.slug);
      slugs.push(row.slug);
    }
    return slugs;
  },
};

export type TransportContext = {
  auth: TokenSource;
  profile: TransportProfile;
  /** Nema CLI version for `User-Agent: NemaRoom/<version>`. */
  version: string;
  signal: AbortSignal;
  /** Delay before the single network/5xx retry (default 1000 ms). */
  retryDelayMs?: number;
  /** Largest serialized request body sent (default MAX_DIRECT_REQUEST_BYTES); tests lower it. */
  maxRequestBytes?: number;
};

/**
 * The largest request body codex-direct sends, under the Responses API's 50 MB per request. The tool loop
 * re-sends the whole history (attachments included) on every call, so this is checked before each one.
 */
export const MAX_DIRECT_REQUEST_BYTES = 48 * 1024 * 1024;
export const REQUEST_TOO_LARGE_MESSAGE = "这次任务的附件和对话合计超过模型一次请求的上限，请减少附件或不引用那条消息";

// ---- errors ------------------------------------------------------------------------------------------------

/** Codes meaning the plan's usage is exhausted or unavailable (HTTP body or inside response.failed / error). */
export const QUOTA_CODES = [
  "usage_limit_reached",
  "usage_limit_exceeded",
  "subscription_sharing_usage_limit_exceeded",
  "usage_not_included",
  "insufficient_quota",
  "subscription_sharing_usage_unavailable",
] as const;

export class ModelQuotaError extends Error {
  readonly status?: number;
  readonly code?: string;
  /** When usage resets, epoch milliseconds — only if the server said so. */
  readonly resetsAt?: number;
  constructor(o: { status?: number; code?: string; message?: string; resetsAt?: number }) {
    super(`订阅额度不可用（${describe(o.status, o.code)}）${o.message ? `：${o.message}` : ""}`);
    this.name = "ModelQuotaError";
    this.status = o.status;
    this.code = o.code;
    this.resetsAt = o.resetsAt;
  }
}

export class ModelApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  constructor(o: { status?: number; code?: string; message: string }, options?: ErrorOptions) {
    super(o.message, options);
    this.name = "ModelApiError";
    this.status = o.status;
    this.code = o.code;
  }
}

export class ByokRejectedError extends Error {
  constructor() {
    super("API key 被拒绝，请在终端运行 nema auth byok");
    this.name = "ByokRejectedError";
  }
}

function describe(status?: number, code?: string): string {
  return [status !== undefined ? `HTTP ${status}` : "", code ?? ""].filter(Boolean).join(" ") || "未知错误";
}

type ParsedError = { status?: number; code?: string; message?: string; param?: string; resetsAt?: number; requestId?: string };

function parseErrorObject(o: unknown, now: number): Omit<ParsedError, "status" | "requestId"> {
  if (!o || typeof o !== "object") return {};
  const body = o as Record<string, unknown>;
  const nested = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : undefined;
  const src = nested ?? body;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const code = str(src.code) ?? str(src.type) ?? (typeof body.error === "string" ? body.error : undefined);
  const message = str(src.message) ?? str(body.detail) ?? str(body.message);
  let resetsAt: number | undefined;
  const ra = src.resets_at ?? body.resets_at;
  const rin = src.resets_in_seconds ?? body.resets_in_seconds;
  if (typeof ra === "number" && Number.isFinite(ra) && ra > 0) resetsAt = ra > 1e12 ? ra : ra * 1000;
  else if (typeof rin === "number" && Number.isFinite(rin) && rin >= 0) resetsAt = now + rin * 1000;
  return { code, message, param: str(src.param), resetsAt };
}

function toError(p: ParsedError): ModelQuotaError | ModelApiError {
  if (p.code && (QUOTA_CODES as readonly string[]).includes(p.code)) {
    return new ModelQuotaError({ status: p.status, code: p.code, message: p.message, resetsAt: p.resetsAt });
  }
  const detail = [p.message, p.param ? `param=${p.param}` : "", p.requestId ? `request id ${p.requestId}` : ""].filter(Boolean).join("；");
  return new ModelApiError({ status: p.status, code: p.code, message: `${describe(p.status, p.code)}${detail ? `：${detail}` : ""}` });
}

async function httpError(res: Response): Promise<ParsedError> {
  let parsed: Omit<ParsedError, "status" | "requestId"> = {};
  const text = await res.text().catch(() => "");
  try {
    parsed = parseErrorObject(JSON.parse(text), Date.now());
  } catch {
    if (text.trim()) parsed = { message: text.trim().slice(0, 300) };
  }
  return { ...parsed, status: res.status, requestId: res.headers.get("x-request-id") ?? undefined };
}

// ---- HTTP with retries -------------------------------------------------------------------------------------

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// fetch's own text can quote a request header (and so the bearer token). Only a bare errno code is kept.
function connectionMessage(e: unknown): string {
  const code = (e as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? `无法连接模型接口（${code}）` : "无法连接模型接口";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Sends one request with the retry policy: a connection error or 5xx is retried once (except quota codes, and
 * never when `noTransientRetry` is set: the provider may already have processed and billed what was sent);
 * a 401 forces one token refresh (passing the rejected token so a peer's rotation is reused) and is retried
 * once; a second 401 → ReloginRequiredError. Returns only an OK response.
 */
async function send(ctx: TransportContext, url: string, init: (headers: Record<string, string>) => RequestInit, noTransientRetry = false): Promise<Response> {
  let { accessToken, auth } = await ctx.auth.getAccessToken({ signal: ctx.signal });
  let authRetried = false;
  let transientRetried = noTransientRetry;
  for (;;) {
    ctx.signal.throwIfAborted();
    const headers = {
      ...ctx.profile.extraHeaders(auth),
      Authorization: `Bearer ${accessToken}`,
      originator: SIWC.originator,
      "User-Agent": `NemaRoom/${ctx.version}`,
    };
    let res: Response;
    try {
      res = await fetch(url, { ...init(headers), signal: ctx.signal });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      if (!transientRetried) {
        transientRetried = true;
        await sleep(ctx.retryDelayMs ?? 1000, ctx.signal);
        continue;
      }
      throw new ModelApiError({ message: connectionMessage(e) }, { cause: e });
    }
    if (res.ok) return res;
    ctx.signal.throwIfAborted();
    if (res.status === 401) {
      if (ctx.profile.refreshOn401 === false) throw new ByokRejectedError();
      const err = await httpError(res);
      if (authRetried) {
        // The forced refresh produced a token the API still rejects: surface it consistently in status/doctor.
        await ctx.auth.recordAuthError({ code: "model_unauthorized", message: `模型接口仍返回 401（${err.code ?? "unauthorized"}）` }, auth);
        throw new ReloginRequiredError(err.code ?? "unauthorized");
      }
      authRetried = true;
      ({ accessToken, auth } = await ctx.auth.getAccessToken({ force: true, rejectedAccessToken: accessToken, signal: ctx.signal }));
      continue;
    }
    const err = toError(await httpError(res));
    if (err instanceof ModelQuotaError) throw err;
    if (res.status >= 500 && !transientRetried) {
      transientRetried = true;
      await sleep(ctx.retryDelayMs ?? 1000, ctx.signal);
      continue;
    }
    throw err;
  }
}

async function listModelsAt(ctx: TransportContext, modelsPath: string): Promise<string[]> {
  const res = await send(ctx, `${ctx.profile.baseUrl}${modelsPath}`, (h) => ({ method: "GET", headers: { ...h, Accept: "application/json" } }));
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new ModelApiError({ status: res.status, message: `模型列表响应不是 JSON：${errMessage(e)}` }, { cause: e });
  }
  return ctx.profile.parseModels(body);
}

/** The account's listed models. A 400 on modelsPath retries modelsPathFallback once (Codex catalog versions). */
export async function listModels(ctx: TransportContext): Promise<string[]> {
  try {
    return await listModelsAt(ctx, ctx.profile.modelsPath);
  } catch (e) {
    if (ctx.profile.modelsPathFallback && e instanceof ModelApiError && e.status === 400) {
      return await listModelsAt(ctx, ctx.profile.modelsPathFallback);
    }
    throw e;
  }
}

// ---- streaming ---------------------------------------------------------------------------------------------

function requestBody(req: ResponsesRequest): Record<string, unknown> {
  return {
    model: req.model,
    instructions: req.instructions,
    input: req.input,
    store: false,
    stream: true,
    // Omitted when empty (research §3: the backend wants no empty tools array).
    ...(req.tools.length > 0 ? { tools: req.tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
    reasoning: req.reasoning,
    include: ["reasoning.encrypted_content"],
  };
}

type Entry = { item: OutputItem; outputIndex?: number; seq: number };
type Pending = { item: OutputFunctionCall; outputIndex?: number; seq: number; args: string; done: boolean };

class Assembler {
  private seq = 0;
  private readonly done: Entry[] = [];
  private readonly pending: Pending[] = [];

  constructor(private readonly onTextDelta?: (t: string) => void) {}

  private findPending(ev: Record<string, unknown>): Pending | undefined {
    const id = typeof ev.item_id === "string" ? ev.item_id : undefined;
    const idx = typeof ev.output_index === "number" ? ev.output_index : undefined;
    return this.pending.find((p) => !p.done && ((id !== undefined && p.item.id === id) || (id === undefined && idx !== undefined && p.outputIndex === idx)));
  }

  /** Returns the final result on a terminal event; throws on failure events. */
  handle(ev: Record<string, unknown>): CollectedResponse | null {
    const idx = typeof ev.output_index === "number" ? ev.output_index : undefined;
    switch (ev.type) {
      case "response.output_text.delta":
        if (typeof ev.delta === "string" && ev.delta !== "") this.onTextDelta?.(ev.delta);
        return null;
      case "response.output_item.added": {
        const item = ev.item as Record<string, unknown> | undefined;
        if (item && item.type === "function_call") {
          this.pending.push({ item: item as OutputFunctionCall, outputIndex: idx, seq: this.seq++, args: typeof item.arguments === "string" ? item.arguments : "", done: false });
        }
        return null;
      }
      case "response.function_call_arguments.delta": {
        const p = this.findPending(ev);
        if (p && typeof ev.delta === "string") p.args += ev.delta;
        return null;
      }
      case "response.function_call_arguments.done": {
        const p = this.findPending(ev);
        if (p && typeof ev.arguments === "string") p.args = ev.arguments;
        return null;
      }
      case "response.output_item.done": {
        const item = ev.item as OutputItem | undefined;
        if (!item || typeof item !== "object" || typeof item.type !== "string") return null;
        const p = this.pending.find((x) => !x.done && ((typeof item.id === "string" && x.item.id === item.id) || (item.id === undefined && idx !== undefined && x.outputIndex === idx)));
        if (p) p.done = true;
        this.done.push({ item, outputIndex: idx, seq: p?.seq ?? this.seq++ });
        return null;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = (ev.response ?? {}) as Record<string, unknown>;
        const items = this.items(response.output);
        if (ev.type === "response.incomplete") {
          const details = response.incomplete_details as { reason?: unknown } | undefined;
          return { status: "incomplete", items, incompleteReason: typeof details?.reason === "string" ? details.reason : "incomplete" };
        }
        if (!items.some((i) => i.type === "message" || i.type === "function_call")) {
          return { status: "incomplete", items, incompleteReason: items.some((i) => i.type === "reasoning") ? "reasoning_only" : "empty_output" };
        }
        return { status: "completed", items };
      }
      case "response.failed": {
        const response = (ev.response ?? {}) as Record<string, unknown>;
        const p = parseErrorObject({ error: response.error ?? {} }, Date.now());
        throw toError({ ...p, code: p.code ?? "unknown_error", status: statusForCode(p.code) });
      }
      case "error": {
        const p = parseErrorObject(ev, Date.now());
        throw toError({ ...p, code: p.code ?? "unknown_error", status: statusForCode(p.code) });
      }
      default:
        return null;
    }
  }

  private items(fallbackOutput: unknown): OutputItem[] {
    const entries: Entry[] = [...this.done];
    for (const p of this.pending) {
      if (!p.done) entries.push({ item: { ...p.item, arguments: p.args }, outputIndex: p.outputIndex, seq: p.seq });
    }
    if (entries.length === 0 && Array.isArray(fallbackOutput)) {
      return fallbackOutput.filter((i): i is OutputItem => !!i && typeof i === "object" && typeof (i as { type?: unknown }).type === "string");
    }
    const byIndex = entries.every((e) => e.outputIndex !== undefined);
    entries.sort((a, b) => (byIndex ? a.outputIndex! - b.outputIndex! || a.seq - b.seq : a.seq - b.seq));
    return entries.map((e) => e.item);
  }
}

/** [ERRORS]: the documented HTTP status of codes that can also arrive inside the stream. */
function statusForCode(code?: string): number | undefined {
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
    case "usage_limit_reached":
    case "usage_not_included":
    case "insufficient_quota":
      return 429;
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return 503;
    case "subscription_sharing_unsupported_capability":
      return 400;
    default:
      return undefined;
  }
}

function parseFrame(block: string): Record<string, unknown> | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  const raw = data.join("\n");
  if (raw === "" || raw === "[DONE]") return null;
  let ev: unknown;
  try {
    ev = JSON.parse(raw);
  } catch {
    throw new ModelApiError({ message: `无法解析模型事件流：${raw.slice(0, 120)}` });
  }
  if (!ev || typeof ev !== "object") return null;
  const o = ev as Record<string, unknown>;
  if (typeof o.type !== "string" && event) o.type = event;
  return o;
}

/** Whether a request sends an image or PDF block: one send per model call, so a file is never processed twice. */
function carriesFile(req: ResponsesRequest): boolean {
  return req.input.some((item) => item.type === "message" && Array.isArray(item.content)
    && item.content.some((p) => p.type === "input_file" || p.type === "input_image"));
}

/**
 * One streaming Responses call. Text deltas go to `onTextDelta` as they arrive; the result is assembled from
 * `response.output_item.done` items. Throws ModelQuotaError / ModelApiError / ReloginRequiredError (and the
 * AuthStore's AuthRateLimitedError / TransientAuthError); an abort rejects with the signal's reason.
 * A stream that breaks after it opened is not retried (deltas may already have been delivered).
 */
export async function streamResponse(req: ResponsesRequest, ctx: TransportContext & { onTextDelta?: (t: string) => void }): Promise<CollectedResponse> {
  const body = JSON.stringify(requestBody(req));
  if (Buffer.byteLength(body, "utf8") > (ctx.maxRequestBytes ?? MAX_DIRECT_REQUEST_BYTES)) throw new Error(REQUEST_TOO_LARGE_MESSAGE);
  const res = await send(ctx, `${ctx.profile.baseUrl}/responses`, (h) => ({
    method: "POST",
    headers: { ...h, "Content-Type": "application/json", Accept: "text/event-stream", session_id: req.sessionId },
    body,
  }), carriesFile(req));
  if (!res.body) throw new ModelApiError({ status: res.status, message: "模型接口返回了空的响应流" });
  const asm = new Assembler(ctx.onTextDelta);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
        throw new ModelApiError({ message: `模型事件流中断：${errMessage(e)}` }, { cause: e });
      }
      if (chunk.value) buf = (buf + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n");
      if (chunk.done) buf = (buf + decoder.decode()).replace(/\r\n?/g, "\n") + "\n\n";
      let at: number;
      while ((at = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const ev = parseFrame(block);
        if (!ev) continue;
        const result = asm.handle(ev);
        if (result) return result;
      }
      if (chunk.done) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new ModelApiError({ code: "stream_ended", message: "模型事件流在 response.completed 之前结束" });
}
