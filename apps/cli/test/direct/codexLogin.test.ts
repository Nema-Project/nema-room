import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writePrivateFile } from "../nativePermissions.js";
import { CodexFileTokenSource, CodexLoginError, codexAccountHeaders, readCodexCliTokens } from "../../src/direct/codexLogin.js";
import { COMPAT_PROFILE } from "../../src/direct/transport.js";

const b64u = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (p: Record<string, unknown>) => `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify(p))}.sig`;
const CLAIM = "https://api.openai.com/auth";
const future = () => Math.floor(Date.now() / 1000) + 3600;

let root: string;
let codexHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-codex-login-"));
  codexHome = join(root, "codex");
  mkdirSync(codexHome);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeAuth = (tokens: Record<string, string>) => {
  const path = join(codexHome, "auth.json");
  writePrivateFile(path, JSON.stringify({ tokens }));
  return path;
};

describe("readCodexCliTokens", () => {
  test("reads an unexpired Codex login and does not write the file", () => {
    const access = jwt({ exp: future(), [CLAIM]: { chatgpt_account_id: "acct-1234", chatgpt_data_residency: "us" } });
    const path = writeAuth({ access_token: access, refresh_token: "rt-secret" });
    const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs };
    const t = readCodexCliTokens(codexHome);
    expect(t.accessToken).toBe(access);
    expect(t.refreshToken).toBe("rt-secret");
    expect(t.accountId).toBe("acct-1234");
    expect(readFileSync(path)).toEqual(before.bytes);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
  });

  test("a token with no exp is usable (Hermes treats a missing exp as not expired)", () => {
    writeAuth({ access_token: jwt({ sub: "u" }), refresh_token: "rt" });
    expect(readCodexCliTokens(codexHome).exp).toBeNull();
  });

  test("an expired access token is refused", () => {
    writeAuth({ access_token: jwt({ exp: 1 }), refresh_token: "rt" });
    expect(() => readCodexCliTokens(codexHome)).toThrow(CodexLoginError);
    expect(() => readCodexCliTokens(codexHome)).toThrow(/已过期/);
  });

  test("missing tokens and a keyring store are refused", () => {
    writeAuth({});
    expect(() => readCodexCliTokens(codexHome)).toThrow(/access_token/);
    writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    rmSync(join(codexHome, "auth.json"));
    expect(() => readCodexCliTokens(codexHome)).toThrow(/钥匙串/);
  });
});

describe("codexAccountHeaders", () => {
  test("account id and residency come from the access-token claim; a bad token yields no headers", () => {
    const token = jwt({ [CLAIM]: { chatgpt_account_id: "acct-1", chatgpt_compute_residency: "eu" } });
    expect(codexAccountHeaders(token)).toEqual({
      "ChatGPT-Account-ID": "acct-1",
      "x-openai-internal-codex-residency": "eu",
    });
    expect(codexAccountHeaders("not-a-jwt")).toEqual({});
  });
});

describe("CodexFileTokenSource", () => {
  test("re-reads a rotated access token, and a rejected unchanged token is not refreshed", async () => {
    const first = jwt({ exp: future(), [CLAIM]: { chatgpt_account_id: "acct-9" } });
    const path = writeAuth({ access_token: first, refresh_token: "rt" });
    const source = new CodexFileTokenSource(codexHome);
    const got = await source.getAccessToken();
    expect(got.accessToken).toBe(first);
    expect(got.auth.mode).toBe("compat");
    const next = jwt({ exp: future() });
    writePrivateFile(path, JSON.stringify({ tokens: { access_token: next, refresh_token: "rt" } }));
    expect((await source.getAccessToken({ force: true, rejectedAccessToken: first })).accessToken).toBe(next);
    writePrivateFile(path, JSON.stringify({ tokens: { access_token: first, refresh_token: "rt" } }));
    await expect(source.getAccessToken({ force: true, rejectedAccessToken: first })).rejects.toThrow(/不会刷新/);
    expect(readFileSync(path, "utf8")).toContain(first);
  });
});

describe("COMPAT_PROFILE", () => {
  test("hides hidden models and sorts by priority then slug", () => {
    expect(COMPAT_PROFILE.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(COMPAT_PROFILE.modelsPath).toBe("/models?client_version=99.0.0");
    expect(
      COMPAT_PROFILE.parseModels({
        models: [
          { slug: "b", priority: 2 },
          { slug: "hidden-one", visibility: "hide" },
          { slug: "a", priority: 2 },
          { slug: "first", priority: 0 },
          { slug: "last" },
          { slug: "first", priority: 0 },
        ],
      }),
    ).toEqual(["first", "a", "b", "last"]);
  });
});
