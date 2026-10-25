import { makePublic } from "../nativePermissions.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authLogin, authLogout, authProbe, authStatus, listConfiguredModels, ModelsListError } from "../../src/direct/authCommands.js";
import { saveConfig } from "../../src/config.js";
import { saveByokKey } from "../../src/direct/byok.js";
import { AuthStore, type StoredAuth } from "../../src/direct/authStore.js";
import { siwcRefresher } from "../../src/direct/siwc.js";

const b64u = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (p: Record<string, unknown>) => `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify(p))}.sig`;

function capture() {
  const lines: string[] = [];
  return { out: { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) }, text: () => lines.join("\n") };
}

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-authcmd-test-"));
  home = join(root, "nema");
  mkdirSync(home, { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const EXP = Math.floor(Date.parse("2026-10-23T10:00:00.000Z") / 1000);
const ACCESS = jwt({ exp: EXP, secret: "access-token-secret-value" });
const REFRESH = "refresh-token-secret-value";
const ID_TOKEN = jwt({ sub: "user-sub-abcd9876", secret: "id-token-secret" });

function saveAuth(extra: Partial<StoredAuth> = {}) {
  new AuthStore(home, siwcRefresher).save({
    version: 1,
    mode: "siwc",
    clientId: "oaiapp_issued123",
    tokens: { access_token: ACCESS, refresh_token: REFRESH, id_token: ID_TOKEN },
    accountId: "user-sub-abcd9876",
    lastRefresh: "2026-10-22T09:00:00.000Z",
    ...extra,
  });
}

describe("nema auth status", () => {
  test("shows mode, account id tail, expiry and last error but never a token", () => {
    saveAuth({ lastAuthError: { code: "http_503", message: "upstream down", at: "2026-10-22T09:30:00.000Z" } });
    const c = capture();
    expect(authStatus({ nemaHome: home, out: c.out })).toBe(0);
    const t = c.text();
    expect(t).toContain("siwc");
    expect(t).toContain("9876");
    expect(t).not.toContain("user-sub-abcd9876");
    expect(t).toContain("2026-10-23T10:00:00.000Z");
    expect(t).toContain("http_503");
    for (const secret of [ACCESS, REFRESH, ID_TOKEN, "access-token-secret-value", "id-token-secret"]) {
      expect(t).not.toContain(secret);
    }
  });

  test("an untrusted credential file is reported as unusable, not as not-logged-in", async () => {
    saveAuth();
    if (process.platform === "win32") {
      const { spawnSync } = await import("node:child_process");
      expect(spawnSync("icacls.exe", [join(home, "auth.json"), "/grant", "*S-1-1-0:R"], { stdio: "ignore" }).status).toBe(0);
    } else makePublic(join(home, "auth.json"));
    const c = capture();
    expect(authStatus({ nemaHome: home, out: c.out })).toBe(1);
    expect(c.text()).toContain("凭证文件不可用（权限/符号链接/损坏），请重新运行 nema auth login");
    expect(c.text()).not.toContain("尚未登录");
  });

  test("reports not logged in", () => {
    const c = capture();
    expect(authStatus({ nemaHome: home, out: c.out })).toBe(1);
    expect(c.text()).toContain("nema auth login");
  });
});

describe("nema auth logout", () => {
  test("deletes auth.json", async () => {
    saveAuth();
    const c = capture();
    expect(await authLogout({ nemaHome: home, out: c.out })).toBe(0);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    expect(await authLogout({ nemaHome: home, out: c.out })).toBe(0); // idempotent
  });
});

describe("nema auth logout lock timeout", () => {
  test("a held auth.lock gives a Chinese message instead of throwing", async () => {
    saveAuth();
    const { withFileLock } = await import("../../src/direct/lock.js");
    let release!: () => void;
    const held = withFileLock(join(home, "auth.lock"), () => new Promise<void>((r) => (release = r)), { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 50));
    const c = capture();
    expect(await authLogout({ nemaHome: home, out: c.out, lockTimeoutMs: 200 })).toBe(1);
    expect(c.text()).toContain("等待凭证锁超时");
    release();
    await held;
  });
});

describe("nema auth logout without a nema home", () => {
  test("succeeds when ~/.nema does not exist", async () => {
    const missing = join(root, "missing-home");
    expect(await authLogout({ nemaHome: missing, out: capture().out })).toBe(0);
    expect(existsSync(missing)).toBe(false);
  });
});

describe("nema auth login", () => {
  test("compat mode confirms the Codex login file and does not open a browser", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ authMode: "compat" }));
    const codexHome = join(root, "codex");
    mkdirSync(codexHome);
    const access = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct-9876" } });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: access, refresh_token: "rt-secret" } }));
    const c = capture();
    let opened = false;
    expect(await authLogin({ nemaHome: home, out: c.out, codexHome, openBrowser: () => { opened = true; } })).toBe(0);
    expect(c.text()).toContain("9876");
    expect(c.text()).not.toContain("rt-secret");
    expect(c.text()).not.toContain(access);
    expect(opened).toBe(false);
  });

  test("siwc prints the authorize URL and reports a failure without throwing", async () => {
    const c = capture();
    let url = "";
    const code = await authLogin({
      nemaHome: home, out: c.out, port: 0, timeoutMs: 100,
      openBrowser: (u) => { url = u; },
    });
    expect(code).toBe(1);
    expect(url).toMatch(/^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/);
    expect(c.text()).toContain(url);
  });
});

type Req = { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string };

async function fakeApi(opts: { failResponses?: boolean; failModels?: boolean } = {}) {
  const reqs: Req[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      reqs.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === "GET" && req.url === "/v1/models") {
        if (opts.failModels) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "upstream-marker-secret" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [
          { slug: "gpt-hidden", display_name: "Hidden", visibility: "hide" },
          { slug: "gpt-a", display_name: "GPT A", visibility: "list" },
          { slug: "gpt-b", display_name: "GPT B", visibility: "list" },
        ] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/responses") {
        if (opts.failResponses) {
          res.writeHead(429, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
        res.write(ev({ type: "response.created" }));
        res.write(ev({ type: "response.output_text.delta", delta: "o" }));
        res.write(ev({ type: "response.output_text.delta", delta: "k" }));
        res.write(ev({ type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } }));
        res.end(ev({ type: "response.completed", response: { model: "gpt-a" } }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { base, reqs, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("nema auth probe", () => {
  test("lists listed models and makes one minimal streaming Responses call", async () => {
    saveAuth({ tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: REFRESH } });
    const api = await fakeApi();
    try {
      const c = capture();
      expect(await authProbe({ nemaHome: home, out: c.out, apiBase: api.base })).toBe(0);
      const t = c.text();
      expect(t).toContain("gpt-a");
      expect(t).toContain("gpt-b");
      expect(t).not.toContain("gpt-hidden");
      expect(t).toMatch(/ok/);
      expect(t).not.toContain(REFRESH);
      const post = api.reqs.find((r) => r.method === "POST")!;
      const body = JSON.parse(post.body) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "gpt-a", store: false, stream: true });
      expect(body.tools).toBeUndefined();
      expect(JSON.stringify(body.input)).toContain("只回复 ok");
      for (const r of api.reqs) {
        expect(r.headers.authorization).toMatch(/^Bearer /);
        expect(r.headers["originator"]).toBe("nema-room");
        expect(r.headers["user-agent"]).toMatch(/^NemaRoom\//);
      }
    } finally {
      await api.close();
    }
  });

  test("uses config.model when it is listed", async () => {
    saveAuth({ tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: REFRESH } });
    writeFileSync(join(home, "config.json"), JSON.stringify({ model: "gpt-b" }));
    const api = await fakeApi();
    try {
      expect(await authProbe({ nemaHome: home, out: capture().out, apiBase: api.base })).toBe(0);
      expect(JSON.parse(api.reqs.find((r) => r.method === "POST")!.body).model).toBe("gpt-b");
    } finally {
      await api.close();
    }
  });

  test("reports the Responses error code and fails", async () => {
    saveAuth({ tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: REFRESH } });
    const api = await fakeApi({ failResponses: true });
    try {
      const c = capture();
      expect(await authProbe({ nemaHome: home, out: c.out, apiBase: api.base })).toBe(1);
      expect(c.text()).toContain("subscription_sharing_usage_limit_exceeded");
      expect(c.text()).toContain("429");
    } finally {
      await api.close();
    }
  });

  test("--force-refresh refreshes through the refresher before probing", async () => {
    saveAuth({ tokens: { access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: REFRESH } });
    const api = await fakeApi();
    let calls = 0;
    const fresh = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, n: 2 });
    try {
      const c = capture();
      const code = await authProbe({
        nemaHome: home, out: c.out, apiBase: api.base, forceRefresh: true,
        refresher: async () => { calls++; return { access_token: fresh, refresh_token: "rt-rotated" }; },
      });
      expect(code).toBe(0);
      expect(calls).toBe(1);
      expect(c.text()).toContain("已强制刷新");
      expect(api.reqs.every((r) => r.headers.authorization === `Bearer ${fresh}`)).toBe(true);
      expect(c.text()).not.toContain("rt-rotated");
    } finally {
      await api.close();
    }
  });

  test("lists models for the saved provider without a generation request", async () => {
    const api = await fakeApi();
    try {
      saveConfig(home, { authMode: "byok", byokBaseUrl: api.base });
      saveByokKey(home, "byok-test-key");
      await expect(listConfiguredModels({ nemaHome: home })).resolves.toEqual(["gpt-a", "gpt-b"]);
      expect(api.reqs.map((request) => request.method)).toEqual(["GET"]);
      expect(api.reqs[0]?.headers.authorization).toBe("Bearer byok-test-key");
    } finally {
      await api.close();
    }
  });

  test("reports a catalog failure without the provider's response text", async () => {
    const api = await fakeApi({ failModels: true });
    try {
      saveConfig(home, { authMode: "byok", byokBaseUrl: api.base });
      saveByokKey(home, "byok-test-key");
      const error = await listConfiguredModels({ nemaHome: home }).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelsListError);
      expect(error).toMatchObject({ reason: "list_failed" });
      expect(String(error)).not.toContain("upstream-marker-secret");
    } finally {
      await api.close();
    }
  });

  test("does not list models before the saved provider is connected", async () => {
    await expect(listConfiguredModels({ nemaHome: home })).rejects.toMatchObject({ reason: "not_connected" });
    saveConfig(home, { adapter: "claude-code" });
    await expect(listConfiguredModels({ nemaHome: home })).rejects.toMatchObject({ reason: "not_applicable" });
  });

  test("without a login it tells the user to log in", async () => {
    const c = capture();
    expect(await authProbe({ nemaHome: home, out: c.out, apiBase: "http://127.0.0.1:9/v1" })).toBe(1);
    expect(c.text()).toContain("nema auth login");
  });
});
