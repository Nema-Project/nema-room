// The synthesized account's own legacy credential, judged read-only for first-run readiness (#302 D-1).
// Temporary homes and fake tokens only: no real ~/.nema, no real login.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { implicitCredentialReadiness, implicitCredentialState } from "../../src/accounts/credentials.js";
import { IMPLICIT_ACCOUNT_ID, type Account } from "../../src/accounts/schema.js";
import { canSymlinkFiles } from "../links.js";
import { makePublic, writePrivateFile } from "../nativePermissions.js";

let root: string;
let home: string;
let codexHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-implicit-readiness-"));
  home = join(root, "nema");
  codexHome = join(root, "codex");
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const base: Account = {
  id: IMPLICIT_ACCOUNT_ID, name: "默认账户", enabled: true, adapter: "codex-direct", authMode: "siwc",
  costTier: "standard", order: 0, createdAt: "2026-11-27T00:00:00.000Z",
};
const siwc = (): Account => ({ ...base });
const byok = (): Account => ({ ...base, authMode: "byok", baseUrl: "https://api.openai.com/v1" });
const compat = (): Account => ({ ...base, authMode: "compat" });
const claude = (): Account => {
  const { authMode: _drop, ...rest } = base;
  return { ...rest, adapter: "claude-code" };
};

const siwcLogin = (over: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, mode: "siwc", clientId: "oaiapp_test",
  tokens: { access_token: "fake-access", refresh_token: "fake-refresh" },
  lastRefresh: "2026-11-01T00:00:00.000Z", ...over,
});

function writeCodexAuth(body: string): void {
  mkdirSync(codexHome, { recursive: true });
  writePrivateFile(join(codexHome, "auth.json"), body);
}
const validCodexLogin = () => JSON.stringify({
  tokens: { access_token: "fake.codex.access.token", refresh_token: "r", account_id: "a" },
  last_refresh: new Date().toISOString(),
});

describe("implicitCredentialReadiness: SIWC", () => {
  test("no auth.json is missing", () => {
    expect(implicitCredentialReadiness(home, siwc(), codexHome)).toBe("missing");
  });
  test("a parsed, refreshable login is connected", () => {
    writePrivateFile(join(home, "auth.json"), siwcLogin());
    expect(implicitCredentialReadiness(home, siwc(), codexHome)).toBe("connected");
  });
  test("an unparseable file is unusable", () => {
    writePrivateFile(join(home, "auth.json"), "{ broken");
    expect(implicitCredentialReadiness(home, siwc(), codexHome)).toBe("unusable");
  });
  test("a parseable login with an empty refresh token is unusable", () => {
    writePrivateFile(join(home, "auth.json"), siwcLogin({ tokens: { access_token: "fake-access", refresh_token: "" } }));
    expect(implicitCredentialReadiness(home, siwc(), codexHome)).toBe("unusable");
  });
  test("a parseable login of another mode is unusable", () => {
    writePrivateFile(join(home, "auth.json"), siwcLogin({ mode: "compat" }));
    expect(implicitCredentialReadiness(home, siwc(), codexHome)).toBe("unusable");
  });
  test("a login readable by others is unusable", () => {
    writePrivateFile(join(home, "auth.json"), siwcLogin());
    makePublic(join(home, "auth.json"));
    expect(implicitCredentialReadiness(home, siwc(), codexHome)).toBe("unusable");
  });
  test("a leftover byok-key beside the login is not a conflict for the synthesized account", () => {
    writePrivateFile(join(home, "auth.json"), siwcLogin());
    writePrivateFile(join(home, "byok-key"), "fake-leftover-key");
    expect(implicitCredentialReadiness(home, siwc(), codexHome)).toBe("connected");
  });
});

describe("implicitCredentialReadiness: BYOK", () => {
  test("no byok-key is missing", () => {
    expect(implicitCredentialReadiness(home, byok(), codexHome)).toBe("missing");
  });
  test("a private one-line key is connected", () => {
    writePrivateFile(join(home, "byok-key"), "fake-byok-key");
    expect(implicitCredentialReadiness(home, byok(), codexHome)).toBe("connected");
  });
  test("an empty key file is unusable", () => {
    writePrivateFile(join(home, "byok-key"), "");
    expect(implicitCredentialReadiness(home, byok(), codexHome)).toBe("unusable");
  });
  test("a key file readable by others is unusable", () => {
    writePrivateFile(join(home, "byok-key"), "fake-byok-key");
    makePublic(join(home, "byok-key"));
    expect(implicitCredentialReadiness(home, byok(), codexHome)).toBe("unusable");
  });
  test.runIf(canSymlinkFiles)("a linked key file is unusable", () => {
    writePrivateFile(join(root, "elsewhere"), "fake-byok-key");
    symlinkSync(join(root, "elsewhere"), join(home, "byok-key"));
    expect(implicitCredentialReadiness(home, byok(), codexHome)).toBe("unusable");
  });
  test("a leftover auth.json beside the key is not a conflict for the synthesized account", () => {
    writePrivateFile(join(home, "byok-key"), "fake-byok-key");
    writePrivateFile(join(home, "auth.json"), siwcLogin());
    expect(implicitCredentialReadiness(home, byok(), codexHome)).toBe("connected");
  });
});

describe("implicitCredentialReadiness: compat", () => {
  test("no $CODEX_HOME/auth.json is missing", () => {
    expect(implicitCredentialReadiness(home, compat(), codexHome)).toBe("missing");
  });
  test("a usable Codex CLI login is connected", () => {
    writeCodexAuth(validCodexLogin());
    expect(implicitCredentialReadiness(home, compat(), codexHome)).toBe("connected");
  });
  test("a tokenless Codex CLI login is unusable", () => {
    writeCodexAuth(JSON.stringify({ tokens: {} }));
    expect(implicitCredentialReadiness(home, compat(), codexHome)).toBe("unusable");
  });
  test("a Codex CLI login readable by others is unusable", () => {
    writeCodexAuth(validCodexLogin());
    makePublic(join(codexHome, "auth.json"));
    expect(implicitCredentialReadiness(home, compat(), codexHome)).toBe("unusable");
  });
});

describe("implicitCredentialReadiness: claude-code", () => {
  test("no claude-code-token is missing", () => {
    expect(implicitCredentialReadiness(home, claude(), codexHome)).toBe("missing");
  });
  test("a private one-line token is connected", () => {
    writePrivateFile(join(home, "claude-code-token"), "fake-claude-token");
    expect(implicitCredentialReadiness(home, claude(), codexHome)).toBe("connected");
  });
  test("a multi-line token file is unusable", () => {
    writePrivateFile(join(home, "claude-code-token"), "fake-claude-token\nsecond-line");
    expect(implicitCredentialReadiness(home, claude(), codexHome)).toBe("unusable");
  });
  test("a token file readable by others is unusable", () => {
    writePrivateFile(join(home, "claude-code-token"), "fake-claude-token");
    makePublic(join(home, "claude-code-token"));
    expect(implicitCredentialReadiness(home, claude(), codexHome)).toBe("unusable");
  });
});

describe("implicitCredentialReadiness is only for the synthesized account", () => {
  test("a stored account is refused rather than judged by legacy paths", () => {
    expect(() => implicitCredentialReadiness(home, { ...byok(), id: "acct_abc1234567" }, codexHome)).toThrow();
  });
});

describe("routing's implicitCredentialState is unchanged (regression)", () => {
  // Routing keeps the 0.2.0 sentences: only SIWC is decided there, every other kind is left to its token source.
  test("BYOK, compat and claude-code still answer connected with no credential at all", () => {
    expect(implicitCredentialState(home, byok())).toBe("connected");
    expect(implicitCredentialState(home, compat())).toBe("connected");
    expect(implicitCredentialState(home, claude())).toBe("connected");
    // ...while readiness reports what is actually there.
    expect(implicitCredentialReadiness(home, byok(), codexHome)).toBe("missing");
    expect(implicitCredentialReadiness(home, compat(), codexHome)).toBe("missing");
    expect(implicitCredentialReadiness(home, claude(), codexHome)).toBe("missing");
  });
  test("a parsed SIWC record that cannot refresh still counts as connected for routing", () => {
    writePrivateFile(join(home, "auth.json"), siwcLogin({ tokens: { access_token: "fake-access", refresh_token: "" } }));
    expect(implicitCredentialState(home, siwc())).toBe("connected");
    expect(implicitCredentialReadiness(home, siwc(), codexHome)).toBe("unusable");
  });
});
