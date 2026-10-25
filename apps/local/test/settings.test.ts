import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createSettingsService, isAllowedAuthorizeUrl, type SettingsOperations } from "../src/settings.js";
import { loadConfig, saveConfig } from "@nema/cli/config";
import { byokKeyPath, claudeTokenPath, githubTokenPath, ModelsListError } from "@nema/cli/localSettings";
import { createGatewayCredential, startGateway } from "../src/gateway.js";
import { SessionManager } from "../src/session.js";

const homes: string[] = [];
const gateways: Array<{ close(): Promise<void> }> = [];
const servers: http.Server[] = [];
function tempHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "nema-settings-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function ops(overrides: Partial<SettingsOperations> = {}): SettingsOperations {
  return {
    login: async () => ({ ok: true }),
    logout: async () => {},
    probe: async () => ({ ok: true, modelCount: 2 }),
    saveSecret: () => {},
    ...overrides,
  };
}

describe("authenticated settings backend", () => {
  test("strictly patches existing config fields and clears nullable model/base URL overrides", async () => {
    const home = tempHome();
    const service = createSettingsService({ home, operations: ops() });
    expect(await service.dispatch("PATCH", "/_nema/settings", {
      adapter: "codex-direct", authMode: "byok", reasoningEffort: "high", model: "gpt-custom", byokBaseUrl: "https://api.example/v1/",
    })).toMatchObject({ status: 200, body: { config: { adapter: "codex-direct", authMode: "byok", reasoningEffort: "high", model: "gpt-custom", byokBaseUrl: "https://api.example/v1" } } });
    expect((await service.dispatch("PATCH", "/_nema/settings", { model: null, byokBaseUrl: null })).body).toMatchObject({ config: { adapter: "codex-direct", authMode: "byok", reasoningEffort: "high" } });
    expect(loadConfig(home)).toEqual({ adapter: "codex-direct", authMode: "byok", reasoningEffort: "high" });
    expect((await service.dispatch("PATCH", "/_nema/settings", { extra: true })).status).toBe(400);
    expect((await service.dispatch("PATCH", "/_nema/settings", { byokBaseUrl: "http://example.com" })).status).toBe(400);
  });

  test("returns the saved provider's model catalog and never the provider's error text", async () => {
    const home = tempHome();
    const listed = createSettingsService({ home, operations: ops({ listModels: async () => ["gpt-a", "gpt-b"] }) });
    expect(await listed.dispatch("GET", "/_nema/models", undefined)).toEqual({ status: 200, body: { models: ["gpt-a", "gpt-b"] } });
    const failed = createSettingsService({ home, operations: ops({ listModels: async () => { throw new Error("raw-provider-marker"); } }) });
    const failure = await failed.dispatch("GET", "/_nema/models", undefined);
    expect(failure).toEqual({ status: 200, body: { models: [], unavailable: "list_failed" } });
    expect(JSON.stringify(failure)).not.toContain("raw-provider-marker");
    const claude = createSettingsService({ home, operations: ops({ listModels: async () => { throw new ModelsListError("not_applicable"); } }) });
    expect(await claude.dispatch("GET", "/_nema/models", undefined)).toEqual({ status: 200, body: { models: [], unavailable: "not_applicable" } });
  });

  test("reports each provider login separately and omits secret bytes", async () => {
    const home = tempHome();
    const service = createSettingsService({ home, codexHome: path.join(home, "no-codex") });
    const secret = "provider-secret-not-shared";
    await service.dispatch("POST", "/_nema/auth/secret", { kind: "byok", value: secret });
    const status = await service.dispatch("GET", "/_nema/settings", undefined);
    expect(status.body).toMatchObject({
      auth: { mode: "siwc", credential: "siwc", state: "missing" },
      credentials: { siwc: "missing", byok: "connected", claude: "missing" },
    });
    expect(JSON.stringify(status.body)).not.toContain(secret);
  });

  test("secret writes accept only fixed kinds and never return submitted content", async () => {
    const home = tempHome();
    const saveSecret = vi.fn();
    const service = createSettingsService({ home, operations: ops({ saveSecret }) });
    const secret = "secret-not-for-response";
    expect(await service.dispatch("POST", "/_nema/auth/secret", { kind: "byok", value: secret })).toEqual({ status: 200, body: { saved: true } });
    expect(saveSecret).toHaveBeenCalledWith("byok", secret);
    expect(JSON.stringify(await service.dispatch("GET", "/_nema/settings", undefined))).not.toContain(secret);
    expect((await service.dispatch("POST", "/_nema/auth/secret", { kind: "endpoint", value: secret })).status).toBe(400);
  });

  test("the production secret writer stores to the private app path and the response/status omit the value", async () => {
    const home = tempHome();
    const service = createSettingsService({ home });
    const secret = "temp-byok-secret-only";
    const reply = await service.dispatch("POST", "/_nema/auth/secret", { kind: "byok", value: secret });
    expect(reply).toEqual({ status: 200, body: { saved: true } });
    expect(readFileSync(byokKeyPath(home), "utf8")).toBe(secret);
    expect(JSON.stringify(reply)).not.toContain(secret);
    expect(JSON.stringify(await service.dispatch("GET", "/_nema/settings", undefined))).not.toContain(secret);
    await service.close();
  });

  test("internal helper errors containing a submitted secret become a fixed error code", async () => {
    const home = tempHome();
    const service = createSettingsService({ home, operations: ops({ saveSecret: (_kind, value) => { throw new Error(`filesystem echoed ${value}`); } }) });
    const result = await service.dispatch("POST", "/_nema/auth/secret", { kind: "github", value: "secret-to-drop" });
    expect(result).toEqual({ status: 500, body: { error: "internal_error" } });
    expect(JSON.stringify(result)).not.toContain("secret-to-drop");
  });

  test("selected logout touches one fixed credential kind and compat stays read-only", async () => {
    const home = tempHome();
    const logout = vi.fn();
    const service = createSettingsService({ home, operations: ops({ logout }) });
    expect(await service.dispatch("POST", "/_nema/auth/logout", { kind: "compat" })).toEqual({ status: 200, body: { loggedOut: false, kind: "compat" } });
    expect(logout).toHaveBeenCalledWith("compat");
    expect((await service.dispatch("POST", "/_nema/auth/logout", {})).status).toBe(400);
    expect((await service.dispatch("POST", "/_nema/auth/logout", { kind: "../auth.json" })).status).toBe(400);
  });

  test("logout reserves auth mutations until it settles, then later login and probe can run", async () => {
    const home = tempHome();
    let finishLogout!: () => void;
    const logoutStarted = vi.fn();
    const login = vi.fn(async () => ({ ok: true }));
    const probe = vi.fn(async () => ({ ok: true }));
    const logout = vi.fn(() => new Promise<void>((resolve) => { logoutStarted(); finishLogout = resolve; }));
    const service = createSettingsService({ home, operations: ops({ login, probe, logout }) });

    const pendingLogout = service.dispatch("POST", "/_nema/auth/logout", { kind: "siwc" });
    expect(logoutStarted).toHaveBeenCalledTimes(0);
    await vi.waitFor(() => expect(logoutStarted).toHaveBeenCalledTimes(1));
    expect(await service.dispatch("POST", "/_nema/auth/login", {})).toEqual({ status: 409, body: { error: "mutation_conflict" } });
    expect(await service.dispatch("POST", "/_nema/auth/probe", { confirmQuotaUse: true })).toEqual({ status: 409, body: { error: "mutation_conflict" } });
    expect(login).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();

    finishLogout();
    expect(await pendingLogout).toMatchObject({ status: 200 });
    expect(await service.dispatch("POST", "/_nema/auth/login", {})).toMatchObject({ status: 202 });
    await service.waitForJobs();
    expect(await service.dispatch("POST", "/_nema/auth/probe", { confirmQuotaUse: true })).toMatchObject({ status: 202 });
    await service.waitForJobs();
    expect(login).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    await service.close();
  });

  test("status covers SIWC, explicit Codex compatibility, BYOK, and Claude without revealing credentials", async () => {
    const home = tempHome();
    const codexHome = path.join(home, "codex-fixture");
    mkdirSync(codexHome);
    const codexFile = path.join(codexHome, "auth.json");
    writeFileSync(codexFile, JSON.stringify({ tokens: { access_token: "codex-secret-fixture", refresh_token: "codex-refresh-fixture" } }), { mode: 0o600 });
    const service = createSettingsService({ home, codexHome });
    expect((await service.dispatch("GET", "/_nema/settings", undefined)).body).toMatchObject({ auth: { mode: "siwc", credential: "siwc", state: "missing" } });

    saveConfig(home, { authMode: "compat" });
    const compat = await service.dispatch("GET", "/_nema/settings", undefined);
    expect(compat.body).toMatchObject({ auth: { mode: "compat", state: "connected" } });
    expect(JSON.stringify(compat.body)).not.toContain("codex-secret-fixture");
    expect(readFileSync(codexFile, "utf8")).toContain("codex-refresh-fixture");

    saveConfig(home, { authMode: "byok" });
    writeFileSync(byokKeyPath(home), "byok-secret-fixture", { mode: 0o600 });
    const byok = await service.dispatch("GET", "/_nema/settings", undefined);
    expect(byok.body).toMatchObject({ auth: { mode: "byok", state: "connected" } });
    expect(JSON.stringify(byok.body)).not.toContain("byok-secret-fixture");

    saveConfig(home, { adapter: "claude-code" });
    writeFileSync(claudeTokenPath(home), "claude-secret-fixture", { mode: 0o600 });
    writeFileSync(githubTokenPath(home), "github-secret-fixture", { mode: 0o600 });
    const claude = await service.dispatch("GET", "/_nema/settings", undefined);
    expect(claude.body).toMatchObject({ auth: { mode: "byok", credential: "claude", state: "connected" }, tools: { claude: { tokenSaved: true }, github: { tokenSaved: true } } });
    expect(JSON.stringify(claude.body)).not.toMatch(/(?:claude|github)-secret-fixture/);
  });

  test("production OAuth opener policy rejects foreign, userinfo, and lookalike URLs", () => {
    expect(isAllowedAuthorizeUrl("https://auth.openai.com/api/accounts/authorize?client_id=x")).toBe(true);
    expect(isAllowedAuthorizeUrl("https://user@auth.openai.com/api/accounts/authorize")).toBe(false);
    expect(isAllowedAuthorizeUrl("https://auth.openai.com.evil.example/api/accounts/authorize")).toBe(false);
    expect(isAllowedAuthorizeUrl("https://auth.openai.com/other")).toBe(false);
  });

  test("login is only applicable to SIWC or explicit compat; Claude and BYOK do not start OAuth", async () => {
    const home = tempHome();
    const login = vi.fn(async () => ({ ok: true }));
    const service = createSettingsService({ home, operations: ops({ login }) });
    saveConfig(home, { authMode: "byok" });
    expect(await service.dispatch("POST", "/_nema/auth/login", {})).toEqual({ status: 409, body: { error: "login_not_applicable" } });
    saveConfig(home, { authMode: "siwc", adapter: "claude-code" });
    expect(await service.dispatch("POST", "/_nema/auth/login", {})).toEqual({ status: 409, body: { error: "login_not_applicable" } });
    expect(await service.dispatch("POST", "/_nema/auth/probe", { confirmQuotaUse: true })).toEqual({ status: 409, body: { error: "probe_not_supported" } });
    expect(login).not.toHaveBeenCalled();
  });

  test("login jobs reject duplicates, redact error details, and cancellation drains the operation", async () => {
    const home = tempHome();
    let finish!: () => void;
    let observedSignal: AbortSignal | undefined;
    const login = vi.fn(({ signal }: { signal: AbortSignal }) => {
      observedSignal = signal;
      return new Promise<{ ok: boolean }>((resolve) => { finish = () => resolve({ ok: false }); });
    });
    const service = createSettingsService({ home, operations: ops({ login }) });
    const started = await service.dispatch("POST", "/_nema/auth/login", {});
    expect(started).toMatchObject({ status: 202, body: { state: "running" } });
    expect((await service.dispatch("POST", "/_nema/auth/login", {})).status).toBe(409);
    expect((await service.dispatch("POST", "/_nema/auth/cancel", {})).body).toEqual({ state: "cancelling" });
    expect(observedSignal?.aborted).toBe(true);
    finish();
    await service.waitForJobs();
    expect((await service.dispatch("GET", "/_nema/auth/status", undefined)).body).toEqual({ state: "cancelled", error: null });
  });

  test("probe requires explicit quota-use opt-in and returns only a redacted result", async () => {
    const home = tempHome();
    const probe = vi.fn(async () => { throw new Error("provider echoed secret ABC123"); });
    const service = createSettingsService({ home, operations: ops({ probe }) });
    expect((await service.dispatch("POST", "/_nema/auth/probe", {})).status).toBe(400);
    expect(probe).not.toHaveBeenCalled();
    const response = await service.dispatch("POST", "/_nema/auth/probe", { confirmQuotaUse: true });
    expect(response.status).toBe(202);
    await service.waitForJobs();
    const status = await service.dispatch("GET", "/_nema/auth/status", undefined);
    expect(JSON.stringify(status.body)).not.toContain("ABC123");
    expect(status.body).toEqual({ state: "failed", error: "probe_failed" });
  });

  test("owner shutdown aborts and awaits outstanding settings work", async () => {
    const home = tempHome();
    let release!: () => void;
    const login = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<{ ok: boolean }>((resolve) => {
      signal.addEventListener("abort", () => { release = () => resolve({ ok: false }); }, { once: true });
    }));
    const service = createSettingsService({ home, operations: ops({ login }) });
    await service.dispatch("POST", "/_nema/auth/login", {});
    let drained = false;
    const closing = service.close().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await closing;
    expect(drained).toBe(true);
  });

  test("native gateway requests enforce session, host, origin, JSON limits, and no-store", async () => {
    const home = tempHome();
    const target = http.createServer((_req, res) => res.end("unused"));
    servers.push(target);
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("target didn't bind");
    const targetOrigin = `http://127.0.0.1:${address.port}`;
    const session = new SessionManager();
    const codexHome = path.join(home, "codex-fixture");
    mkdirSync(codexHome);
    const codexAuth = path.join(codexHome, "auth.json");
    const appAuth = path.join(home, "auth.json");
    const paths = [appAuth, codexAuth, byokKeyPath(home), claudeTokenPath(home), githubTokenPath(home)];
    paths.forEach((file, index) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `marker-${index}`); });
    const originalContents = paths.map((file) => readFileSync(file, "utf8"));
    const settings = createSettingsService({ home, codexHome });
    const gateway = await startGateway({ webTarget: targetOrigin, hubTarget: targetOrigin, session, port: 0, privateGatewayCredential: createGatewayCredential(), settings });
    gateways.push(gateway);
    const token = session.consumeTicket(session.issueTicket())!;
    const cookie = `nema_session_${new URL(gateway.origin).port}=${token}`;
    const unauthorized = await fetch(`${gateway.origin}/_nema/settings`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("no-store");
    const response = await fetch(`${gateway.origin}/_nema/settings`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const badOrigin = await fetch(`${gateway.origin}/_nema/settings`, { headers: { cookie, origin: "http://evil.example" } });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers.get("cache-control")).toBe("no-store");
    const hostile = await new Promise<number>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: Number(new URL(gateway.origin).port), path: "/_nema/settings", headers: { cookie, host: "evil.example" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
      req.on("error", reject); req.end();
    });
    expect(hostile).toBe(403);
    const tooLarge = await fetch(`${gateway.origin}/_nema/auth/login`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ payload: "x".repeat(17_000) }) });
    expect(tooLarge.status).toBe(413);
    const arrayLogoutKind = await fetch(`${gateway.origin}/_nema/auth/logout`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ kind: ["siwc"] }) });
    expect(arrayLogoutKind.status).toBe(400);
    const arraySecretKind = await fetch(`${gateway.origin}/_nema/auth/secret`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ kind: ["byok"], value: "must-not-write" }) });
    expect(arraySecretKind.status).toBe(400);
    expect(paths.map((file) => readFileSync(file, "utf8"))).toEqual(originalContents);
    await settings.close();
    session.close();
  });
});
