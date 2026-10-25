import { expectPrivate } from "../nativePermissions.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStore, RefreshError, ReloginRequiredError, type StoredAuth } from "../../src/direct/authStore.js";
import { authLogin } from "../../src/direct/authCommands.js";
import {
  SIWC,
  hostId,
  makeSiwcRefresher,
  nemaUserAgent,
  siwcLogin,
  siwcRefresher,
} from "../../src/direct/siwc.js";

const b64u = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (p: Record<string, unknown>) => `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify(p))}.sig`;

type Recorded = { path: string; headers: IncomingMessage["headers"]; form: URLSearchParams };

/** A fake auth.openai.com token endpoint. `respond` decides the reply for each POST. */
async function fakeTokenServer(
  respond: (form: URLSearchParams, res: ServerResponse) => void,
): Promise<{ url: string; calls: Recorded[]; close: () => Promise<void> }> {
  const calls: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const form = new URLSearchParams(body);
      calls.push({ path: req.url ?? "", headers: req.headers, form });
      respond(form, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/accounts/oauth/token`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-siwc-test-"));
  home = join(root, "nema");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("SIWC constants", () => {
  test("match the documented values", () => {
    expect(SIWC.dynamicClientId).toBe("dynamic_agent_client");
    expect(SIWC.agentNameHint).toBe("Nema Room");
    expect(SIWC.authorizeUrl).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(SIWC.tokenUrl).toBe("https://auth.openai.com/api/accounts/oauth/token");
    expect(SIWC.resource).toBe("https://api.openai.com/v1");
    expect(SIWC.planScopes).toBe("offline_access resource.invoke chatgpt.tokens.use.direct");
    expect(SIWC.callbackPath).toBe("/auth/callback");
    expect(SIWC.defaultPort).toBe(1455);
    expect(SIWC.originator).toBe("nema-room");
  });

  test("user agent identifies as NemaRoom, never codex_cli_rs", () => {
    expect(nemaUserAgent()).toMatch(/^NemaRoom\/\d+\.\d+\.\d+/);
    expect(nemaUserAgent()).not.toContain("codex");
  });
});

describe("hostId", () => {
  test("creates a stable urn:uuid id in <nemaHome>/host-id with mode 0600", () => {
    const a = hostId(home);
    expect(a).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expectPrivate(join(home, "host-id"), 0o600);
    expect(hostId(home)).toBe(a);
  });
});

type LoginHarness = {
  tokenServer: Awaited<ReturnType<typeof fakeTokenServer>>;
  authorizeUrls: URL[];
};

const idToken = (over: Record<string, unknown> = {}) => jwt({ sub: "user-sub-abcd1234", iss: "https://auth.openai.com", ...over });
const accessToken = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, scope: "x" });

async function tokenOk(nonceRef: { nonce?: string; clientId?: string }, extra: Record<string, unknown> = {}) {
  return fakeTokenServer((form, res) => {
    if (form.get("grant_type") !== "authorization_code") return json(res, 400, { error: "unsupported_grant_type" });
    json(res, 200, {
      access_token: accessToken,
      refresh_token: "rt-secret-xyz",
      id_token: idToken({ aud: nonceRef.clientId ?? "oaiapp_issued123", nonce: nonceRef.nonce }),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
      ...extra,
    });
  });
}

/** Simulates the browser: read the authorize URL, then hit the loopback callback with `query(params)`. */
function browser(h: LoginHarness, query: (u: URL) => Record<string, string>) {
  return (url: string) => {
    const u = new URL(url);
    h.authorizeUrls.push(u);
    const cb = new URL(u.searchParams.get("redirect_uri")!);
    for (const [k, v] of Object.entries(query(u))) cb.searchParams.set(k, v);
    setTimeout(() => void fetch(cb).catch(() => {}), 5);
  };
}

describe("siwcLogin", () => {
  let h: LoginHarness;
  const nonceRef: { nonce?: string; clientId?: string } = {};
  afterEach(async () => {
    await h?.tokenServer.close();
    delete nonceRef.nonce;
    delete nonceRef.clientId;
  });

  test("first registration: PKCE S256 + state, saves 0600 auth.json with mode siwc and the issued client id", async () => {
    h = { tokenServer: await tokenOk(nonceRef), authorizeUrls: [] };
    const auth = await siwcLogin({
      nemaHome: home,
      port: 0,
      endpoints: { tokenUrl: h.tokenServer.url },
      openBrowser: browser(h, (u) => {
        nonceRef.nonce = u.searchParams.get("nonce")!;
        return { code: "code-1", state: u.searchParams.get("state")!, client_id: "oaiapp_issued123", scope: "x" };
      }),
    });

    const u = h.authorizeUrls[0]!;
    expect(u.origin + u.pathname).toBe(SIWC.authorizeUrl);
    const p = u.searchParams;
    expect(p.get("client_id")).toBe("dynamic_agent_client");
    expect(p.get("agent_name_hint")).toBe("Nema Room");
    expect(p.get("ext_agent_host_id")).toBe(hostId(home));
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe("openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
    expect(p.get("resource")).toBe("https://api.openai.com/v1");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")!.length).toBeGreaterThanOrEqual(32);
    expect(p.get("nonce")!.length).toBeGreaterThanOrEqual(32);
    expect(p.has("id_token_hint")).toBe(false);
    const redirect = new URL(p.get("redirect_uri")!);
    expect(redirect.protocol).toBe("http:");
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(redirect.pathname).toBe("/auth/callback");

    // token exchange
    expect(h.tokenServer.calls).toHaveLength(1);
    const call = h.tokenServer.calls[0]!;
    const f = call.form;
    expect(f.get("grant_type")).toBe("authorization_code");
    expect(f.get("client_id")).toBe("oaiapp_issued123");
    expect(f.get("code")).toBe("code-1");
    expect(f.get("redirect_uri")).toBe(p.get("redirect_uri"));
    expect(f.get("resource")).toBe("https://api.openai.com/v1");
    expect(f.has("client_secret")).toBe(false);
    const challenge = createHash("sha256").update(f.get("code_verifier")!).digest("base64url");
    expect(challenge).toBe(p.get("code_challenge"));
    expect(call.headers["originator"]).toBe("nema-room");
    expect(call.headers["user-agent"]).toMatch(/^NemaRoom\//);
    expect(call.headers["content-type"]).toContain("application/x-www-form-urlencoded");

    // persisted
    const file = join(home, "auth.json");
    expectPrivate(file, 0o600);
    const saved = JSON.parse(readFileSync(file, "utf8")) as StoredAuth;
    expect(saved).toMatchObject({ version: 1, mode: "siwc", clientId: "oaiapp_issued123", accountId: "user-sub-abcd1234" });
    expect(saved.tokens.refresh_token).toBe("rt-secret-xyz");
    expect(auth.clientId).toBe("oaiapp_issued123");
    expect(new AuthStore(home, siwcRefresher).read()?.clientId).toBe("oaiapp_issued123");
    expect(existsSync(join(home, "auth.lock"))).toBe(false); // lock released
  });

  test("reauthorization reuses the saved issued client id, omits agent_name_hint, and rejects a different callback client id", async () => {
    h = { tokenServer: await tokenOk(nonceRef), authorizeUrls: [] };
    nonceRef.clientId = "oaiapp_saved";
    mkdirSync(home, { recursive: true, mode: 0o700 });
    new AuthStore(home, siwcRefresher).save({
      version: 1, mode: "siwc", clientId: "oaiapp_saved", tokens: { access_token: "", refresh_token: "" }, lastRefresh: "2026-01-01T00:00:00.000Z",
    });
    const ok = await siwcLogin({
      nemaHome: home, port: 0, endpoints: { tokenUrl: h.tokenServer.url },
      openBrowser: browser(h, (u) => {
        nonceRef.nonce = u.searchParams.get("nonce")!;
        return { code: "c", state: u.searchParams.get("state")! }; // callback omits client_id
      }),
    });
    expect(h.authorizeUrls[0]!.searchParams.get("client_id")).toBe("oaiapp_saved");
    expect(h.authorizeUrls[0]!.searchParams.has("agent_name_hint")).toBe(false);
    expect(ok.clientId).toBe("oaiapp_saved");
    expect(h.tokenServer.calls[0]!.form.get("client_id")).toBe("oaiapp_saved");

    await expect(
      siwcLogin({
        nemaHome: home, port: 0, endpoints: { tokenUrl: h.tokenServer.url },
        openBrowser: browser(h, (u) => ({ code: "c", state: u.searchParams.get("state")!, client_id: "oaiapp_other" })),
      }),
    ).rejects.toThrow(/client_id/);
    expect(h.tokenServer.calls).toHaveLength(1);
  });

  test("after an invalid_client failure the saved client id is NOT reused: a new client is registered", async () => {
    h = { tokenServer: await tokenOk(nonceRef), authorizeUrls: [] };
    nonceRef.clientId = "oaiapp_new";
    mkdirSync(home, { recursive: true, mode: 0o700 });
    new AuthStore(home, siwcRefresher).save({
      version: 1, mode: "siwc", clientId: "oaiapp_dead", tokens: { access_token: "", refresh_token: "" }, lastRefresh: "2026-01-01T00:00:00.000Z",
      lastAuthError: { code: "invalid_client", message: "gone", at: "2026-01-02T00:00:00.000Z" },
    });
    const auth = await siwcLogin({
      nemaHome: home, port: 0, endpoints: { tokenUrl: h.tokenServer.url },
      openBrowser: browser(h, (u) => {
        nonceRef.nonce = u.searchParams.get("nonce")!;
        return { code: "c", state: u.searchParams.get("state")!, client_id: "oaiapp_new" };
      }),
    });
    const p = h.authorizeUrls[0]!.searchParams;
    expect(p.get("client_id")).toBe("dynamic_agent_client");
    expect(p.get("agent_name_hint")).toBe("Nema Room");
    expect(auth.clientId).toBe("oaiapp_new");
  });

  test("a state mismatch is rejected and no code is exchanged", async () => {
    h = { tokenServer: await tokenOk(nonceRef), authorizeUrls: [] };
    await expect(
      siwcLogin({
        nemaHome: home, port: 0, endpoints: { tokenUrl: h.tokenServer.url },
        openBrowser: browser(h, () => ({ code: "c", state: "wrong-state", client_id: "oaiapp_x" })),
      }),
    ).rejects.toThrow(/state/);
    expect(h.tokenServer.calls).toHaveLength(0);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });

  test("access_denied stops without exchanging a code", async () => {
    h = { tokenServer: await tokenOk(nonceRef), authorizeUrls: [] };
    await expect(
      siwcLogin({
        nemaHome: home, port: 0, endpoints: { tokenUrl: h.tokenServer.url },
        openBrowser: browser(h, (u) => ({ error: "access_denied", state: u.searchParams.get("state")! })),
      }),
    ).rejects.toThrow(/access_denied/);
    expect(h.tokenServer.calls).toHaveLength(0);
  });

  test("refuses a grant without chatgpt.tokens.use.direct and saves nothing", async () => {
    h = { tokenServer: await tokenOk(nonceRef, { scope: "openid profile email offline_access" }), authorizeUrls: [] };
    await expect(
      siwcLogin({
        nemaHome: home, port: 0, endpoints: { tokenUrl: h.tokenServer.url },
        openBrowser: browser(h, (u) => {
          nonceRef.nonce = u.searchParams.get("nonce")!;
          return { code: "c", state: u.searchParams.get("state")!, client_id: "oaiapp_issued123" };
        }),
      }),
    ).rejects.toThrow(/chatgpt\.tokens\.use\.direct/);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });

  test("rejects an id_token whose nonce does not match", async () => {
    h = { tokenServer: await tokenOk(nonceRef), authorizeUrls: [] };
    nonceRef.nonce = "not-the-nonce";
    await expect(
      siwcLogin({
        nemaHome: home, port: 0, endpoints: { tokenUrl: h.tokenServer.url },
        openBrowser: browser(h, (u) => ({ code: "c", state: u.searchParams.get("state")!, client_id: "oaiapp_issued123" })),
      }),
    ).rejects.toThrow(/nonce/);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });

  test("times out when no callback arrives, and frees the port", async () => {
    h = { tokenServer: await tokenOk(nonceRef), authorizeUrls: [] };
    let redirect = "";
    await expect(
      siwcLogin({
        nemaHome: home, port: 0, timeoutMs: 150, endpoints: { tokenUrl: h.tokenServer.url },
        openBrowser: (url) => { redirect = new URL(url).searchParams.get("redirect_uri")!; },
      }),
    ).rejects.toThrow(/超时|timed out/i);
    await expect(fetch(redirect)).rejects.toThrow();
  });

  test("owner abort closes the callback listener and untrusted production authorize URLs are rejected", async () => {
    h = { tokenServer: await tokenOk(nonceRef), authorizeUrls: [] };
    const controller = new AbortController();
    let redirect: URL | undefined;
    const pending = siwcLogin({
      nemaHome: home, port: 0, timeoutMs: 10_000, signal: controller.signal,
      openBrowser: (url) => { redirect = new URL(new URL(url).searchParams.get("redirect_uri")!); },
    });
    while (!redirect) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    expect(h.tokenServer.calls).toHaveLength(0);
    await expect(fetch(redirect)).rejects.toThrow();

    await expect(siwcLogin({
      nemaHome: home, port: 0, timeoutMs: 100, requireTrustedAuthorizeUrl: true,
      endpoints: { authorizeUrl: "https://evil.example/authorize", tokenUrl: h.tokenServer.url },
      openBrowser: () => { throw new Error("must not reach opener"); },
    })).rejects.toThrow("Untrusted OAuth authorize URL");
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });

  test("desktop login callback page redacts secret-bearing provider exchange errors", async () => {
    const marker = "provider-secret-marker";
    h = { tokenServer: await fakeTokenServer((_form, res) => json(res, 503, { error: "temporarily_unavailable", error_description: marker })), authorizeUrls: [] };
    let callbackPage = "";
    let resolveCallback!: () => void;
    const callbackSeen = new Promise<void>((resolve) => { resolveCallback = resolve; });
    const login = authLogin({
      nemaHome: home, out: { log: () => {}, error: () => {} }, port: 0, timeoutMs: 5000,
      endpoints: { tokenUrl: h.tokenServer.url }, requireTrustedAuthorizeUrl: true, redactCallbackErrors: true,
      openBrowser: (url) => {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorize.searchParams.get("state")!);
        callback.searchParams.set("code", "fake-one-use-code");
        callback.searchParams.set("client_id", "oaiapp_fake");
        void fetch(callback).then(async (response) => {
          callbackPage = await response.text();
          resolveCallback();
        });
      },
    });
    await expect(login).resolves.toBe(1);
    await callbackSeen;
    expect(callbackPage).toContain("Login failed");
    expect(callbackPage).not.toContain(marker);
    expect(h.tokenServer.calls).toHaveLength(1);
    expect(existsSync(join(home, "auth.json"))).toBe(false);

    let callbackErrorPage = "";
    let resolveCallbackError!: () => void;
    const callbackErrorSeen = new Promise<void>((resolve) => { resolveCallbackError = resolve; });
    const callbackErrorLogin = siwcLogin({
      nemaHome: home, port: 0, timeoutMs: 5000, redactCallbackErrors: true,
      openBrowser: (url) => {
        const authorize = new URL(url);
        const callback = new URL(authorize.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authorize.searchParams.get("state")!);
        callback.searchParams.set("error", marker);
        void fetch(callback).then(async (response) => { callbackErrorPage = await response.text(); resolveCallbackError(); });
      },
    });
    await expect(callbackErrorLogin).rejects.toThrow(marker);
    await callbackErrorSeen;
    expect(callbackErrorPage).toContain("Login failed");
    expect(callbackErrorPage).not.toContain(marker);
    expect(h.tokenServer.calls).toHaveLength(1);
  });

  test("the callback listener binds only 127.0.0.1", async () => {
    h = { tokenServer: await tokenOk(nonceRef), authorizeUrls: [] };
    let port = 0;
    const login = siwcLogin({
      nemaHome: home, port: 0, timeoutMs: 2000, endpoints: { tokenUrl: h.tokenServer.url },
      openBrowser: (url) => { port = Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port); },
    });
    login.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(port).toBeGreaterThan(0);
    const tryConnect = (host: string) =>
      new Promise<boolean>((resolve) => {
        const s = connect({ host, port }, () => { s.destroy(); resolve(true); });
        s.on("error", () => resolve(false));
      });
    expect(await tryConnect("127.0.0.1")).toBe(true);
    expect(await tryConnect("::1")).toBe(false);
    const external = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (external) expect(await tryConnect(external.address)).toBe(false);
    await expect(login).rejects.toThrow();
  });

  test("a busy explicit port is reported", async () => {
    h = { tokenServer: await tokenOk(nonceRef), authorizeUrls: [] };
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(
        siwcLogin({ nemaHome: home, port, timeoutMs: 500, endpoints: { tokenUrl: h.tokenServer.url }, openBrowser: () => {} }),
      ).rejects.toThrow(String(port));
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

describe("siwcRefresher", () => {
  const stored = (): StoredAuth => ({
    version: 1, mode: "siwc", clientId: "oaiapp_issued123",
    tokens: { access_token: "old-at", refresh_token: "rt-old", id_token: "idt" }, lastRefresh: "2026-01-01T00:00:00.000Z",
  });

  test("POSTs the documented form to the token endpoint and returns the rotated tokens", async () => {
    const s = await fakeTokenServer((_f, res) => json(res, 200, { access_token: "new-at", refresh_token: "rt-new", id_token: "idt2", expires_in: 3600 }));
    try {
      const r = await makeSiwcRefresher(s.url)(stored());
      expect(r).toEqual({ access_token: "new-at", refresh_token: "rt-new", id_token: "idt2" });
      const f = s.calls[0]!.form;
      expect(Object.fromEntries(f)).toEqual({
        grant_type: "refresh_token", refresh_token: "rt-old", client_id: "oaiapp_issued123", resource: "https://api.openai.com/v1",
      });
      expect(s.calls[0]!.headers["originator"]).toBe("nema-room");
      expect(s.calls[0]!.headers["user-agent"]).toMatch(/^NemaRoom\//);
    } finally {
      await s.close();
    }
  });

  test("documented unusable-refresh-token codes require re-login", async () => {
    for (const code of ["invalid_grant", "invalid_client", "invalid_refresh_token", "token_expired", "refresh_token_reused"]) {
      const s = await fakeTokenServer((_f, res) => json(res, 400, { error: code }));
      try {
        await expect(makeSiwcRefresher(s.url)(stored())).rejects.toBeInstanceOf(ReloginRequiredError);
      } finally {
        await s.close();
      }
    }
  });

  test("other HTTP errors become RefreshError with status, code and Retry-After", async () => {
    const s = await fakeTokenServer((_f, res) => json(res, 429, { error: { code: "rate_limited" } }, { "retry-after": "7" }));
    try {
      const err = await makeSiwcRefresher(s.url)(stored()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RefreshError);
      expect(err).toMatchObject({ status: 429, code: "rate_limited", retryAfterS: 7 });
    } finally {
      await s.close();
    }
  });

  test("passes the AbortSignal to fetch", async () => {
    const s = await fakeTokenServer(() => { /* never answers */ });
    const ac = new AbortController();
    const p = makeSiwcRefresher(s.url)(stored(), ac.signal);
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toThrow();
    await s.close();
  });

  test("a compat-mode login is never refreshed by the SIWC refresher", async () => {
    await expect(siwcRefresher({ ...stored(), mode: "compat" })).rejects.toBeInstanceOf(ReloginRequiredError);
  });
});

