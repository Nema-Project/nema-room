import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStore, ReloginRequiredError, type StoredAuth } from "../../src/direct/authStore.js";
import {
  BYOK_PROFILE,
  ByokRejectedError,
  listModels,
  MAX_DIRECT_REQUEST_BYTES,
  ModelApiError,
  REQUEST_TOO_LARGE_MESSAGE,
  ModelQuotaError,
  SIWC_PROFILE,
  streamResponse,
  type ResponsesRequest,
  type TransportProfile,
} from "../../src/direct/transport.js";
import { json, reset, sse, startFakeResponsesServer, type FakeResponsesServer } from "../fixtures/fake-responses-server.js";

const b64u = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (p: Record<string, unknown>) => `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify(p))}.sig`;
const inOneHour = () => Math.floor(Date.now() / 1000) + 3600;
const ACCESS = jwt({ exp: inOneHour(), n: 1 });
const FRESH = jwt({ exp: inOneHour(), n: 2 });

let root: string;
let home: string;
let server: FakeResponsesServer;
let refreshCalls: number;
let store: AuthStore;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nema-transport-test-"));
  home = join(root, "nema");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  refreshCalls = 0;
  store = new AuthStore(home, async () => {
    refreshCalls++;
    return { access_token: FRESH, refresh_token: `rt-${refreshCalls}` };
  });
  const auth: StoredAuth = {
    version: 1,
    mode: "siwc",
    clientId: "oaiapp_test",
    tokens: { access_token: ACCESS, refresh_token: "rt-0" },
    lastRefresh: "2026-10-22T00:00:00.000Z",
  };
  store.save(auth);
  server = await startFakeResponsesServer();
});
afterEach(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const profile = (): TransportProfile => ({ ...SIWC_PROFILE, baseUrl: server.baseUrl });
const ctx = (extra: { onTextDelta?: (t: string) => void } = {}) => ({
  auth: store,
  profile: profile(),
  version: "1.2.3",
  signal: new AbortController().signal,
  retryDelayMs: 0,
  ...extra,
});
const req = (extra: Partial<ResponsesRequest> = {}): ResponsesRequest => ({
  model: "gpt-test",
  instructions: "be brief",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  tools: [{ type: "function", name: "read_entry", description: "read", strict: false, parameters: { type: "object", properties: {} } }],
  reasoning: { effort: "medium", summary: "auto" },
  sessionId: "sess-1",
  ...extra,
});

const msg = (text: string, id = "msg_1") => ({
  type: "message",
  id,
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const completed = (output: unknown[] = []) => ({ type: "response.completed", response: { id: "resp_1", status: "completed", output } });
const textStream = (text: string) =>
  sse([
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: text.slice(0, 2) },
    { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: text.slice(2) },
    { type: "response.output_item.done", output_index: 0, item: msg(text) },
    completed([msg(text)]),
  ]);

describe("streamResponse request", () => {
  test("the request cap is 48 MB", () => {
    expect(MAX_DIRECT_REQUEST_BYTES).toBe(48 * 1024 * 1024);
  });

  test("a body over the cap is never sent and fails with a fixed message", async () => {
    server.responses(textStream("hello"));
    const big = req({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(2000) }] }] });
    await expect(streamResponse(big, { ...ctx(), maxRequestBytes: 1000 })).rejects.toThrow(new Error(REQUEST_TOO_LARGE_MESSAGE));
    expect(REQUEST_TOO_LARGE_MESSAGE).toBe("这次任务的附件和对话合计超过模型一次请求的上限，请减少附件或不引用那条消息");
    expect(server.requests).toEqual([]);
  });

  test("the cap counts UTF-8 bytes, not characters", async () => {
    server.responses(textStream("hello"));
    const size = Buffer.byteLength(JSON.stringify({ x: "汉".repeat(400) }));
    const wide = req({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "汉".repeat(400) }] }] });
    // 400 characters, ~1200 bytes: a character count would pass a 1000-byte cap.
    expect(size).toBeGreaterThan(1000);
    await expect(streamResponse(wide, { ...ctx(), maxRequestBytes: 1000 })).rejects.toThrow(new Error(REQUEST_TOO_LARGE_MESSAGE));
    expect(server.requests).toEqual([]);
  });

  test("a body under the cap is sent", async () => {
    server.responses(textStream("hello"));
    await streamResponse(req(), { ...ctx(), maxRequestBytes: 100_000 });
    expect(server.requests).toHaveLength(1);
  });

  test("sends identifying headers and the exact body", async () => {
    server.responses(textStream("hello"));
    await streamResponse(req(), ctx());
    const r = server.requests[0]!;
    expect(r.method).toBe("POST");
    expect(r.url).toBe("/v1/responses");
    expect(r.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(r.headers["content-type"]).toBe("application/json");
    expect(r.headers.accept).toBe("text/event-stream");
    expect(r.headers.originator).toBe("nema-room");
    expect(r.headers["user-agent"]).toBe("NemaRoom/1.2.3");
    expect(r.headers.session_id).toBe("sess-1");
    expect(JSON.stringify(r.headers)).not.toContain("codex_cli_rs");
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body).toEqual({
      model: "gpt-test",
      instructions: "be brief",
      input: req().input,
      store: false,
      stream: true,
      tools: req().tools,
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "medium", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    });
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("prompt_cache_retention");
    expect(body).not.toHaveProperty("previous_response_id");
  });

  test("omits tools, tool_choice and parallel_tool_calls when there are no tools", async () => {
    server.responses(textStream("hello"));
    await streamResponse(req({ tools: [] }), ctx());
    const body = JSON.parse(server.requests[0]!.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body.store).toBe(false);
  });

  test("adds profile extra headers", async () => {
    server.responses(textStream("hello"));
    const p: TransportProfile = { ...profile(), extraHeaders: (a) => ({ "x-test-client": a.clientId }) };
    await streamResponse(req(), { ...ctx(), profile: p });
    expect(server.requests[0]!.headers["x-test-client"]).toBe("oaiapp_test");
  });
});

describe("streamResponse parsing", () => {
  test("text stream + completed → deltas and a message item", async () => {
    server.responses(textStream("hello"));
    const deltas: string[] = [];
    const r = await streamResponse(req(), ctx({ onTextDelta: (t) => deltas.push(t) }));
    expect(deltas.join("")).toBe("hello");
    expect(r.status).toBe("completed");
    expect(r.items).toEqual([msg("hello")]);
  });

  test("handles CRLF framing and frames split across chunks", async () => {
    server.responses((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const all = [
        { type: "response.output_text.delta", output_index: 0, delta: "ab" },
        { type: "response.output_item.done", output_index: 0, item: msg("ab") },
        completed(),
      ]
        .map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`)
        .join("");
      for (let i = 0; i < all.length; i += 7) res.write(all.slice(i, i + 7));
      res.end();
    });
    const deltas: string[] = [];
    const r = await streamResponse(req(), ctx({ onTextDelta: (t) => deltas.push(t) }));
    expect(deltas.join("")).toBe("ab");
    expect(r.items).toEqual([msg("ab")]);
  });

  test("function call: added → arguments.delta → done assembles a function_call item", async () => {
    server.responses(
      sse([
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_entry", arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: '{"id":' },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: '"e1"}' },
        { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: '{"id":"e1"}' },
        { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_entry", arguments: '{"id":"e1"}', status: "completed" } },
        completed(),
      ]),
    );
    const r = await streamResponse(req(), ctx());
    expect(r.status).toBe("completed");
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ type: "function_call", call_id: "call_1", name: "read_entry", arguments: '{"id":"e1"}' });
  });

  test("settles a function_call that was added but never done", async () => {
    server.responses(
      sse([
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_9", call_id: "call_9", name: "list_entries", arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_9", delta: "{}" },
        completed(),
      ]),
    );
    const r = await streamResponse(req(), ctx());
    expect(r.status).toBe("completed");
    expect(r.items).toEqual([{ type: "function_call", id: "fc_9", call_id: "call_9", name: "list_entries", arguments: "{}" }]);
  });

  test("items arriving out of output_index order are sorted by output_index", async () => {
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "list_entries", arguments: "{}" };
    server.responses(
      sse([
        { type: "response.output_item.done", output_index: 1, item: call },
        { type: "response.output_item.done", output_index: 0, item: msg("first") },
        completed(),
      ]),
    );
    const r = await streamResponse(req(), ctx());
    expect(r.items).toEqual([msg("first"), call]);
  });

  test("without output_index everywhere, wire order is kept", async () => {
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "list_entries", arguments: "{}" };
    server.responses(
      sse([
        { type: "response.output_item.done", output_index: 1, item: call },
        { type: "response.output_item.done", item: msg("second") },
        completed(),
      ]),
    );
    const r = await streamResponse(req(), ctx());
    expect(r.items).toEqual([call, msg("second")]);
  });

  test("completed with an empty output still uses the done items", async () => {
    server.responses(sse([{ type: "response.output_item.done", output_index: 0, item: msg("done item") }, completed([])]));
    const r = await streamResponse(req(), ctx());
    expect(r.status).toBe("completed");
    expect(r.items).toEqual([msg("done item")]);
  });

  test("reasoning-only completed → incomplete", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" };
    server.responses(sse([{ type: "response.output_item.done", output_index: 0, item: reasoning }, completed([reasoning])]));
    const r = await streamResponse(req(), ctx());
    expect(r.status).toBe("incomplete");
    expect(r.items).toEqual([reasoning]);
    expect(r.incompleteReason).toBe("reasoning_only");
  });

  test("response.incomplete → incomplete with the reason", async () => {
    server.responses(
      sse([
        { type: "response.output_item.done", output_index: 0, item: msg("partial") },
        { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } },
      ]),
    );
    const r = await streamResponse(req(), ctx());
    expect(r.status).toBe("incomplete");
    expect(r.incompleteReason).toBe("max_output_tokens");
    expect(r.items).toEqual([msg("partial")]);
  });

  test("an error frame throws ModelApiError", async () => {
    server.responses(sse([{ type: "error", code: "server_error", message: "boom" }]));
    const e = await streamResponse(req(), ctx()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelApiError);
    expect((e as ModelApiError).code).toBe("server_error");
    expect((e as ModelApiError).message).toContain("boom");
  });

  test("a stream that ends before a terminal event throws ModelApiError", async () => {
    server.responses(sse([{ type: "response.output_text.delta", output_index: 0, delta: "x" }]));
    await expect(streamResponse(req(), ctx())).rejects.toBeInstanceOf(ModelApiError);
  });

  test("response.failed with an ordinary code → ModelApiError", async () => {
    server.responses(
      sse([{ type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_unsupported_capability", message: "no", param: "tools" } } }]),
    );
    const e = (await streamResponse(req(), ctx()).catch((x: unknown) => x)) as ModelApiError;
    expect(e).toBeInstanceOf(ModelApiError);
    expect(e.code).toBe("subscription_sharing_unsupported_capability");
    expect(e.message).toContain("tools");
  });
});

describe("streamResponse auth and errors", () => {
  test("BYOK 401 rejects without refreshing or exposing the response body", async () => {
    server.responses(json(401, { error: { message: "sekret-key" } }), textStream("should not retry"));
    const byokAuth = {
      async getAccessToken(opts?: { force?: boolean }) {
        if (opts?.force) throw new Error("must not refresh");
        return { accessToken: "byok-key", auth: store.read()! };
      },
      async recordAuthError() {
        throw new Error("must not record auth error");
      },
    };
    const e = await streamResponse(req(), { ...ctx(), auth: byokAuth, profile: { ...BYOK_PROFILE, baseUrl: server.baseUrl } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ByokRejectedError);
    expect((e as Error).message).toBe("API key 被拒绝，请在终端运行 nema auth byok");
    expect((e as Error).message).not.toContain("sekret-key");
    expect(server.requests).toHaveLength(1);
  });

  test("a connection error message never carries the underlying fetch text", async () => {
    const badHeaderAuth = {
      async getAccessToken() {
        return { accessToken: "sekret-a\nsekret-b", auth: store.read()! };
      },
      async recordAuthError() {},
    };
    const e = await streamResponse(req(), { ...ctx(), auth: badHeaderAuth, profile: { ...BYOK_PROFILE, baseUrl: server.baseUrl } }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelApiError);
    expect((e as Error).message).toMatch(/^无法连接模型接口/);
    expect((e as Error).message).not.toContain("sekret");
    expect((e as Error).message).not.toContain("Bearer");
    expect(server.requests).toHaveLength(0);
  });

  test("BYOK still retries one 5xx", async () => {
    server.responses(json(500, { error: { message: "oops" } }), textStream("ok"));
    const r = await streamResponse(req(), { ...ctx(), profile: { ...BYOK_PROFILE, baseUrl: server.baseUrl } });
    expect(r.status).toBe("completed");
    expect(server.requests).toHaveLength(2);
  });

  test("401 → forced refresh once, retried with the new token", async () => {
    server.responses(json(401, { error: { code: "invalid_token", message: "expired" } }), textStream("ok"));
    const r = await streamResponse(req(), ctx());
    expect(r.status).toBe("completed");
    expect(refreshCalls).toBe(1);
    expect(server.requests.map((x) => x.headers.authorization)).toEqual([`Bearer ${ACCESS}`, `Bearer ${FRESH}`]);
  });

  test("401 twice → ReloginRequiredError", async () => {
    server.responses(json(401, { error: { code: "invalid_token" } }), json(401, { error: { code: "invalid_token" } }));
    await expect(streamResponse(req(), ctx())).rejects.toBeInstanceOf(ReloginRequiredError);
    expect(refreshCalls).toBe(1);
    expect(server.requests).toHaveLength(2);
    // recorded for `nema auth status` / doctor; tokens are not cleared
    const disk = store.read()!;
    expect(disk.lastAuthError?.code).toBe("model_unauthorized");
    expect(disk.tokens.refresh_token).toBe("rt-1");
  });

  test("429 usage_limit_reached with resets_at → ModelQuotaError.resetsAt (epoch ms)", async () => {
    server.responses(json(429, { error: { type: "usage_limit_reached", message: "limit", resets_at: 1_800_000_000 } }));
    const e = (await streamResponse(req(), ctx()).catch((x: unknown) => x)) as ModelQuotaError;
    expect(e).toBeInstanceOf(ModelQuotaError);
    expect(e.resetsAt).toBe(1_800_000_000_000);
    expect(e.code).toBe("usage_limit_reached");
    expect(server.requests).toHaveLength(1);
  });

  test.each(["subscription_sharing_usage_limit_exceeded", "usage_not_included", "insufficient_quota"])("429 %s → ModelQuotaError without resetsAt", async (code) => {
    server.responses(json(429, { error: { code, message: "limit" } }));
    const e = (await streamResponse(req(), ctx()).catch((x: unknown) => x)) as ModelQuotaError;
    expect(e).toBeInstanceOf(ModelQuotaError);
    expect(e.resetsAt).toBeUndefined();
    expect(e.message).toContain("429");
    expect(e.message).toContain(code);
  });

  test("response.failed mid-stream with subscription_sharing_usage_limit_exceeded → ModelQuotaError", async () => {
    const deltas: string[] = [];
    server.responses(
      sse([
        { type: "response.output_text.delta", output_index: 0, delta: "par" },
        { type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } },
      ]),
    );
    const e = await streamResponse(req(), ctx({ onTextDelta: (t) => deltas.push(t) })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelQuotaError);
    expect(deltas).toEqual(["par"]);
    expect(server.requests).toHaveLength(1);
  });

  test("503 subscription_sharing_usage_unavailable → ModelQuotaError, no retry", async () => {
    server.responses(json(503, { error: { code: "subscription_sharing_usage_unavailable", message: "busy" } }));
    const e = await streamResponse(req(), ctx()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelQuotaError);
    expect(server.requests).toHaveLength(1);
  });

  test("response.failed with subscription_sharing_usage_unavailable → ModelQuotaError", async () => {
    server.responses(sse([{ type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable" } } }]));
    await expect(streamResponse(req(), ctx())).rejects.toBeInstanceOf(ModelQuotaError);
  });

  test("5xx once then success", async () => {
    server.responses(json(500, { error: { message: "oops" } }), textStream("ok"));
    const r = await streamResponse(req(), ctx());
    expect(r.status).toBe("completed");
    expect(server.requests).toHaveLength(2);
  });

  test("5xx twice → ModelApiError with status", async () => {
    server.responses(json(502, { detail: "bad gateway" }), json(502, { detail: "bad gateway" }));
    const e = (await streamResponse(req(), ctx()).catch((x: unknown) => x)) as ModelApiError;
    expect(e).toBeInstanceOf(ModelApiError);
    expect(e.status).toBe(502);
    expect(e.message).toContain("bad gateway");
    expect(server.requests).toHaveLength(2);
  });

  test("a connection error is retried once", async () => {
    server.responses(reset, textStream("ok"));
    const r = await streamResponse(req(), ctx());
    expect(r.status).toBe("completed");
    expect(server.requests).toHaveLength(2);
  });

  test("400 is not retried → ModelApiError with code and param", async () => {
    server.responses(json(400, { error: { code: "subscription_sharing_unsupported_capability", message: "unsupported", param: "reasoning" } }));
    const e = (await streamResponse(req(), ctx()).catch((x: unknown) => x)) as ModelApiError;
    expect(e).toBeInstanceOf(ModelApiError);
    expect(e.status).toBe(400);
    expect(e.code).toBe("subscription_sharing_unsupported_capability");
    expect(e.message).toContain("reasoning");
    expect(server.requests).toHaveLength(1);
  });

  test("an aborted signal rejects without retrying", async () => {
    const ac = new AbortController();
    ac.abort();
    server.responses(textStream("ok"));
    await expect(streamResponse(req(), { ...ctx(), signal: ac.signal })).rejects.toThrow();
    expect(server.requests).toHaveLength(0);
  });
});

describe("listModels", () => {
  test("GET /models keeps visibility=list slugs in server order, with identifying headers", async () => {
    server.models(
      json(200, {
        models: [
          { slug: "gpt-b", visibility: "list" },
          { slug: "gpt-hidden", visibility: "hide" },
          { slug: "gpt-a", visibility: "list" },
        ],
      }),
    );
    expect(await listModels(ctx())).toEqual(["gpt-b", "gpt-a"]);
    const r = server.requests[0]!;
    expect(r.method).toBe("GET");
    expect(r.headers.authorization).toBe(`Bearer ${ACCESS}`);
    expect(r.headers.originator).toBe("nema-room");
    expect(r.headers["user-agent"]).toBe("NemaRoom/1.2.3");
  });

  test("401 → forced refresh then retry", async () => {
    server.models(json(401, {}), json(200, { models: [{ slug: "gpt-a", visibility: "list" }] }));
    expect(await listModels(ctx())).toEqual(["gpt-a"]);
    expect(refreshCalls).toBe(1);
  });

  test("BYOK_PROFILE reads the OpenAI-compatible data[].id catalog in server order", () => {
    expect(BYOK_PROFILE.parseModels({ object: "list", data: [{ id: "b", object: "model" }, { id: "" }, { object: "model" }, { id: "a" }] })).toEqual(["b", "a"]);
    // A SIWC-style catalog behind a custom base URL keeps working.
    expect(BYOK_PROFILE.parseModels({ models: [{ slug: "x", visibility: "list" }, { slug: "y", visibility: "hide" }] })).toEqual(["x"]);
    expect(() => BYOK_PROFILE.parseModels({})).toThrow(ModelApiError);
    expect(() => BYOK_PROFILE.parseModels({ data: "nope" })).toThrow(ModelApiError);
  });

  test("SIWC_PROFILE defaults", () => {
    expect(SIWC_PROFILE.baseUrl).toBe("https://api.openai.com/v1");
    expect(SIWC_PROFILE.modelsPath).toBe("/models");
    expect(SIWC_PROFILE.parseModels({ models: [{ slug: "x", visibility: "list" }, { slug: "y", visibility: "hidden" }] })).toEqual(["x"]);
    expect(() => SIWC_PROFILE.parseModels({})).toThrow();
  });
});
