import { makePublic, writePrivateFile } from "../nativePermissions.js";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentRef, TaskAssign, TaskEvent } from "@nema/shared";
import type { Account } from "../../src/accounts/schema.js";
import { attachmentPreamble } from "../../src/attachments/blocks.js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadConfig, saveConfig } from "../../src/config.js";
import { CodexDirectAdapter } from "../../src/direct/adapter.js";
import { AuthStore, RELOGIN_MESSAGE, type StoredAuth } from "../../src/direct/authStore.js";
import { byokKeyPath, saveByokKey } from "../../src/direct/byok.js";
import { COMPAT_PROFILE, REQUEST_TOO_LARGE_MESSAGE, SIWC_PROFILE, type TransportProfile } from "../../src/direct/transport.js";
import { json, reset, sse, startFakeResponsesServer, type FakeResponsesServer } from "../fixtures/fake-responses-server.js";
import { Cooldowns } from "../../src/routing/cooldown.js";

const b64u = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (p: Record<string, unknown>) => `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify(p))}.sig`;
const ACCESS = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

let root: string;
let home: string;
let server: FakeResponsesServer;
let hub: Server;
let hubUrl: string;
let hubSeen: { method?: string; url?: string; auth?: string; body: string }[];
let hubFiles: Map<string, { status: number; type: string; body: Buffer; stall?: boolean }>;
let hubSkillReply: { delayMs: number; status: number };

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
  hubFiles = new Map();
  hubSkillReply = { delayMs: 0, status: 204 };
  hub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hubSeen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url === "/room/skills/activated") {
        const { delayMs, status } = hubSkillReply;
        setTimeout(() => res.writeHead(status, { "content-type": "application/json" }).end(status === 204 ? undefined : '{"error":"nope"}'), delayMs);
        return;
      }
      if (req.url?.startsWith("/room/attachments/")) {
        const file = hubFiles.get(decodeURIComponent(req.url.slice("/room/attachments/".length)));
        if (file?.stall) return;
        if (!file) res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not in task"}');
        else res.writeHead(file.status, { "content-type": file.type }).end(file.body);
        return;
      }
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
const adapter = (extra: { timeoutMs?: number; maxRequestBytes?: number } = {}) =>
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

async function run(a = adapter(), assigned: TaskAssign = task(), signal?: AbortSignal) {
  const events: TaskEvent[] = [];
  const result = await a.run(assigned, (e) => events.push(e), signal);
  return { result, events };
}

describe("CodexDirectAdapter", () => {
  test("is named codex-direct", () => {
    expect(adapter().name).toBe("codex-direct");
  });

  test("no login -> fails with the login hint, no network", async () => {
    const { result } = await run();
    expect(result).toMatchObject({ ok: false, error: "未登录直连 Codex，请在终端运行 nema auth login" });
    expect(server.requests).toEqual([]);
  });

  test("a cleared login -> ReloginRequiredError message", async () => {
    new AuthStore(home, refresher).save({ ...auth({ access_token: "", refresh_token: "" }), lastAuthError: { code: "invalid_grant", message: "x", at: "2026-10-22T00:00:00.000Z" } });
    const { result } = await run();
    expect(result).toMatchObject({ ok: false, error: RELOGIN_MESSAGE });
  });

  test("full run: model from the list, Room functions, upsert via hub, reply + progress", async () => {
    login();
    server.models(models("gpt-first", "gpt-second"));
    server.responses(
      stream([fcItem("upsert_entry", { kind: "requirement", title: "t", body: "b", reason: "r", sourceMessages: ["m1"] }, "c1")]),
      stream([msgItem("已记录 R-1。")], ["已记录", " R-1。"]),
    );
    const { result, events } = await run();
    expect(result).toMatchObject({ ok: true, reply: "已记录 R-1。" });

    const bodies = server.requests.filter((r) => r.url === "/v1/responses").map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(bodies.length).toBe(2);
    for (const b of bodies) {
      expect(b.model).toBe("gpt-first");
      expect(b.instructions).toBe("HUB PROMPT: 规则与上下文");
      expect(b.store).toBe(false);
      expect(b.reasoning).toEqual({ effort: "medium", summary: "auto" });
      const tools = b.tools as { type: string; name: string }[];
      expect(tools.length).toBe(5);
      expect(tools.every((t) => t.type === "function")).toBe(true);
      expect(tools.map((t) => t.name)).toEqual(["list_entries", "read_entry", "upsert_entry", "open_thread", "offer_skill_install"]);
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
    expect(result).toMatchObject({ ok: true, reply: "ok" });
    const body = JSON.parse(server.requests.find((r) => r.url === "/v1/responses")!.body) as { tools: { type: string; name: string; strict: boolean }[] };
    expect(body.tools.map((t) => t.name)).toEqual(["list_entries", "read_entry", "upsert_entry", "open_thread", "offer_skill_install", "code__read"]);
    expect(body.tools.every((t) => t.type === "function" && t.strict === false)).toBe(true);
  });

  test("with an enabled Skill: catalog after the hub prompt, read_skill offered and answered locally", async () => {
    login();
    saveConfig(home, { model: "gpt-configured" });
    const { managedSkill, skillText, COMMIT } = await import("../skills/helpers.js");
    managedSkill(home, "tdd", { "SKILL.md": skillText("tdd", "Write the test first.", "# TDD\n\nRed, green, refactor.\n") });
    server.responses(stream([fcItem("read_skill", { name: "tdd" }, "c1")]), stream([msgItem("done")]));
    const { result, events } = await run();
    expect(result).toMatchObject({ ok: true, reply: "done" });
    const bodies = server.requests.filter((r) => r.url === "/v1/responses").map((r) => JSON.parse(r.body) as Record<string, unknown>);
    for (const b of bodies) {
      expect(String(b.instructions).startsWith("HUB PROMPT: 规则与上下文\n\n# 可用 Skills\n")).toBe(true);
      expect(String(b.instructions)).toContain("<skill><name>tdd</name><description>Write the test first.</description></skill>");
      expect((b.tools as { name: string }[]).map((t) => t.name)).toEqual(["list_entries", "read_entry", "upsert_entry", "open_thread", "offer_skill_install", "read_skill"]);
    }
    const output = (bodies[1]!.input as { type: string; output?: string }[]).find((i) => i.type === "function_call_output")!.output!;
    expect(output).toContain(`<skill_content name="tdd" revision="${COMMIT}">\n# TDD\n\nRed, green, refactor.\n`);
    expect(hubSeen.map((h) => `${h.method} ${h.url} ${h.body}`)).toEqual([`POST /room/skills/activated {"skillId":"tdd","revision":"${COMMIT}"}`]);
    expect(events.filter((e) => e.type === "tool_call").map((e) => e.text)).toEqual([`读取 Skill tdd（${COMMIT}）`]);
  });

  test("a thread's retained Skill is preloaded, not read again and not reported", async () => {
    login();
    saveConfig(home, { model: "gpt-configured" });
    const { managedSkill, skillText, COMMIT } = await import("../skills/helpers.js");
    managedSkill(home, "tdd", { "SKILL.md": skillText("tdd", "Write the test first.", "# TDD\n") });
    server.responses(stream([fcItem("read_skill", { name: "tdd" }, "c1")]), stream([msgItem("done")]));
    const { result } = await run(adapter(), { ...task(), retainedSkills: ["tdd", "gone"] });
    expect(result).toMatchObject({ ok: true, reply: "done" });
    const bodies = server.requests.filter((r) => r.url === "/v1/responses").map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(String(bodies[0]!.instructions)).toContain(`# 已载入的 Skills\n`);
    expect(String(bodies[0]!.instructions)).toContain(`<skill_content name="tdd" revision="${COMMIT}">\n# TDD\n\n</skill_content>`);
    const output = (bodies[1]!.input as { type: string; output?: string }[]).find((i) => i.type === "function_call_output")!.output!;
    expect(output).toBe("Skill tdd 的这一部分已经载入，见前文。");
    expect(hubSeen).toEqual([]);
  });

  test("the task waits for an activation report, but not past 5 seconds, and a failed one is a warning", async () => {
    login();
    saveConfig(home, { model: "gpt-configured" });
    const { managedSkill, skillText } = await import("../skills/helpers.js");
    managedSkill(home, "tdd", { "SKILL.md": skillText("tdd") });
    hubSkillReply = { delayMs: 300, status: 204 };
    server.responses(stream([fcItem("read_skill", { name: "tdd" }, "c1")]), stream([msgItem("done")]));
    const started = Date.now();
    const slow = await run();
    expect(slow.result).toMatchObject({ ok: true, reply: "done" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(slow.events.filter((e) => e.type === "progress").map((e) => e.text)).not.toContain("Skill 激活记录未能及时上报");

    hubSkillReply = { delayMs: 0, status: 500 };
    server.responses(stream([fcItem("read_skill", { name: "tdd" }, "c1")]), stream([msgItem("done")]));
    const failed = await run();
    expect(failed.result).toMatchObject({ ok: true, reply: "done" });
    expect(failed.events).toContainEqual({ type: "progress", text: "1 条 Skill 激活记录上报失败" });
  });

  test("a task that fails after reading a Skill still reports the load, so its thread keeps the Skill", async () => {
    login();
    saveConfig(home, { model: "gpt-configured" });
    const { managedSkill, skillText, COMMIT } = await import("../skills/helpers.js");
    managedSkill(home, "tdd", { "SKILL.md": skillText("tdd") });
    // The Skill is read, then the next model call breaks the connection.
    server.responses(stream([fcItem("read_skill", { name: "tdd" }, "c1")]), reset);
    const { result } = await run();
    expect(result.ok).toBe(false);
    expect(hubSeen.map((h) => `${h.method} ${h.url} ${h.body}`)).toEqual([`POST /room/skills/activated {"skillId":"tdd","revision":"${COMMIT}"}`]);
  });

  test("a task stopped by its owner still reports what it read: the report outlives the run's abort", async () => {
    login();
    saveConfig(home, { model: "gpt-configured" });
    const { managedSkill, skillText, COMMIT } = await import("../skills/helpers.js");
    managedSkill(home, "tdd", { "SKILL.md": skillText("tdd") });
    // The hub takes 400 ms to answer the report; the second model call never answers, so only the stop ends it.
    hubSkillReply = { delayMs: 400, status: 204 };
    server.responses(stream([fcItem("read_skill", { name: "tdd" }, "c1")]), () => {});
    const owner = new AbortController();
    const pending = run(adapter(), task(), owner.signal);
    await vi.waitFor(() => expect(hubSeen.length).toBeGreaterThan(0), { timeout: 5000 });
    // The request is in flight when the stop arrives. A report tied to the run's signal would be cancelled
    // here and the task would end at once; this one waits for the hub, so it still reaches it.
    owner.abort(new Error("stopped by the user"));
    const stoppedAt = Date.now();
    const { result } = await pending;
    expect(result.ok).toBe(false);
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(250);
    expect(hubSeen.map((h) => h.body)).toEqual([JSON.stringify({ skillId: "tdd", revision: COMMIT })]);
  });

  test("without Skills the prompt and tools are unchanged and read_skill is unknown", async () => {
    login();
    saveConfig(home, { model: "gpt-configured" });
    server.responses(stream([fcItem("read_skill", { name: "tdd" }, "c1")]), stream([msgItem("done")]));
    const { result } = await run();
    expect(result).toMatchObject({ ok: true, reply: "done" });
    const bodies = server.requests.filter((r) => r.url === "/v1/responses").map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(bodies[0]!.instructions).toBe("HUB PROMPT: 规则与上下文");
    const output = (bodies[1]!.input as { type: string; output?: string }[]).find((i) => i.type === "function_call_output")!.output!;
    expect(output).toContain("未知函数");
  });

  test("config.model wins over the model list", async () => {
    login();
    saveConfig(home, { model: "gpt-configured", reasoningEffort: "high" });
    server.responses(stream([msgItem("ok")]));
    const { result } = await run();
    expect(result).toMatchObject({ ok: true, reply: "ok" });
    expect(server.requests.some((r) => r.url === "/v1/models")).toBe(false);
    const body = JSON.parse(server.requests[0]!.body) as { model: string; reasoning: { effort: string } };
    expect(body.model).toBe("gpt-configured");
    expect(body.reasoning.effort).toBe("high");
  });

  test("model list unavailable or empty -> gpt-5.5", async () => {
    login();
    server.models(json(400, { error: { code: "bad", message: "nope" } }));
    server.responses(stream([msgItem("ok")]));
    expect((await run()).result).toMatchObject({ ok: true, reply: "ok" });
    server.models(models());
    server.responses(stream([msgItem("ok")]));
    expect((await run()).result).toMatchObject({ ok: true, reply: "ok" });
    const used = server.requests.filter((r) => r.url === "/v1/responses").map((r) => (JSON.parse(r.body) as { model: string }).model);
    expect(used).toEqual(["gpt-5.5", "gpt-5.5"]);
  });

  test("quota exhausted with a reset time -> local time in the message", async () => {
    login();
    saveConfig(home, { model: "m" });
    const resetsAt = new Date(2026, 9, 24, 7, 5).getTime();
    server.responses(json(429, { error: { code: "usage_limit_reached", message: "limit", resets_at: Math.floor(resetsAt / 1000) } }));
    expect((await run()).result).toMatchObject({ ok: false, error: "订阅额度已用完，预计 2026-10-24 07:05 恢复" });
  });

  test("quota exhausted without a reset time", async () => {
    login();
    saveConfig(home, { model: "m" });
    server.responses(json(429, { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } }));
    expect((await run()).result).toMatchObject({ ok: false, error: "订阅额度已用完" });
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
      expect((await run()).result, code).toMatchObject({ ok: false, error: text });
    }
  });

  test("an untrusted credential file is reported as unusable, not as not logged in", async () => {
    login();
    makePublic(join(home, "auth.json"));
    expect((await run()).result).toMatchObject({ ok: false, error: "凭证文件不可用（权限/符号链接/损坏），请重新运行 nema auth login" });
  });

  test("an upsert succeeds, then the next stream fails with a quota code: Chinese quota message, exactly one hub write, no rollback", async () => {
    login();
    saveConfig(home, { model: "m" });
    server.responses(
      stream([fcItem("upsert_entry", { kind: "requirement", title: "t", body: "b", reason: "r", sourceMessages: ["m1"] }, "c1")]),
      sse([{ type: "response.failed", response: { status: "failed", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }]),
    );
    const { result } = await run();
    expect(result).toMatchObject({ ok: false, error: "订阅额度已用完" });
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
    expect(result).toMatchObject({ ok: false, error: "Codex 直连运行超时" });
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
    expect((await run()).result).toMatchObject({ ok: false, error: "Agent 多次请求未提供的工具，已中止" });
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
    expect(result).toMatchObject({ ok: false, error: "Agent 超出单次运行上限（模型调用 3 次）" });
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
    expect(result).toMatchObject({ ok: false, error: "Codex 直连运行超时" });
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
    writePrivateFile(authPath, JSON.stringify({ tokens: { access_token: access, refresh_token: "rt-do-not-spend" } }));
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
    expect(result).toMatchObject({ ok: true, reply: "ok" });
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

    expect(result).toMatchObject({ ok: true, reply: "ok" });
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
      expect((await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", refresher }))).result).toMatchObject({
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

    expect(result).toMatchObject({ ok: false, error: "API key 被拒绝，请在终端运行 nema auth byok" });
    expect((result as { error: string }).error).not.toContain("sekret-key");
    expect(server.requests).toHaveLength(1);
    expect(readFileSync(authPath)).toEqual(before);
    expect(loadConfig(home).authMode).toBe("byok");
  });

  test("byok with a hand-written multi-line key fails before any request and hides the key", async () => {
    saveConfig(home, { authMode: "byok", model: "gpt-z", byokBaseUrl: server.baseUrl });
    writeFileSync(byokKeyPath(home), "sekret-a\nsekret-b", { mode: 0o600 });

    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", refresher }));

    expect(result).toMatchObject({ ok: false, error: "BYOK key 文件内容无效。请重新把钥匙从标准输入交给 nema auth byok。" });
    expect(server.requests).toEqual([]);
  });

  test("siwc without a login does not read the BYOK key", async () => {
    saveByokKey(home, "sekret-key");
    makePublic(byokKeyPath(home));

    expect((await run()).result).toMatchObject({ ok: false, error: "未登录直连 Codex，请在终端运行 nema auth login" });
    expect(server.requests).toEqual([]);
  });
});

describe("CodexDirectAdapter attachments", () => {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
  const pdf = Buffer.from("%PDF-1.7\nSECRET-PDF-BYTES\n");
  const log = Buffer.from("SECRET-LOG-LINE\n");
  function serve(id: string, kind: AttachmentRef["kind"], mime: string, name: string, body: Buffer): AttachmentRef {
    hubFiles.set(id, { status: 200, type: mime, body });
    return { id, kind, mime, name, size: body.length, sha256: sha(body), messageId: "m1" };
  }
  const withAttachments = (attachments: AttachmentRef[]): TaskAssign => ({ ...task(), attachments });
  type Part = { type: string; text?: string; image_url?: string; filename?: string; file_data?: string };
  const firstUser = (body: Record<string, unknown>) => (body.input as Array<{ role?: string; content: Part[] }>)[0]!;

  test("image, PDF and text go into the user message on every call, never into instructions", async () => {
    login();
    server.models(models("gpt-first"));
    server.responses(stream([fcItem("list_entries", {}, "c1")]), stream([msgItem("看过了")]));
    const refs = [serve("img", "image", "image/png", "shot.png", png), serve("doc", "pdf", "application/pdf", "spec.pdf", pdf), serve("log", "text", "text/plain", "boot.log", log)];
    const { result } = await run(adapter(), withAttachments(refs));
    expect(result).toMatchObject({ ok: true, reply: "看过了" });

    expect(hubSeen.filter((h) => h.url?.startsWith("/room/attachments/")).map((h) => `${h.url} ${h.auth}`)).toEqual([
      "/room/attachments/img Bearer run-tok", "/room/attachments/doc Bearer run-tok", "/room/attachments/log Bearer run-tok",
    ]);
    const bodies = server.requests.filter((r) => r.url === "/v1/responses").map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.instructions).toBe("HUB PROMPT: 规则与上下文");
      const user = firstUser(body);
      expect(user.role).toBe("user");
      const parts = user.content;
      expect(parts.map((p) => p.type)).toEqual(["input_text", "input_text", "input_text", "input_image", "input_text", "input_file", "input_text"]);
      expect(parts[1]).toEqual({ type: "input_text", text: attachmentPreamble() });
      expect(parts[2]).toEqual({ type: "input_text", text: `附件信息：${JSON.stringify({ name: "shot.png", type: "image/png", sha256: refs[0]!.sha256, size: refs[0]!.size })}` });
      expect(parts[3]).toEqual({ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` });
      expect(parts[4]).toEqual({ type: "input_text", text: `附件信息：${JSON.stringify({ name: "spec.pdf", type: "application/pdf", sha256: refs[1]!.sha256, size: refs[1]!.size })}` });
      expect(parts[5]).toEqual({ type: "input_file", filename: "spec.pdf", file_data: `data:application/pdf;base64,${pdf.toString("base64")}` });
      expect(parts[6]!.text).toContain("SECRET-LOG-LINE");
      const boundary = /NEMA-ATTACHMENT-[0-9a-f]{32}/.exec(parts[6]!.text!)![0];
      const instructions = String(body.instructions);
      for (const leaked of ["SECRET-LOG-LINE", boundary, png.toString("base64"), pdf.toString("base64"), "shot.png", "spec.pdf"]) {
        expect(instructions).not.toContain(leaked);
      }
    }
  });

  const byok = () => {
    saveConfig(home, { authMode: "byok", model: "m", byokBaseUrl: server.baseUrl });
    saveByokKey(home, "sekret-key");
  };

  test("a BYOK endpoint Nema knows nothing about still gets images and PDFs in their native form", async () => {
    byok();
    server.responses(stream([msgItem("看过了")]));
    const refs = [serve("img", "image", "image/png", "shot.png", png), serve("doc", "pdf", "application/pdf", "spec.pdf", pdf)];
    const { result } = await run(adapter(), withAttachments(refs));
    expect(result).toMatchObject({ ok: true, reply: "看过了" });
    const body = JSON.parse(server.requests.find((r) => r.url === "/v1/responses")!.body) as Record<string, unknown>;
    const parts = firstUser(body).content;
    expect(parts.find((p) => p.type === "input_image")).toEqual({ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` });
    expect(parts.find((p) => p.type === "input_file")).toEqual({ type: "input_file", filename: "spec.pdf", file_data: `data:application/pdf;base64,${pdf.toString("base64")}` });
  });

  test("a provider 4xx about the file says the provider or model rejected the PDF, quotes it, and is not retried", async () => {
    byok();
    server.responses(json(400, { error: { code: "invalid_request_error", message: "File input is not supported for this model.", param: "input[0].content[3]" } }));
    const { result } = await run(adapter(), withAttachments([serve("doc", "pdf", "application/pdf", "spec.pdf", pdf)]));
    expect(result.ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain("你的提供商或模型拒绝了这份 PDF");
    expect(error).toContain("spec.pdf");
    expect(error).toContain("File input is not supported for this model.");
    expect(error).not.toContain("Nema 不支持");
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(1);
  });

  test("a provider pointing at one of two attachments names only that one", async () => {
    byok();
    // input[0].content = [user text, preamble, label, image, label, pdf]
    server.responses(json(400, { error: { message: "Invalid value", param: "input[0].content[5]" } }));
    const refs = [serve("img", "image", "image/png", "shot.png", png), serve("doc", "pdf", "application/pdf", "spec.pdf", pdf)];
    const { result } = await run(adapter(), withAttachments(refs));
    const error = (result as { error: string }).error;
    expect(error).toContain("你的提供商或模型拒绝了这份 PDF（「spec.pdf」）");
    expect(error).not.toContain("shot.png");
  });

  test("an image the provider rejects is named as an image", async () => {
    byok();
    server.responses(json(400, { error: { message: "This model does not support image input" } }));
    const { result } = await run(adapter(), withAttachments([serve("img", "image", "image/png", "shot.png", png)]));
    expect((result as { error: string }).error).toContain("你的提供商或模型拒绝了这张图片");
    expect((result as { error: string }).error).toContain("This model does not support image input");
  });

  test("a 4xx that does not point at the file is shown as the provider said it", async () => {
    byok();
    server.responses(json(404, { error: { message: "No such model: m" } }));
    const { result } = await run(adapter(), withAttachments([serve("doc", "pdf", "application/pdf", "spec.pdf", pdf)]));
    expect((result as { error: string }).error).toMatch(/^模型接口错误：HTTP 404.*No such model: m/);
  });

  test("without attachments a file-sounding 4xx is not translated", async () => {
    byok();
    server.responses(json(400, { error: { message: "File input is not supported for this model." } }));
    const { result } = await run();
    expect((result as { error: string }).error).toMatch(/^模型接口错误：.*File input is not supported/);
  });

  test("an oversized first request is never sent", async () => {
    login();
    server.models(models("gpt-first"));
    server.responses(stream([msgItem("should-not-run")]));
    const { result } = await run(adapter({ maxRequestBytes: 1000 }), withAttachments([serve("log", "text", "text/plain", "boot.log", Buffer.alloc(4000, 0x61))]));
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, error: REQUEST_TOO_LARGE_MESSAGE });
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toEqual([]);
  });

  test("a second request that grows over the cap after a tool call is not sent", async () => {
    login();
    const refs = () => [serve("log", "text", "text/plain", "boot.log", Buffer.alloc(2000, 0x61))];
    // Measure the first request under a generous cap.
    server.models(models("gpt-first"));
    server.responses(stream([msgItem("ok")]));
    await run(adapter({ maxRequestBytes: 1_000_000 }), withAttachments(refs()));
    const first = Buffer.byteLength(server.requests.find((r) => r.url === "/v1/responses")!.body);
    server.requests.length = 0;

    server.models(models("gpt-first"));
    server.responses(stream([fcItem("list_entries", {}, "c1")]), stream([msgItem("should-not-run")]));
    const { result } = await run(adapter({ maxRequestBytes: first + 10 }), withAttachments(refs()));
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, error: REQUEST_TOO_LARGE_MESSAGE });
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(1);
  });
  test("a text attachment that is not UTF-8 fails with its name and no model request", async () => {
    login();
    server.models(models("gpt-first"));
    server.responses(stream([msgItem("should-not-run")]));
    const { result } = await run(adapter(), withAttachments([serve("bad", "text", "text/plain", "bad.txt", Buffer.from([0x61, 0xc3, 0x28]))]));
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("bad.txt");
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toEqual([]);
  });

  test("a stalled attachment download ends with the run timeout", async () => {
    login();
    const ref = serve("img", "image", "image/png", "slow.png", png);
    hubFiles.set("img", { status: 200, type: "image/png", body: png, stall: true });
    const { result } = await run(adapter({ timeoutMs: 200 }), withAttachments([ref]));
    expect(result).toMatchObject({ ok: false, error: "Codex 直连运行超时" });
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toEqual([]);
  });
});

describe("routing a task to the account the user chose", () => {
  // Two BYOK accounts, each with its own key and its own endpoint. The acceptance criterion for S3 is that a
  // task naming B really reaches B's endpoint with B's key.
  const acctB = { id: "acct_bbbbbbbbbb", name: "Second", enabled: true, adapter: "codex-direct" as const, authMode: "byok" as const, baseUrl: "https://second.example.test/v1", model: "model-b", costTier: "standard" as const, order: 1, createdAt: "2026-10-31T00:00:00.000Z" };
  const acctA = { id: "acct_aaaaaaaaaa", name: "First", enabled: true, adapter: "codex-direct" as const, authMode: "byok" as const, baseUrl: "https://first.example.test/v1", model: "model-a", costTier: "standard" as const, order: 0, createdAt: "2026-10-31T00:00:00.000Z" };

  function writeAccounts(accounts: unknown[], bindings: Record<string, string> = {}) {
    writePrivateFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts, bindings }, null, 2) + "\n");
    // config.json describes the default account (D-6): its adapter, auth mode, model and endpoint are a
    // projection written when the default changes. A machine whose default account is a BYOK one says so
    // there, and the read applies that projection, so the fixture states it too.
    saveConfig(home, { authMode: "byok", model: "model-a", byokBaseUrl: "https://first.example.test/v1" });
  }
  function writeKey(id: string, value: string) {
    const dir = join(home, "secrets", "accounts", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivateFile(join(dir, "key"), value);
  }
  const byokProfile = () => ({ ...SIWC_PROFILE, baseUrl: server.baseUrl });

  test("a task naming account B sends B's key to B's endpoint, not A's", async () => {
    writeAccounts([acctA, acctB]);
    writeKey(acctA.id, "key-of-a");
    writeKey(acctB.id, "key-of-b");
    server.responses(stream([msgItem("from b")]));
    const a = new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: byokProfile(), refresher });
    const { result } = await run(a, { ...task(), accountId: acctB.id });
    expect(result).toMatchObject({ ok: true, reply: "from b" });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.headers.authorization).toBe("Bearer key-of-b");
    expect((JSON.parse(server.requests[0]!.body) as { model: string }).model).toBe("model-b");
    // The route record names the account and model that actually answered.
    expect((result as { route?: unknown }).route).toEqual({
      accountId: acctB.id, accountName: "Second", model: "model-b", mode: "manual", reason: "user_message",
    });
  });

  test("no choice anywhere sends the default account's key", async () => {
    writeAccounts([acctA, acctB]);
    writeKey(acctA.id, "key-of-a");
    writeKey(acctB.id, "key-of-b");
    server.responses(stream([msgItem("from a")]));
    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: byokProfile(), refresher }));
    expect((result as { route?: { accountId?: string; reason?: string } }).route).toMatchObject({ accountId: acctA.id, reason: "default" });
    expect(server.requests[0]!.headers.authorization).toBe("Bearer key-of-a");
  });

  test("a workspace binding is used when the message names nothing", async () => {
    writeAccounts([acctA, acctB], { "ws:w1": acctB.id });
    writeKey(acctA.id, "key-of-a");
    writeKey(acctB.id, "key-of-b");
    server.responses(stream([msgItem("ok")]));
    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: byokProfile(), refresher }));
    expect((result as { route?: unknown }).route).toMatchObject({ accountId: acctB.id, reason: "user_workspace" });
    expect(server.requests[0]!.headers.authorization).toBe("Bearer key-of-b");
  });

  test("a thread binding beats the workspace binding", async () => {
    writeAccounts([acctA, acctB], { "ws:w1": acctA.id, "thread:m_t": acctB.id });
    writeKey(acctA.id, "key-of-a");
    writeKey(acctB.id, "key-of-b");
    server.responses(stream([msgItem("ok")]));
    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: byokProfile(), refresher }), { ...task(), threadId: "m_t" });
    expect((result as { route?: unknown }).route).toMatchObject({ accountId: acctB.id, reason: "user_thread" });
  });

  test("a named account with no credential fails and sends nothing at all", async () => {
    writeAccounts([acctA, acctB]);
    writeKey(acctA.id, "key-of-a");
    // B has no key file: the task must fail here, naming B, rather than reaching a provider with A's key.
    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: byokProfile(), refresher }), { ...task(), accountId: acctB.id });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("Second");
    expect(server.requests).toEqual([]);
  });

  test("a named account id this machine does not have fails and sends nothing", async () => {
    writeAccounts([acctA]);
    writeKey(acctA.id, "key-of-a");
    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: byokProfile(), refresher }), { ...task(), accountId: "acct_zzzzzzzzzz" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("不存在");
    expect(server.requests).toEqual([]);
  });

  test("a request for automatic routing fails and sends nothing while the switch is off", async () => {
    // The switch is off here (this fixture never sets it), so the S3 guarantee still holds: a task that asked
    // for failover never quietly runs on one account as if it had been routed.
    writeAccounts([acctA, acctB]);
    writeKey(acctA.id, "key-of-a");
    writeKey(acctB.id, "key-of-b");
    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: byokProfile(), refresher }), { ...task(), routing: "auto" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("自动路由未开启");
    expect(server.requests).toEqual([]);
  });

  test("the route record carries no endpoint and no key", async () => {
    writeAccounts([acctA, acctB]);
    writeKey(acctA.id, "key-of-a");
    server.responses(stream([msgItem("ok")]));
    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: byokProfile(), refresher }), { ...task(), accountId: acctA.id });
    const record = JSON.stringify((result as { route?: unknown }).route);
    expect(record).not.toContain("key-of-a");
    expect(record).not.toContain("example.test");
    expect(record).not.toContain("baseUrl");
  });

  test("a failure after routing still reports which account it was", async () => {
    writeAccounts([acctA, acctB]);
    writeKey(acctA.id, "key-of-a");
    writeKey(acctB.id, "key-of-b");
    server.responses(json(429, { error: { code: "usage_limit_reached", message: "limit" } }));
    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: byokProfile(), refresher }), { ...task(), accountId: acctB.id });
    expect(result).toMatchObject({ ok: false, error: "订阅额度已用完" });
    expect((result as { route?: unknown }).route).toMatchObject({ accountId: acctB.id, accountName: "Second" });
  });

  test("a login that cannot refresh fails before any request, and names no model it never sent", async () => {
    // The account's login is present and parses, so routing accepts it; using it is what fails, when the
    // expiring access token has to be refreshed and the refresh is refused. No model was ever chosen or
    // sent, so the record must not claim one: an earlier version put the fallback model ("gpt-5.5") here,
    // and the hub printed it in the failure line as the model that failed.
    new AuthStore(home, refresher).save(auth({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }), refresh_token: "rt-0" }));
    const { result } = await run();
    expect(result).toMatchObject({ ok: false });
    expect(server.requests).toEqual([]);
    const route = (result as { route?: { model?: string; accountName?: string } }).route;
    expect(route).toBeDefined();
    expect(route!.model).not.toBe("gpt-5.5");
    // This account names no model of its own, so the record says the run-time choice was never resolved.
    expect(route!.model).toBe("auto");
  });
});

describe("two accounts, two real endpoints (S3 acceptance)", () => {
  test("choosing B in the workspace sends the request to B's baseUrl with B's key, and to nothing else", async () => {
    const other = await startFakeResponsesServer();
    try {
      const a = { id: "acct_aaaaaaaaaa", name: "First", enabled: true, adapter: "codex-direct", authMode: "byok", baseUrl: server.baseUrl, model: "model-a", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z" };
      const b = { id: "acct_bbbbbbbbbb", name: "Second", enabled: true, adapter: "codex-direct", authMode: "byok", baseUrl: other.baseUrl, model: "model-b", costTier: "standard", order: 1, createdAt: "2026-10-31T00:00:00.000Z" };
      writePrivateFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [a, b], bindings: { "ws:w1": b.id } }, null, 2) + "\n");
      saveConfig(home, { authMode: "byok", model: "model-a", byokBaseUrl: server.baseUrl });
      for (const [id, key] of [[a.id, "key-of-a"], [b.id, "key-of-b"]] as const) {
        const dir = join(home, "secrets", "accounts", id);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writePrivateFile(join(dir, "key"), key);
      }
      other.responses(stream([msgItem("answered by b")]));

      // No `profile` override: each account's own baseUrl is what the daemon uses in production.
      const adapter = new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", refresher });
      const { result } = await run(adapter, task());

      expect(result).toMatchObject({ ok: true, reply: "answered by b" });
      expect(other.requests).toHaveLength(1);
      expect(server.requests).toHaveLength(0);
      expect(other.requests[0]!.headers.authorization).toBe("Bearer key-of-b");
      expect((JSON.parse(other.requests[0]!.body) as { model: string }).model).toBe("model-b");
      expect((result as { route?: unknown }).route).toMatchObject({ accountId: b.id, accountName: "Second", model: "model-b", reason: "user_workspace" });
    } finally {
      await other.close();
    }
  });
});

describe("a siwc account logs in with its own file", () => {
  test("two siwc accounts with different logins: the named one's token is sent", async () => {
    const first = { id: "acct_aaaaaaaaaa", name: "First", enabled: true, adapter: "codex-direct", authMode: "siwc", model: "model-a", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z" };
    const second = { id: "acct_bbbbbbbbbb", name: "Second", enabled: true, adapter: "codex-direct", authMode: "siwc", model: "model-b", costTier: "standard", order: 1, createdAt: "2026-10-31T00:00:00.000Z" };
    writePrivateFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [first, second], bindings: {} }, null, 2) + "\n");
    saveConfig(home, { authMode: "siwc", model: "model-a" });
    const tokenFirst = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "first" });
    const tokenSecond = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "second" });
    for (const [id, token] of [[first.id, tokenFirst], [second.id, tokenSecond]] as const) {
      const dir = join(home, "secrets", "accounts", id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record = { version: 1, mode: "siwc", clientId: "c", tokens: { access_token: token, refresh_token: "rt" }, lastRefresh: "2026-10-31T00:00:00.000Z" };
      writePrivateFile(join(dir, "auth.json"), JSON.stringify(record, null, 2) + "\n");
    }
    server.responses(stream([msgItem("ok")]));

    const adapter = new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: profile(), refresher });
    await run(adapter, { ...task(), accountId: second.id });

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${tokenSecond}`);
    expect(server.requests[0]!.headers.authorization).not.toBe(`Bearer ${tokenFirst}`);
  });
});

describe("automatic routing (S4)", () => {
  // Two BYOK accounts on two endpoints. Each fake endpoint records the key it was called with, so "did it
  // really move" is answered by the wire rather than by the route record alone.
  const acctA = { id: "acct_aaaaaaaaaa", name: "First", enabled: true, adapter: "codex-direct" as const, authMode: "byok" as const, baseUrl: "https://first.example.test/v1", model: "model-a", costTier: "standard" as const, order: 0, createdAt: "2026-10-31T00:00:00.000Z" };
  const acctB = { id: "acct_bbbbbbbbbb", name: "Second", enabled: true, adapter: "codex-direct" as const, authMode: "byok" as const, baseUrl: "https://second.example.test/v1", model: "model-b", costTier: "standard" as const, order: 1, createdAt: "2026-10-31T00:00:00.000Z" };

  function writeAuto(accounts: unknown[], autoRouting: boolean, bindings: Record<string, string> = {}) {
    writePrivateFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts, bindings, autoRouting }, null, 2) + "\n");
    saveConfig(home, { authMode: "byok", model: "model-a", byokBaseUrl: "https://first.example.test/v1" });
  }
  function writeKey(id: string, value: string) {
    const dir = join(home, "secrets", "accounts", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivateFile(join(dir, "key"), value);
  }
  /** The profile is overridden, so every account's request lands on one fake server; the keys tell them apart. */
  const auto = (extra: { cooldowns?: Cooldowns } = {}) =>
    new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: profile(), refresher, ...extra });

  beforeEach(() => {
    writeAuto([acctA, acctB], true);
    writeKey(acctA.id, "key-of-a");
    writeKey(acctB.id, "key-of-b");
  });

  test("the first account is rate limited: the next model call runs on the second, and the record says so", async () => {
    server.responses(json(429, { error: { code: "rate_limit_exceeded", message: "slow down" } }), stream([msgItem("from b")]));
    const { result } = await run(auto(), { ...task(), routing: "auto" });
    expect(result).toMatchObject({ ok: true, reply: "from b" });

    const calls = server.requests.filter((r) => r.url === "/v1/responses");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers.authorization).toBe("Bearer key-of-a");
    expect(calls[1]!.headers.authorization).toBe("Bearer key-of-b");

    const route = (result as { route?: { mode?: string; reason?: string; accountId?: string; attempts?: unknown[] } }).route!;
    // A limit is its own reason code: it is the case a user most often wants to understand afterwards.
    expect(route).toMatchObject({ mode: "auto", reason: "auto_after_limit", accountId: acctB.id });
    expect(route.attempts).toHaveLength(1);
    expect(route.attempts![0]).toMatchObject({ accountId: acctA.id, accountName: "First", failure: "rate_limit" });
  });

  test("the model of the account that ends up answering is the one that is sent", async () => {
    server.responses(json(429, { error: { code: "rate_limit_exceeded" } }), stream([msgItem("ok")]));
    const { result } = await run(auto(), { ...task(), routing: "auto" });
    const bodies = server.requests.filter((r) => r.url === "/v1/responses").map((r) => JSON.parse(r.body) as { model: string });
    expect(bodies.map((b) => b.model)).toEqual(["model-a", "model-b"]);
    expect((result as { route?: { model?: string } }).route!.model).toBe("model-b");
  });

  test("automatic routing picks the first candidate when nothing fails", async () => {
    server.responses(stream([msgItem("from a")]));
    const { result } = await run(auto(), { ...task(), routing: "auto" });
    expect((result as { route?: { reason?: string; accountId?: string } }).route).toMatchObject({ reason: "auto_primary", accountId: acctA.id, mode: "auto" });
    // No switch happened, so nothing was "tried before this one".
    expect((result as { route?: { attempts?: unknown[] } }).route!.attempts ?? []).toEqual([]);
  });

  test("a 401 does not switch accounts", async () => {
    // This is one key's problem. Moving to the next account would hide the fact that the user has to fix it.
    server.responses(json(401, { error: { code: "invalid_api_key", message: "bad key" } }));
    const { result } = await run(auto(), { ...task(), routing: "auto" });
    expect(result).toMatchObject({ ok: false });
    // The transport already retries a 401 once after forcing a token refresh; that is unchanged, and it is not
    // a failover. What matters is that no request ever reached the server carrying the second account's key.
    const keys = server.requests.filter((r) => r.url === "/v1/responses").map((r) => r.headers.authorization);
    expect(keys.every((k) => k === "Bearer key-of-a")).toBe(true);
    expect(keys).not.toContain("Bearer key-of-b");
    // The failure still names the account that failed.
    expect((result as { route?: { accountId?: string } }).route).toMatchObject({ accountId: acctA.id });
  });

  test("a content-policy refusal does not switch accounts", async () => {
    server.responses(json(403, { error: { code: "content_policy_violation", message: "no" } }));
    const { result } = await run(auto(), { ...task(), routing: "auto" });
    expect(result).toMatchObject({ ok: false });
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(1);
  });

  test("once output has started, a later failure does not move the task to another account", async () => {
    // A stream that delivers text and then fails: the user already has half an answer, and a second account
    // would continue it in another model's voice.
    server.responses(sse([
      { type: "response.created", response: { id: "resp" } },
      { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", delta: "half an answer" },
      { type: "response.failed", response: { error: { code: "server_error", message: "boom" } } },
    ]));
    const { result } = await run(auto(), { ...task(), routing: "auto" });
    expect(result).toMatchObject({ ok: false });
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(1);
  });

  test("switching accounts drops the previous account's encrypted reasoning", async () => {
    // The reasoning of a failed attempt is encrypted for that key; replaying it to another account would send
    // bytes the second one cannot decrypt (research §1.3). The second request must carry none of it.
    const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thought about it" }], encrypted_content: "ENCRYPTED-BY-A" };
    const call = (call_id: string) => ({ type: "function_call", id: `fc_${call_id}`, call_id, name: "list_entries", arguments: "{}", status: "completed" });
    // Round 1 on A: reasoning + a tool call, so there is history worth replaying, then the second call on A
    // is rate limited. Round 3 lands on B and must be clean.
    server.responses(
      sse([
        { type: "response.created", response: { id: "r1" } },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        { type: "response.output_item.done", output_index: 1, item: call("c1") },
        { type: "response.completed", response: { id: "r1", status: "completed", output: [reasoning, call("c1")] } },
      ]),
      json(429, { error: { code: "rate_limit_exceeded" } }),
      stream([msgItem("done on b")]),
    );
    const { result } = await run(auto(), { ...task(), routing: "auto" });
    expect(result).toMatchObject({ ok: true, reply: "done on b" });

    const bodies = server.requests.filter((r) => r.url === "/v1/responses").map((r) => JSON.parse(r.body) as { input: { type: string }[] });
    expect(bodies).toHaveLength(3);
    // While still on A, the reasoning is replayed as before.
    expect(bodies[1]!.input.some((i) => i.type === "reasoning")).toBe(true);
    // On B it is gone, and so is anything carrying it.
    expect(bodies[2]!.input.some((i) => i.type === "reasoning")).toBe(false);
    expect(JSON.stringify(bodies[2])).not.toContain("ENCRYPTED-BY-A");
    // The conversation itself survives: the user message and the tool call/output pair are still sent.
    expect(bodies[2]!.input.some((i) => i.type === "message")).toBe(true);
    expect(bodies[2]!.input.filter((i) => i.type === "function_call_output")).toHaveLength(1);
  });

  test("staying on one account keeps its reasoning, as it did before", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "ENCRYPTED-BY-A" };
    const call = { type: "function_call", id: "fc_1", call_id: "c1", name: "list_entries", arguments: "{}", status: "completed" };
    server.responses(
      sse([
        { type: "response.created", response: { id: "r1" } },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        { type: "response.output_item.done", output_index: 1, item: call },
        { type: "response.completed", response: { id: "r1", status: "completed", output: [reasoning, call] } },
      ]),
      stream([msgItem("done")]),
    );
    const { result } = await run(auto(), { ...task(), routing: "auto" });
    expect(result).toMatchObject({ ok: true });
    const second = JSON.parse(server.requests.filter((r) => r.url === "/v1/responses")[1]!.body) as { input: { type: string }[] };
    expect(second.input.some((i) => i.type === "reasoning")).toBe(true);
  });

  test("a switch is announced as a progress event naming both accounts", async () => {
    server.responses(json(429, { error: { code: "rate_limit_exceeded" } }), stream([msgItem("ok")]));
    const { events } = await run(auto(), { ...task(), routing: "auto" });
    const progress = events.filter((e) => e.type === "progress").map((e) => e.text);
    const announced = progress.find((text) => text.includes("First") && text.includes("Second"));
    expect(announced).toBeDefined();
    // What happened, in the user's terms: the first account was limited and the second one took over.
    expect(announced).toContain("改用");
  });

  test("when every candidate is rate limited the task fails and the attempts are all recorded", async () => {
    server.responses(
      json(429, { error: { code: "rate_limit_exceeded" } }),
      json(429, { error: { code: "rate_limit_exceeded" } }),
    );
    const { result } = await run(auto(), { ...task(), routing: "auto" });
    expect(result).toMatchObject({ ok: false });
    const route = (result as { route?: { attempts?: { accountId: string }[] } }).route!;
    expect(route.attempts!.map((a) => a.accountId)).toEqual([acctA.id, acctB.id]);
    // Both were tried, and the error the user sees is the provider's last one, not a routing sentence.
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(2);
  });

  test("a failed account is left cooling down for the next task", async () => {
    const cooldowns = new Cooldowns();
    server.responses(json(429, { error: { code: "rate_limit_exceeded" } }), stream([msgItem("ok")]));
    await run(auto({ cooldowns }), { ...task(), routing: "auto" });
    expect(cooldowns.until(acctA.id)).not.toBeNull();
    expect(cooldowns.until(acctB.id)).toBeNull();
  });

  test("with the switch on but no account chosen, the task still runs in manual mode on the default", async () => {
    // The switch unlocks the option; it does not make anything automatic on its own (D-3). A task that never
    // asked for automatic routing must keep behaving exactly as it did before this batch.
    server.responses(stream([msgItem("ok")]));
    const { result } = await run(auto(), task());
    expect((result as { route?: { mode?: string; reason?: string } }).route).toMatchObject({ mode: "manual", reason: "default" });
  });

  test("a named account is used even with automatic routing on, and does not move", async () => {
    // A named account is the user's decision; automatic routing must not override it with a failover.
    server.responses(json(429, { error: { code: "rate_limit_exceeded" } }));
    const { result } = await run(auto(), { ...task(), accountId: acctB.id });
    expect(result).toMatchObject({ ok: false });
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(1);
    expect((result as { route?: { mode?: string } }).route).toMatchObject({ mode: "manual" });
  });
});

describe("capability refusal in automatic mode (S4.3)", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
  function serveImage(): AttachmentRef {
    hubFiles.set("img", { status: 200, type: "image/png", body: png });
    return { id: "img", kind: "image", mime: "image/png", name: "shot.png", size: png.length, sha256: createHash("sha256").update(png).digest("hex"), messageId: "m1" };
  }
  const denying = (p: Partial<Account>) => ({
    id: "acct_aaaaaaaaaa", name: "NoImages", enabled: true, adapter: "codex-direct" as const, authMode: "byok" as const,
    baseUrl: "https://first.example.test/v1", model: "model-a", capabilities: { image: false },
    costTier: "standard" as const, order: 0, createdAt: "2026-10-31T00:00:00.000Z", ...p,
  });

  test("an image task with every account denying images fails before any request, naming the ability", async () => {
    const a = denying({ id: "acct_aaaaaaaaaa", name: "NoImages" });
    const b = denying({ id: "acct_bbbbbbbbbb", name: "AlsoNo", order: 1 });
    writePrivateFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [a, b], bindings: {}, autoRouting: true }, null, 2) + "\n");
    saveConfig(home, { authMode: "byok", model: "model-a", byokBaseUrl: "https://first.example.test/v1" });
    for (const id of [a.id, b.id]) {
      const dir = join(home, "secrets", "accounts", id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writePrivateFile(join(dir, "key"), `key-${id}`);
    }
    const assigned = { ...task(), routing: "auto" as const, attachments: [serveImage()] };
    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: profile(), refresher }), assigned);
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("图片");
    // Both were named, so the user knows which declaration to change.
    expect((result as { error: string }).error).toContain("NoImages");
    expect((result as { error: string }).error).toContain("AlsoNo");
    // Nothing was sent, and no attachment was even downloaded: the refusal comes before any work.
    expect(server.requests).toEqual([]);
    expect(hubSeen.filter((h) => h.url?.startsWith("/room/attachments/"))).toEqual([]);
  });

  test("naming that same account sends the image anyway, and the provider's refusal is reported in its own words", async () => {
    // D-4 A's other half. The user named an account that declared no image support; the request goes out, and
    // when the provider rejects the block the run says so with the provider's own text — the same sentence the
    // adapter produced before this batch.
    const a = denying({ id: "acct_aaaaaaaaaa", name: "NoImages" });
    writePrivateFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [a], bindings: {}, autoRouting: true }, null, 2) + "\n");
    saveConfig(home, { authMode: "byok", model: "model-a", byokBaseUrl: "https://first.example.test/v1" });
    const dir = join(home, "secrets", "accounts", a.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivateFile(join(dir, "key"), "key-of-a");
    server.responses(json(400, { error: { message: "This model does not support image input" } }));
    const assigned = { ...task(), accountId: a.id, attachments: [serveImage()] };
    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: profile(), refresher }), assigned);
    expect(result).toMatchObject({ ok: false });
    const error = (result as { error: string }).error;
    // The request did go out, and carried the image.
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(1);
    const body = JSON.parse(server.requests.find((r) => r.url === "/v1/responses")!.body) as { input: { content: { type: string }[] }[] };
    expect(body.input[0]!.content.some((p) => p.type === "input_image")).toBe(true);
    // And the refusal is the same sentence the adapter produced before this batch, not a routing error.
    expect(error).toContain("你的提供商或模型拒绝了这张图片");
    expect(error).toContain("This model does not support image input");
  });

  test("automatic routing picks only among the accounts that declared the ability", async () => {
    const no = denying({ id: "acct_aaaaaaaaaa", name: "NoImages", order: 0 });
    const yes = denying({ id: "acct_bbbbbbbbbb", name: "HasImages", order: 1, capabilities: { image: true } });
    writePrivateFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [no, yes], bindings: {}, autoRouting: true }, null, 2) + "\n");
    saveConfig(home, { authMode: "byok", model: "model-a", byokBaseUrl: "https://first.example.test/v1" });
    for (const id of [no.id, yes.id]) {
      const dir = join(home, "secrets", "accounts", id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writePrivateFile(join(dir, "key"), `key-${id}`);
    }
    server.responses(stream([msgItem("ok")]));
    const assigned = { ...task(), routing: "auto" as const, attachments: [serveImage()] };
    const { result } = await run(new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", profile: profile(), refresher }), assigned);
    expect(result).toMatchObject({ ok: true });
    // The account that said no was never tried, even though it is first in the user's order.
    expect(server.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(1);
    expect(server.requests[0]!.headers.authorization).toBe(`Bearer key-${yes.id}`);
    expect((result as { route?: { accountId?: string } }).route).toMatchObject({ accountId: yes.id });
  });
});
