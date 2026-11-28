import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { codedFields, TASK_ERROR, type TaskAssign } from "@nema/shared";
import { z } from "zod";
import { writePrivateFile } from "./nativePermissions.js";
import { configError, configErrorMessage } from "../src/config.js";
import { AuthRateLimitedError, AuthStore, RefreshError, type Refresher, type StoredAuth } from "../src/direct/authStore.js";
import { makeSiwcRefresher } from "../src/direct/siwc.js";
import { CodexFileTokenSource, readCodexCliTokens } from "../src/direct/codexLogin.js";
import { byokKeyPath, readByokKey } from "../src/direct/byok.js";
import { claudeTokenPath, readClaudeToken } from "../src/claude/token.js";
import { readAccountSecret } from "../src/secrets/accounts.js";
import { accountDir } from "../src/accounts/store.js";
import { IMPLICIT_ACCOUNT_ID, type Account } from "../src/accounts/schema.js";
import { loadRoutingAccounts } from "../src/routing/accountSet.js";
import { failureFields } from "../src/routing/messages.js";
import { CodexDirectAdapter } from "../src/direct/adapter.js";
import { ClaudeCodeAdapter } from "../src/claude/adapter.js";
import { DEFAULT_CONFIG } from "../src/config.js";

/*
 * #299 batch 3a: the routing, credential and config errors a task can fail on carry a code and flat params, and
 * the adapters hand them to the daemon's `task.finished`. The text of every error is unchanged.
 */

const posix = process.platform !== "win32";
const b64u = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (p: Record<string, unknown>) => `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify(p))}.sig`;

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-task-codes-"));
  home = join(root, "nema");
  mkdirSync(home, { mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The code and params of whatever `fn` throws (sync or async). */
async function codeOf(fn: () => unknown): Promise<{ code?: string; params?: Record<string, string | number> }> {
  try {
    await fn();
  } catch (e) {
    return failureFields(e);
  }
  throw new Error("expected a throw");
}

describe("config.json", () => {
  test("bad JSON, a schema problem, the BYOK base URL rule and anything else each have a code; the message is unchanged", () => {
    const syntax = new SyntaxError("Unexpected token");
    expect(codedFields(configError(syntax))).toEqual({ code: TASK_ERROR.configInvalidJson, params: { detail: "Unexpected token" } });
    expect(configError(syntax).message).toBe(configErrorMessage(syntax));
    expect(configError(syntax).message).toBe("配置文件 ~/.nema/config.json 无法读取：不是合法的 JSON（Unexpected token）");

    const zod = z.object({ proxyEnv: z.enum(["off", "forward"]) }).safeParse({ proxyEnv: "x" }).error!;
    const coded = codedFields(configError(zod));
    expect(coded.code).toBe(TASK_ERROR.configInvalid);
    expect(String(coded.params?.detail)).toMatch(/^proxyEnv: /);
    expect(String(coded.params?.detail)).not.toMatch(/[一-鿿]/);

    const byok = new Error("byokBaseUrl 只允许 https，或 http://127.0.0.1 与 http://localhost（可带端口）");
    expect(codedFields(configError(byok))).toEqual({ code: TASK_ERROR.configByokBaseUrl });

    expect(codedFields(configError(new Error("EACCES: permission denied")))).toEqual({ code: TASK_ERROR.configUnreadable, params: { detail: "EACCES: permission denied" } });
  });
});

describe("direct login refresh", () => {
  const expired = (): StoredAuth => ({
    version: 1, mode: "siwc", clientId: "oaiapp_test",
    tokens: { access_token: jwt({ exp: 1 }), refresh_token: "rt-1" }, lastRefresh: "2026-10-01T00:00:00.000Z",
  });
  const storeWith = (refresher: Refresher, opts: { refreshTimeoutMs?: number } = {}) => {
    const s = new AuthStore(home, refresher, Date.now, opts);
    s.save(expired());
    return s;
  };

  test("a rate-limited refresh, with and without a stated wait", async () => {
    expect(failureFields(new AuthRateLimitedError(42))).toEqual({ code: TASK_ERROR.authRefreshRateLimitedFor, params: { seconds: 42 } });
    expect(failureFields(new AuthRateLimitedError())).toEqual({ code: TASK_ERROR.authRefreshRateLimited });
    const s = storeWith(async () => { throw new RefreshError(429, { retryAfterS: 7 }); });
    expect(await codeOf(() => s.getAccessToken())).toEqual({ code: TASK_ERROR.authRefreshRateLimitedFor, params: { seconds: 7 } });
  });

  test("a refresh that times out names the seconds", async () => {
    const s = storeWith(() => new Promise(() => {}), { refreshTimeoutMs: 1_000 });
    expect(await codeOf(() => s.getAccessToken())).toEqual({ code: TASK_ERROR.authRefreshTimedOut, params: { seconds: 1 } });
  });

  test("a refresher answer without an access token", async () => {
    const s = storeWith(async () => ({ access_token: "" }));
    expect(await codeOf(() => s.getAccessToken())).toEqual({ code: TASK_ERROR.authRefreshNoAccessToken });
  });

  test("a non-terminal HTTP failure names the status; any other failure carries its own text", async () => {
    const http = storeWith(async () => { throw new RefreshError(502); });
    expect(await codeOf(() => http.getAccessToken())).toEqual({ code: TASK_ERROR.authRefreshHttp, params: { status: 502 } });
    const other = storeWith(async () => { throw new Error("fetch failed"); });
    expect(await codeOf(() => other.getAccessToken())).toEqual({ code: TASK_ERROR.authRefreshFailed, params: { error: "fetch failed" } });
  });

  test("a dead login is the relogin code", async () => {
    const s = storeWith(async () => { throw new RefreshError(401, { code: "invalid_grant" }); });
    expect(await codeOf(() => s.getAccessToken())).toEqual({ code: TASK_ERROR.authReloginRequired });
  });

  describe("the SIWC refresher (audit id 353)", () => {
    let server: Server | undefined;
    afterEach(async () => {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    });

    test("a 200 response without access_token keeps its code through AuthStore's wrapper", async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ refresh_token: "rt-2" }));
      });
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
      const s = storeWith(makeSiwcRefresher(url));
      let thrown: unknown;
      try {
        await s.getAccessToken();
      } catch (e) {
        thrown = e;
      }
      expect((thrown as Error).message).toBe("刷新直连登录失败：刷新响应缺少 access_token");
      expect(failureFields(thrown)).toEqual({ code: TASK_ERROR.authRefreshNoAccessToken });
    });
  });
});

describe("Codex login file", () => {
  const codexHome = () => join(root, "codex");
  const writeAuth = (tokens: Record<string, string>) => {
    mkdirSync(codexHome(), { recursive: true });
    const path = join(codexHome(), "auth.json");
    writePrivateFile(path, JSON.stringify({ tokens }));
    return path;
  };

  test("no tokens, an expired token, bad JSON and a rejected login each have a code naming the file", async () => {
    let path = writeAuth({ access_token: "", refresh_token: "" });
    expect(await codeOf(() => readCodexCliTokens(codexHome()))).toEqual({ code: TASK_ERROR.codexLoginNoTokens, params: { path } });
    path = writeAuth({ access_token: jwt({ exp: 1 }), refresh_token: "rt" });
    expect(await codeOf(() => readCodexCliTokens(codexHome()))).toEqual({ code: TASK_ERROR.codexLoginExpired, params: { path } });
    writePrivateFile(path, "{not json");
    const bad = await codeOf(() => readCodexCliTokens(codexHome()));
    expect(bad.code).toBe(TASK_ERROR.codexLoginUnreadable);
    expect(bad.params?.path).toBe(path);
    expect(typeof bad.params?.error).toBe("string");
    const live = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    writeAuth({ access_token: live, refresh_token: "rt" });
    expect(await codeOf(() => new CodexFileTokenSource(codexHome()).getAccessToken({ rejectedAccessToken: live }))).toEqual({ code: TASK_ERROR.codexLoginRejected });
  });

  test.skipIf(!posix)("a file other users can read, and a symlink", async () => {
    const path = writeAuth({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: "rt" });
    chmodSync(path, 0o644);
    expect(await codeOf(() => readCodexCliTokens(codexHome()))).toEqual({ code: TASK_ERROR.codexLoginNotPrivate, params: { path } });
    chmodSync(path, 0o600);
    const real = join(root, "real.json");
    writePrivateFile(real, "{}");
    rmSync(path);
    symlinkSync(real, path);
    expect(await codeOf(() => readCodexCliTokens(codexHome()))).toEqual({ code: TASK_ERROR.codexLoginSymlink, params: { path } });
  });
});

describe("key and token files", () => {
  test("a missing or invalid BYOK key, Claude token and account credential", async () => {
    expect(await codeOf(() => readByokKey(home))).toEqual({ code: TASK_ERROR.byokKeyMissing });
    writePrivateFile(byokKeyPath(home), "");
    expect(await codeOf(() => readByokKey(home))).toEqual({ code: TASK_ERROR.byokKeyInvalid });
    expect(await codeOf(() => readClaudeToken(home))).toEqual({ code: TASK_ERROR.claudeTokenMissing });
    const id = "acct_abcdefghij";
    expect(await codeOf(() => readAccountSecret(home, id, "key"))).toEqual({ code: TASK_ERROR.accountCredentialMissing });
    mkdirSync(accountDir(home, id), { recursive: true, mode: 0o700 });
    writePrivateFile(join(accountDir(home, id), "key"), "two\nlines");
    expect(await codeOf(() => readAccountSecret(home, id, "key"))).toEqual({ code: TASK_ERROR.accountCredentialInvalid });
  });

  test.skipIf(!posix)("files with wide permissions or behind a symlink", async () => {
    writeFileSync(byokKeyPath(home), "k", { mode: 0o644 });
    chmodSync(byokKeyPath(home), 0o644);
    expect(await codeOf(() => readByokKey(home))).toEqual({ code: TASK_ERROR.byokKeyMode });
    rmSync(byokKeyPath(home));
    symlinkSync(join(root, "elsewhere"), byokKeyPath(home));
    expect(await codeOf(() => readByokKey(home))).toEqual({ code: TASK_ERROR.byokKeySymlink });

    writeFileSync(claudeTokenPath(home), "t", { mode: 0o644 });
    chmodSync(claudeTokenPath(home), 0o644);
    expect(await codeOf(() => readClaudeToken(home))).toEqual({ code: TASK_ERROR.claudeTokenMode });
    rmSync(claudeTokenPath(home));
    symlinkSync(join(root, "elsewhere"), claudeTokenPath(home));
    expect(await codeOf(() => readClaudeToken(home))).toEqual({ code: TASK_ERROR.claudeTokenSymlink });

    const id = "acct_abcdefghij";
    mkdirSync(accountDir(home, id), { recursive: true, mode: 0o700 });
    const key = join(accountDir(home, id), "key");
    writeFileSync(key, "k", { mode: 0o644 });
    chmodSync(key, 0o644);
    expect(await codeOf(() => readAccountSecret(home, id, "key"))).toEqual({ code: TASK_ERROR.secretFileMode, params: { file: "key" } });
    rmSync(key);
    symlinkSync(join(root, "elsewhere"), key);
    expect(await codeOf(() => readAccountSecret(home, id, "key"))).toEqual({ code: TASK_ERROR.secretFileSymlink, params: { file: "key" } });
  });

  test.skipIf(!posix)("an account directory behind a symlink", async () => {
    mkdirSync(join(root, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(root, "elsewhere"), join(home, "secrets"));
    expect(await codeOf(() => accountDir(home, "acct_abcdefghij"))).toEqual({ code: TASK_ERROR.accountsDirSymlink });
  });
});

describe("accounts.json", () => {
  test("an unusable file names the reason", async () => {
    writePrivateFile(join(home, "accounts.json"), "{broken");
    expect(await codeOf(() => loadRoutingAccounts(home, { ...DEFAULT_CONFIG }, join(root, "codex")))).toEqual({
      code: TASK_ERROR.accountsFileUnusable,
      params: { reason: "corrupt" },
    });
  });
});

describe("adapters put the code on the task result", () => {
  const task: TaskAssign = {
    type: "task.assign", taskId: "t1", workspaceId: "w1", adapter: "auto", confidential: false, prompt: "p",
    runToken: "rt", hubUrl: "http://127.0.0.1:9", pluginTools: [],
  };
  const stored: Account = {
    id: "acct_abcdefghij", name: "Work", enabled: true, adapter: "codex-direct", authMode: "byok",
    baseUrl: "https://api.example.test/v1", model: "m", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z",
  };

  test("codex-direct: a route refusal, an unusable account file, and a refresh failure before any request", async () => {
    const refused = await new CodexDirectAdapter({
      nemaHome: home, version: "9.9.9",
      accounts: () => ({ accounts: [stored], bindings: {}, autoRouting: false }),
    }).run(task, () => {});
    expect(refused).toMatchObject({ ok: false, code: TASK_ERROR.routeCredentialMissing, params: { account: "Work" } });
    expect(refused.ok === false && refused.error).toBe("账户「Work」 还没有凭据，请在设置页填写后再运行。");

    writePrivateFile(join(home, "accounts.json"), "{broken");
    expect(await new CodexDirectAdapter({ nemaHome: home, version: "9.9.9" }).run(task, () => {})).toMatchObject({
      ok: false, code: TASK_ERROR.accountsFileUnusable, params: { reason: "corrupt" },
    });
    rmSync(join(home, "accounts.json"));

    const implicit = { ...stored, id: IMPLICIT_ACCOUNT_ID, authMode: "siwc" as const, baseUrl: undefined, model: undefined };
    new AuthStore(home, async () => ({ access_token: "" })).save({
      version: 1, mode: "siwc", clientId: "c", tokens: { access_token: jwt({ exp: 1 }), refresh_token: "rt" }, lastRefresh: "",
    });
    const refresh = await new CodexDirectAdapter({
      nemaHome: home, version: "9.9.9", refresher: async () => ({ access_token: "" }),
      accounts: () => ({ accounts: [implicit], bindings: {}, autoRouting: false }),
    }).run(task, () => {});
    expect(refresh).toMatchObject({ ok: false, code: TASK_ERROR.authRefreshNoAccessToken });
    // The failure still says which account it was.
    expect(refresh.ok === false && refresh.route?.accountId).toBe(IMPLICIT_ACCOUNT_ID);
  });

  test("codex-direct and claude-code: an unreadable config.json", async () => {
    writePrivateFile(join(home, "config.json"), "{broken");
    const direct = await new CodexDirectAdapter({ nemaHome: home, version: "9.9.9" }).run(task, () => {});
    expect(direct).toMatchObject({ ok: false, code: TASK_ERROR.configInvalidJson });
    const claude = await new ClaudeCodeAdapter({ nemaHome: home, cliEntry: "/nonexistent" }).run(task, () => {});
    expect(claude).toMatchObject({ ok: false, code: TASK_ERROR.configInvalidJson });
  });

  test("claude-code: the implicit account's missing token is a route refusal with its 0.2.0 code", async () => {
    const claudeAccount = { ...stored, id: IMPLICIT_ACCOUNT_ID, adapter: "claude-code" as const, authMode: undefined, baseUrl: undefined, model: undefined };
    const r = await new ClaudeCodeAdapter({
      nemaHome: home, cliEntry: "/nonexistent",
      accounts: () => ({ accounts: [claudeAccount], bindings: {}, autoRouting: false }),
    }).run(task, () => {});
    expect(r).toMatchObject({ ok: false, code: TASK_ERROR.claudeTokenMissing });
  });
});
