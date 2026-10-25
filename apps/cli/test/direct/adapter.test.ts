import { makePublic } from "../nativePermissions.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskAssign, TaskEvent } from "@nema/shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadConfig, saveConfig } from "../../src/config.js";
import { CodexDirectAdapter } from "../../src/direct/adapter.js";
import { AuthStore, RELOGIN_MESSAGE, type StoredAuth } from "../../src/direct/authStore.js";
import { byokKeyPath, saveByokKey } from "../../src/direct/byok.js";
import { COMPAT_PROFILE, SIWC_PROFILE, type TransportProfile } from "../../src/direct/transport.js";
import { json, sse, startFakeResponsesServer, type FakeResponsesServer } from "../fixtures/fake-responses-server.js";

const b64u = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (p: Record<string, unknown>) => `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify(p))}.sig`;
const ACCESS = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

let root: string;
let home: string;
let server: FakeResponsesServer;
let hub: Server;
let hubUrl: string;
let hubSeen: { method?: string; url?: string; auth?: string; body: string }[];

const auth = (tokens = { access_token: ACCESS, refresh_token: "rt-0" }): StoredAuth => ({
  version: 1,
  mode: "siwc",
  clientId: "oaiapp_test",
  tokens,
  lastRefresh: "2026-10-22T00:00:00.000Z",
});
const refresher = async () => {
  throw new Error("refresher must not run in these tests");
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nema-adapter-test-"));
  home = join(root, "nema");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  server = await startFakeResponsesServer();
  hubSeen = [];
  hub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hubSeen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "POST" ? '{"id":"R-1"}' : '{"entries":[]}');
    });
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await server.close();
  hub.closeAllConnections();
  await new Promise<void>((r) => hub.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

const profile = (): TransportProfile => ({ ...SIWC_PROFILE, baseUrl: server.baseUrl });
const adapter = (extra: { timeoutMs?: number } = {}) =>
  new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: profile(), refresher, ...extra });
const task = (): TaskAssign => ({
  type: "task.assign",
  taskId: "t1",
  workspaceId: "w1",
  adapter: "auto",
  confidential: true,
  prompt: "HUB PROMPT: 规则与上下文",
  runToken: "run-tok",
  hubUrl,
  pluginTools: [],
});
const login = () => new AuthStore(home, refresher).save(auth());
const models = (...slugs: string[]) => json(200, { models: slugs.map((slug) => ({ slug, visibility: "list" })) });

const msgItem = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const fcItem = (name: string, args: unknown, call_id: string) => ({ type: "function_call", id: `fc_${call_id}`, call_id, name, arguments: JSON.stringify(args), status: "completed" });
const stream = (items: Record<string, unknown>[], deltas: string[] = []) =>
  sse([
    { type: "response.created", response: { id: "resp" } },
    ...deltas.map((delta) => ({ type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta })),
    ...items.map((item, i) => ({ type: "response.output_item.done", output_index: i, item })),
    { type: "response.completed", response: { id: "resp", status: "completed", output: items } },
  ]);

async function run(a = adapter()) {
  const events: TaskEvent[] = [];
  const result = await a.run(task(), (e) => events.push(e));
  return { result, events };
}

describe("CodexDirectAdapter", () => {
  test("is named codex-direct", () => {
    expect(adapter().name).toBe("codex-direct");
  });

  test("no login -> fails with the login hint, no network", async () => {
    const { result } = await run();
    expect(result).toEqual({ ok: false, error: "未登录直连 Codex，请在终端运行 nema auth login" });
    expect(server.requests).toEqual([]);
  });

  test("a cleared login -> ReloginRequiredError message", async () => {
    new AuthStore(home, refresher).save({ ...auth({ access_token: "", refresh_token: "" }), lastAuthError: { code: "invalid_grant", message: "x", at: "2026-10-22T00:00:00.000Z" } });
    const { result } = await run();
    expect(result).toEqual({ ok: false, error: RELOGIN_MESSAGE });
  });

  test("full run: model from the list, only the 3 Room functions, upsert via hub, reply + progress", async () => {
    login();
    server.models(models("gpt-first", "gpt-second"));
    server.responses(
      stream([fcItem("upsert_entry", { kind: "requirement", title: "t", body: "b", reason: "r", sourceMessages: ["m1"] }, "c1")]),
      stream([msgItem("已记录 R-1。")], ["已记录", " R-1。"]),
    );
    const { result, events } = await run();
    expect(result).toEqual({ ok: true, reply: "已记录 R-1。" });

    const bodies = server.requests.filter((r) => r.url === "/v1/responses").map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(bodies.length).toBe(2);
    for (const b of bodies) {
      expect(b.model).toBe("gpt-first");
      expect(b.instructions).toBe("HUB PROMPT: 规则与上下文");
      expect(b.store).toBe(false);
      expect(b.reasoning).toEqual({ effort: "medium", summary: "auto" });
      const tools = b.tools as { type: string; name: string }[];
      expect(tools.length).toBe(3);
      expect(tools.every((t) => t.type === "function")).toBe(true);
      expect(tools.map((t) => t.name)).toEqual(["list_entries", "read_entry", "upsert_entry"]);
    }
    const second = bodies[1]!.input as { type: string; call_id?: string }[];
    expect(second.filter((i) => i.call_id === "c1").map((i) => i.type)).toEqual(["function_call", "function_call_output"]);

    expect(hubSeen.map((s) => `${s.method} ${s.url} ${s.auth}`)).toEqual(["POST /room/entries Bearer run-tok"]);
    expect(events.some((e) => e.type === "tool_call" && e.text.includes("upsert_entry"))).toBe(true);
    const msgs = events.filter((e) => e.type === "agent_message").map((e) => e.text);
    expect(msgs.at(-1)).toBe("已记录 R-1。");
  });

  test("direct adapter sends the plugin tools to the model", async () => {
    login();
    saveConfig(home, { model: "gpt-configured" });
    server.responses(stream([msgItem("ok")]));
    const assigned = task();
    assigned.pluginTools = [
      {
        name: "code__read",
        description: "Read a file from the repository.",
        parameters: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" } }, required: ["repo", "path"] },
      },
    ];
    const events: TaskEvent[] = [];
    const result = await adapter().run(assigned, (e) => events.push(e));
    expect(result).toEqual({ ok: true, reply: "ok" });
    const body = JSON.parse(server.requests.find((r) => r.url === "/v1/responses")!.body) as { tools: { type: string; name: string; strict: boolean }[] };
    expect(body.tools.map((t) => t.name)).toEqual(["list_entries", "read_entry", "upsert_entry", "code__read"]);
    expect(body.tools.every((t) => t.type === "function" && t.strict === false)).toBe(true);
  });

  test("config.model wins over the model list", async () => {
    login();
    saveConfig(home, { model: "gpt-configured", reasoningEffort: "high" });
    server.responses(stream([msgItem("ok")]));
    const { result } = await run();
    expect(result).toEqual({ ok: true, reply: "ok" });
    expect(server.requests.some((r) => r.url === "/v1/models")).toBe(false);
    const body = JSON.parse(server.requests[0]!.body) as { model: string; reasoning: { effort: string } };
    expect(body.model).toBe("gpt-configured");
    expect(body.reasoning.effort).toBe("high");
  });

  test("model list unavailable or empty -> gpt-5.5", async () => {
    login();
    server.models(json(400, { error: { code: "bad", message: "nope" } }));
    server.responses(stream([msgItem("ok")]));
    expect((await run()).result).toEqual({ ok: true, reply: "ok" });
    server.models(models());
    server.responses(stream([msgItem("ok")]));
    expect((await run()).result).toEqual({ ok: true, reply: "ok" });
    const used = server.requests.filter((r) => r.url === "/v1/responses").map((r) => (JSON.parse(r.body) as { model: string }).model);
    expect(used).toEqual(["gpt-5.5", "gpt-5.5"]);
  });

  test("quota exhausted with a reset time -> local time in the message", async () => {
    login();
    saveConfig(home, { model: "m" });
    const resetsAt = new Date(2026, 9, 24, 7, 5).getTime();
    server.responses(json(429, { error: { code: "usage_limit_reached", message: "limit", resets_at: Math.floor(resetsAt / 1000) } }));
    expect((await run()).result).toEqual({ ok: false, error: "订阅额度已用完，预计 2026-10-24 07:05 恢复" });
  });

  test("quota exhausted without a reset time", async () => {
    login();
    saveConfig(home, { model: "m" });
    server.responses(json(429, { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } }));
    expect((await run()).result).toEqual({ ok: false, error: "订阅额度已用完" });
  });

  test("distinct Chinese messages per quota code", async () => {
    login();
    saveConfig(home, { model: "m" });
    const cases: [string, string][] = [
      ["usage_limit_exceeded", "订阅额度已用完"],
      ["insufficient_quota", "订阅额度已用完"],
      ["subscription_sharing_usage_unavailable", "订阅额度暂时不可用，请稍后重试"],
      ["usage_not_included", "当前订阅不包含此用量"],
    ];
    for (const [code, text] of cases) {
      server.responses(json(code === "subscription_sharing_usage_unavailable" ? 503 : 429, { error: { code, message: "m" } }));
      expect((await run()).result, code).toEqual({ ok: false, error: text });
    }
  });

  test("an untrusted credential file is reported as unusable, not as not logged in", async () => {
    login();
    makePublic(join(home, "auth.json"));
    expect((await run()).result).toEqual({ ok: false, error: "凭证文件不可用（权限/符号链接/损坏），请重新运行 nema auth login" });
  });

  test("an upsert succeeds, then the next stream fails with a quota code: Chinese quota message, exactly one hub write, no rollback", async () => {
    login();
    saveConfig(home, { model: "m" });
    server.responses(
      stream([fcItem("upsert_entry", { kind: "requirement", title: "t", body: "b", reason: "r", sourceMessages: ["m1"] }, "c1")]),
      sse([{ type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }]),
    );
    const { result } = await run();
    expect(result).toEqual({ ok: false, error: "订阅额度已用完" });
    expect(hubSeen.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /room/entries"]);
  });

  test("other API errors -> 模型接口错误：", async () => {
    login();
    saveConfig(home, { model: "m" });
    server.responses(json(400, { error: { code: "invalid_request_error", message: "bad input" } }));
    const { result } = await run();
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/^模型接口错误：.*bad input/);
  });

  test("a run that exceeds the timeout fails with 「Codex 直连运行超时」", async () => {
    login();
    saveConfig(home, { model: "m" });
    server.responses((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": keep-alive\n\n"); // then hang
    });
    const t0 = Date.now();
    const { result } = await run(adapter({ timeoutMs: 300 }));
    expect(result).toEqual({ ok: false, error: "Codex 直连运行超时" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  test("an owner abort cancels an active HTTP response and waits for transport teardown", async () => {
    login();
    saveConfig(home, { model: "m" });
    let closed!: () => void;
    const responseClosed = new Promise<void>((resolve) => { closed = resolve; });
    server.responses((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": active\n\n");
      res.on("close", closed);
    });
    const controller = new AbortController();
    const pending = adapter().run(task(), () => {}, controller.signal);
    await vi.waitFor(() => expect(server.requests.some((r) => r.url === "/v1/responses")).toBe(true));
    controller.abort(new Error("owner stopped"));
    await pending;
    await responseClosed;
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(1);
  });

  test("loop limit errors surface verbatim", async () => {
    login();
    saveConfig(home, { model: "m" });
    for (let i = 0; i < 6; i++) server.responses(stream([fcItem("exec_command", { cmd: "id" }, `c${i}`)]));
    expect((await run()).result).toEqual({ ok: false, error: "Agent 多次请求未提供的工具，已中止" });
    expect(hubSeen).toEqual([]);
  });

  test("the direct adapter stops at limits.maxModelCalls", async () => {
    login();
    saveConfig(home, { model: "m" });
    for (let i = 0; i < 4; i++) {
      server.responses(stream([fcItem("upsert_entry", { kind: "requirement", title: "t", body: "b", reason: "r", sourceMessages: ["m1"] }, `c${i}`)]));
    }
    const limited = { ...task(), limits: { maxModelCalls: 3, maxToolCalls: 100, timeoutMs: 60_000 } };
    const result = await adapter().run(limited, () => {});
    expect(result).toEqual({ ok: false, error: "Agent 超出单次运行上限（模型调用 3 次）" });
    expect(server.requests.filter((r) => r.url === "/v1/responses").length).toBe(3);
  });

  test("a hub call resolving after the timeout emits no further events", async () => {
    login();
    saveConfig(home, { model: "m" });
    hub.removeAllListeners("request");
    hub.on("request", (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"entries":[]}');
      }, 600);
    });
    server.responses(stream([fcItem("list_entries", {}, "c1")]), stream([msgItem("不应到达")]));
    const events: TaskEvent[] = [];
    const result = await adapter({ timeoutMs: 250 }).run(task(), (e) => events.push(e));
    expect(result).toEqual({ ok: false, error: "Codex 直连运行超时" });
    const seen = events.length;
    const modelCalls = () => server.requests.filter((r) => r.url === "/v1/responses").length;
    const seenCalls = modelCalls();
    await new Promise((r) => setTimeout(r, 800));
    expect(events.length).toBe(seen);
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
    // The first model call may win the race with the timeout. The late hub response must not send another.
    expect(modelCalls()).toBe(seenCalls);
    expect(modelCalls()).toBeLessThanOrEqual(1);
  });

  test("compat sends the Codex access token and account id, and does not rewrite the Codex file", async () => {
    saveConfig(home, { authMode: "compat", model: "gpt-z" });
    const codexHome = join(root, "codex");
    mkdirSync(codexHome);
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct-zzzz" } });
    const authPath = join(codexHome, "auth.json");
    writeFileSync(authPath, JSON.stringify({ tokens: { access_token: access, refresh_token: "rt-do-not-spend" } }));
    const before = readFileSync(authPath);
    server.responses(stream([msgItem("ok")]));
    const a = new CodexDirectAdapter({
      nemaHome: home,
      version: "9.9.9",
      codexHome,
      profile: { ...COMPAT_PROFILE, baseUrl: server.baseUrl },
      refresher,
    });
    const { result } = await run(a);
    expect(result).toEqual({ ok: true, reply: "ok" });
    const call = server.requests.find((r) => r.url === "/v1/responses");
    expect(call?.headers.authorization).toBe(`Bearer ${access}`);
    expect(call?.headers["chatgpt-account-id"]).toBe("acct-zzzz");
    expect(call?.headers.originator).toBe("nema-room");
    expect(readFileSync(authPath)).toEqual(before);
  });

  test("byok sends the saved key with the configured model, base URL, and reasoning effort", async () => {
    saveConfig(home, { authMode: "byok", model: "gpt-z", byokBaseUrl: server.baseUrl, reasoningEffort: "high" });
    saveByokKey(home, "sekret-key");
    server.responses(stream([msgItem("ok")]));

    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", refresher }));

    expect(result).toEqual({ ok: true, reply: "ok" });
    expect(server.requests).toHaveLength(1);
    const call = server.requests[0]!;
    expect(call.url.endsWith("/responses")).toBe(true);
    expect(call.headers.authorization).toBe("Bearer sekret-key");
    expect(call.headers["chatgpt-account-id"]).toBeUndefined();
    expect(call.headers.originator).toBe("nema-room");
    expect((JSON.parse(call.body) as { reasoning: { effort: string } }).reasoning.effort).toBe("high");
    expect(server.requests.some((request) => request.url.includes("/models"))).toBe(false);
  });

  test("byok ignores OPENAI_API_KEY when the saved key is missing", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "from-env";
    try {
      saveConfig(home, { authMode: "byok", model: "gpt-z", byokBaseUrl: server.baseUrl });
      expect((await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", refresher }))).result).toEqual({
        ok: false,
        error: "没有 BYOK API key。请把钥匙从标准输入交给 nema auth byok。",
      });
      expect(server.requests).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test("byok requires an explicitly configured model before making a request", async () => {
    saveConfig(home, { authMode: "byok", byokBaseUrl: server.baseUrl });
    saveByokKey(home, "sekret-key");

    expect((await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", refresher }))).result).toEqual({
      ok: false,
      error: "BYOK 需要指定模型，请运行 nema config set model <名称>",
    });
    expect(server.requests).toEqual([]);
  });

  test("byok rejection preserves auth files and hides the rejected key", async () => {
    saveConfig(home, { authMode: "byok", model: "gpt-z", byokBaseUrl: server.baseUrl });
    saveByokKey(home, "sekret-key");
    const authPath = join(home, "auth.json");
    writeFileSync(authPath, '{"keep":"these exact bytes"}\n');
    const before = readFileSync(authPath);
    server.responses(json(401, { error: { code: "invalid_api_key", message: "rejected sekret-key" } }));

    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", refresher }));

    expect(result).toEqual({ ok: false, error: "API key 被拒绝，请在终端运行 nema auth byok" });
    expect((result as { error: string }).error).not.toContain("sekret-key");
    expect(server.requests).toHaveLength(1);
    expect(readFileSync(authPath)).toEqual(before);
    expect(loadConfig(home).authMode).toBe("byok");
  });

  test("byok with a hand-written multi-line key fails before any request and hides the key", async () => {
    saveConfig(home, { authMode: "byok", model: "gpt-z", byokBaseUrl: server.baseUrl });
    writeFileSync(byokKeyPath(home), "sekret-a\nsekret-b", { mode: 0o600 });

    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", refresher }));

    expect(result).toEqual({ ok: false, error: "BYOK key 文件内容无效。请重新把钥匙从标准输入交给 nema auth byok。" });
    expect(server.requests).toEqual([]);
  });

  test("siwc without a login does not read the BYOK key", async () => {
    saveByokKey(home, "sekret-key");
    makePublic(byokKeyPath(home));

    expect((await run()).result).toEqual({ ok: false, error: "未登录直连 Codex，请在终端运行 nema auth login" });
    expect(server.requests).toEqual([]);
  });
});
