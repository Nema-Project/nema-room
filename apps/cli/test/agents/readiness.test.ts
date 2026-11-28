// First-run agent readiness as the daemon computes it (#302 D-1, D-3, D-7). Temporary homes, fake tokens and a
// fake `--version` executor only: no real ~/.nema, no real CLI, no model request.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReadinessReply, RuntimeReadiness, TaskAssign } from "@nema/shared";
import { computeReadiness, type ReadinessInput } from "../../src/agents/readiness.js";
import { VersionProbe, type VersionResult } from "../../src/agentClis.js";
import { accountDir, writeAccounts } from "../../src/accounts/store.js";
import { IMPLICIT_ACCOUNT_ID, type Account, type AccountsFile } from "../../src/accounts/schema.js";
import { DEFAULT_CONFIG, type NemaConfig } from "../../src/config.js";
import { defaultAccountFor } from "../../src/routing/defaultAccount.js";
import { Cooldowns, resolveRoute } from "../../src/routing/index.js";
import { saveAccountSecret } from "../../src/secrets/accounts.js";
import { canSymlinkFiles } from "../links.js";
import { makePublic, writePrivateFile } from "../nativePermissions.js";

const FAKE = {
  siwcAccess: "fake-siwc-access-7f3a",
  siwcRefresh: "fake-siwc-refresh-9b21",
  byokKey: "fake-byok-key-4c88",
  claudeToken: "fake-claude-token-1d5e",
  codexAccess: "fake.codex.access.e6b0",
  storedKey: "fake-stored-key-a913",
  storedToken: "fake-stored-token-55c2",
};

let root: string;
let home: string;
let codexHome: string;
let pathDir: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nema-readiness-"));
  home = path.join(root, "nema");
  codexHome = path.join(root, "codex");
  pathDir = path.join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(pathDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const NOW = new Date("2026-11-27T12:00:00.000Z");
const ok: VersionResult = { kind: "ok", version: "2.1.400 (Claude Code)" };

function probeOf(answer: VersionResult) {
  const execute = vi.fn(async (_command: string) => answer);
  return { probe: new VersionProbe({ execute, now: () => 0 }), execute };
}

function input(over: Partial<ReadinessInput> & { cli?: VersionResult } = {}): ReadinessInput {
  const { cli, ...rest } = over;
  return {
    nemaHome: home,
    codexHome,
    config: { ...DEFAULT_CONFIG },
    probe: probeOf(cli ?? ok).probe,
    now: () => NOW,
    env: { PATH: pathDir },
    ...rest,
  };
}

const row = (reply: ReadinessReply, runtime: RuntimeReadiness["runtime"]): RuntimeReadiness => {
  const found = reply.runtimes.find((r) => r.runtime === runtime);
  if (found === undefined) throw new Error(`no ${runtime} row`);
  return found;
};

const siwcLogin = (refresh = FAKE.siwcRefresh) => JSON.stringify({
  version: 1, mode: "siwc", clientId: "oaiapp_test",
  tokens: { access_token: FAKE.siwcAccess, refresh_token: refresh },
  lastRefresh: "2026-11-01T00:00:00.000Z",
});
const codexLogin = () => JSON.stringify({
  tokens: { access_token: FAKE.codexAccess, refresh_token: "fake-codex-refresh", account_id: "fake-acct" },
  last_refresh: new Date().toISOString(),
});
function writeCodexLogin(): void {
  mkdirSync(codexHome, { recursive: true });
  writePrivateFile(path.join(codexHome, "auth.json"), codexLogin());
}

// Names must be unique in accounts.json; the id is.
const stored = (over: Partial<Account>): Account => {
  const id = over.id ?? "acct_abc1234567";
  return {
    id, name: id, enabled: true, adapter: "codex-direct", authMode: "siwc",
    costTier: "standard", order: 0, createdAt: "2026-11-01T00:00:00.000Z", ...over,
  };
};
// loadRoutingAccounts projects config.json onto the default account (rollback safety), so a test's config has
// to describe the same adapter and mode as its default stored account, as the settings page keeps them.
const BYOK_CONFIG: NemaConfig = { ...DEFAULT_CONFIG, authMode: "byok" };
const COMPAT_CONFIG: NemaConfig = { ...DEFAULT_CONFIG, authMode: "compat" };
const CLAUDE_CONFIG: NemaConfig = { ...DEFAULT_CONFIG, adapter: "claude-code" };
function writeStoredLogin(id: string, body: string): void {
  mkdirSync(accountDir(home, id), { recursive: true, mode: 0o700 });
  writePrivateFile(path.join(accountDir(home, id), "auth.json"), body);
}
function accountsFile(accounts: Account[], extra: Partial<AccountsFile> = {}): void {
  writeAccounts(home, { version: 1, accounts, bindings: {}, ...extra });
}

const CLAUDE_CLI = { command: "claude", installUrl: "https://code.claude.com/docs/en/setup" };

describe("reply shape", () => {
  test("current is config.adapter, checkedAt is ISO, both runtimes are listed in order", async () => {
    const reply = await computeReadiness(input({ config: { ...DEFAULT_CONFIG, adapter: "claude-code" } }));
    expect(reply.current).toBe("claude-code");
    expect(reply.checkedAt).toBe("2026-11-27T12:00:00.000Z");
    expect(reply.runtimes.map((r) => r.runtime)).toEqual(["codex-direct", "claude-code"]);
    expect(reply.daemon).toBeUndefined();
  });
});

describe("codex-direct, synthesized account (no accounts.json)", () => {
  const implicitAccount = (authMode: "siwc" | "byok" | "compat") => ({ id: IMPLICIT_ACCOUNT_ID, implicit: true, authMode });

  test("SIWC: missing → not_signed_in", async () => {
    const r = row(await computeReadiness(input()), "codex-direct");
    expect(r).toEqual({ runtime: "codex-direct", state: "not_signed_in", account: implicitAccount("siwc") });
  });
  test("SIWC: a usable login → configured", async () => {
    writePrivateFile(path.join(home, "auth.json"), siwcLogin());
    expect(row(await computeReadiness(input()), "codex-direct")).toEqual({ runtime: "codex-direct", state: "configured", account: implicitAccount("siwc") });
  });
  test("SIWC: an empty refresh token → credential_unusable", async () => {
    writePrivateFile(path.join(home, "auth.json"), siwcLogin(""));
    expect(row(await computeReadiness(input()), "codex-direct").state).toBe("credential_unusable");
  });
  test("BYOK: no key → not_signed_in", async () => {
    const r = row(await computeReadiness(input({ config: { ...DEFAULT_CONFIG, authMode: "byok" } })), "codex-direct");
    expect(r).toEqual({ runtime: "codex-direct", state: "not_signed_in", account: implicitAccount("byok") });
  });
  test("BYOK: a key but no model → needs_model", async () => {
    writePrivateFile(path.join(home, "byok-key"), FAKE.byokKey);
    expect(row(await computeReadiness(input({ config: { ...DEFAULT_CONFIG, authMode: "byok" } })), "codex-direct").state).toBe("needs_model");
  });
  test("BYOK: a key and a model → configured", async () => {
    writePrivateFile(path.join(home, "byok-key"), FAKE.byokKey);
    const config: NemaConfig = { ...DEFAULT_CONFIG, authMode: "byok", model: "fake-model" };
    expect(row(await computeReadiness(input({ config })), "codex-direct").state).toBe("configured");
  });
  test("BYOK: a key readable by others → credential_unusable", async () => {
    writePrivateFile(path.join(home, "byok-key"), FAKE.byokKey);
    makePublic(path.join(home, "byok-key"));
    const config: NemaConfig = { ...DEFAULT_CONFIG, authMode: "byok", model: "fake-model" };
    expect(row(await computeReadiness(input({ config })), "codex-direct").state).toBe("credential_unusable");
  });
  test("compat: no Codex login → not_signed_in; a usable one → configured", async () => {
    const config: NemaConfig = { ...DEFAULT_CONFIG, authMode: "compat" };
    expect(row(await computeReadiness(input({ config })), "codex-direct")).toEqual({ runtime: "codex-direct", state: "not_signed_in", account: implicitAccount("compat") });
    writeCodexLogin();
    expect(row(await computeReadiness(input({ config })), "codex-direct").state).toBe("configured");
  });
  test("compat: a tokenless Codex login → credential_unusable", async () => {
    mkdirSync(codexHome, { recursive: true });
    writePrivateFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }));
    expect(row(await computeReadiness(input({ config: { ...DEFAULT_CONFIG, authMode: "compat" } })), "codex-direct").state).toBe("credential_unusable");
  });
});

describe("missing accounts.json synthesizes the current runtime only (plan 待确认 4)", () => {
  // loadRoutingAccounts synthesizes one account, for config.adapter. The other runtime then has no enabled
  // account, so it reads not_signed_in / no_enabled_account even when its legacy credential is on disk: the
  // legacy file is not used to preview a switch.
  test("codex-direct current: claude-code has no enabled account even with a legacy token", async () => {
    writePrivateFile(path.join(home, "claude-code-token"), FAKE.claudeToken);
    const r = row(await computeReadiness(input()), "claude-code");
    expect(r).toEqual({ runtime: "claude-code", state: "not_signed_in", reason: "no_enabled_account", cli: { ...CLAUDE_CLI, version: ok.version } });
  });
  test("claude-code current: codex-direct has no enabled account even with a legacy login", async () => {
    writePrivateFile(path.join(home, "auth.json"), siwcLogin());
    const r = row(await computeReadiness(input({ config: { ...DEFAULT_CONFIG, adapter: "claude-code" } })), "codex-direct");
    expect(r).toEqual({ runtime: "codex-direct", state: "not_signed_in", reason: "no_enabled_account" });
  });
  test("claude-code current: the synthesized account's legacy token decides", async () => {
    const config: NemaConfig = { ...DEFAULT_CONFIG, adapter: "claude-code" };
    expect(row(await computeReadiness(input({ config })), "claude-code")).toEqual({
      runtime: "claude-code", state: "not_signed_in", cli: { ...CLAUDE_CLI, version: ok.version }, account: { id: IMPLICIT_ACCOUNT_ID, implicit: true },
    });
    writePrivateFile(path.join(home, "claude-code-token"), FAKE.claudeToken);
    expect(row(await computeReadiness(input({ config })), "claude-code").state).toBe("configured");
    writePrivateFile(path.join(home, "claude-code-token"), "");
    expect(row(await computeReadiness(input({ config })), "claude-code").state).toBe("credential_unusable");
  });
});

describe("codex-direct, stored accounts", () => {
  test("SIWC: missing, configured, unusable", async () => {
    accountsFile([stored({})]);
    const account = { id: "acct_abc1234567", implicit: false, authMode: "siwc" };
    expect(row(await computeReadiness(input()), "codex-direct")).toEqual({ runtime: "codex-direct", state: "not_signed_in", account });
    writeStoredLogin("acct_abc1234567", siwcLogin());
    expect(row(await computeReadiness(input()), "codex-direct").state).toBe("configured");
    writeStoredLogin("acct_abc1234567", siwcLogin(""));
    expect(row(await computeReadiness(input()), "codex-direct").state).toBe("credential_unusable");
  });
  test("BYOK: needs_model without a model, configured with one", async () => {
    accountsFile([stored({ authMode: "byok", baseUrl: "https://api.openai.com/v1" })]);
    saveAccountSecret(home, "acct_abc1234567", "key", FAKE.storedKey);
    expect(row(await computeReadiness(input({ config: BYOK_CONFIG })), "codex-direct")).toEqual({
      runtime: "codex-direct", state: "needs_model", account: { id: "acct_abc1234567", implicit: false, authMode: "byok" },
    });
    accountsFile([stored({ authMode: "byok", baseUrl: "https://api.openai.com/v1", model: "fake-model" })]);
    expect(row(await computeReadiness(input({ config: { ...BYOK_CONFIG, model: "fake-model" } })), "codex-direct").state).toBe("configured");
  });
  test("compat: judged by the Codex CLI login", async () => {
    accountsFile([stored({ authMode: "compat" })]);
    expect(row(await computeReadiness(input({ config: COMPAT_CONFIG })), "codex-direct").state).toBe("not_signed_in");
    writeCodexLogin();
    expect(row(await computeReadiness(input({ config: COMPAT_CONFIG })), "codex-direct").state).toBe("configured");
  });
  test("the default account is the first enabled one by order, then id", async () => {
    accountsFile([
      stored({ id: "acct_zzz0000000", order: 0, enabled: false }),
      stored({ id: "acct_bbb0000000", order: 1 }),
      stored({ id: "acct_aaa0000000", order: 1 }),
      stored({ id: "acct_ccc0000000", order: 2 }),
    ]);
    expect(row(await computeReadiness(input()), "codex-direct").account?.id).toBe("acct_aaa0000000");
  });
  test("no enabled account → not_signed_in / no_enabled_account, no account field", async () => {
    accountsFile([stored({ enabled: false })]);
    expect(row(await computeReadiness(input()), "codex-direct")).toEqual({ runtime: "codex-direct", state: "not_signed_in", reason: "no_enabled_account" });
  });
});

describe("claude-code: the command first, then the account", () => {
  const claudeAccount = () => stored({ id: "acct_cla0000000", adapter: "claude-code", authMode: undefined });
  function withClaudeToken(): void {
    accountsFile([claudeAccount()]);
    saveAccountSecret(home, "acct_cla0000000", "token", FAKE.storedToken);
  }

  test("command ok and a stored token → configured with the version", async () => {
    withClaudeToken();
    expect(row(await computeReadiness(input({ config: CLAUDE_CONFIG })), "claude-code")).toEqual({
      runtime: "claude-code", state: "configured", cli: { ...CLAUDE_CLI, version: "2.1.400 (Claude Code)" }, account: { id: "acct_cla0000000", implicit: false },
    });
  });
  test("command ok and no token → not_signed_in", async () => {
    accountsFile([claudeAccount()]);
    expect(row(await computeReadiness(input({ config: CLAUDE_CONFIG })), "claude-code").state).toBe("not_signed_in");
  });
  test("no enabled claude account → not_signed_in / no_enabled_account", async () => {
    accountsFile([{ ...claudeAccount(), enabled: false }, stored({})]);
    expect(row(await computeReadiness(input()), "claude-code")).toEqual({
      runtime: "claude-code", state: "not_signed_in", reason: "no_enabled_account", cli: { ...CLAUDE_CLI, version: ok.version },
    });
  });

  test.each<[string, VersionResult, Partial<RuntimeReadiness>]>([
    ["ENOENT with nothing on PATH", { kind: "enoent" }, { state: "not_installed" }],
    ["a timeout", { kind: "timeout" }, { state: "unknown", reason: "cli_timeout" }],
    ["any other failure (including an unreadable Windows shim)", { kind: "error" }, { state: "unknown", reason: "cli_error" }],
  ])("%s: the account is not judged", async (_label, cli, expected) => {
    withClaudeToken();
    const inspect = vi.fn((_account: Account) => "connected" as const);
    const r = row(await computeReadiness(input({ cli, inspect, config: CLAUDE_CONFIG })), "claude-code");
    expect(r).toEqual({ runtime: "claude-code", ...expected, cli: { ...CLAUDE_CLI, version: null } });
    expect(inspect.mock.calls.map(([a]) => a.adapter)).not.toContain("claude-code");
  });

  test.runIf(canSymlinkFiles && process.platform !== "win32")("ENOENT with a dangling link on PATH: unknown / cli_broken", async () => {
    withClaudeToken();
    symlinkSync(path.join(root, "gone", "cli.js"), path.join(pathDir, "claude"));
    expect(row(await computeReadiness(input({ cli: { kind: "enoent" }, config: CLAUDE_CONFIG })), "claude-code")).toEqual({
      runtime: "claude-code", state: "unknown", reason: "cli_broken", cli: { ...CLAUDE_CLI, version: null },
    });
  });

  test("codex-direct never probes a command", async () => {
    const { probe, execute } = probeOf(ok);
    await computeReadiness(input({ probe }));
    expect(execute.mock.calls.map(([c]) => c)).toEqual(["claude"]);
  });
});

describe("unknown", () => {
  test("an unreadable accounts.json → both unknown / inspect_failed, and no command is run", async () => {
    writePrivateFile(path.join(home, "accounts.json"), "{ not json");
    const { probe, execute } = probeOf(ok);
    const reply = await computeReadiness(input({ probe }));
    expect(reply.runtimes).toEqual([
      { runtime: "codex-direct", state: "unknown", reason: "inspect_failed" },
      { runtime: "claude-code", state: "unknown", reason: "inspect_failed" },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });
  test("an accounts.json readable by others is unreadable too", async () => {
    accountsFile([stored({})]);
    writeFileSync(path.join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: [], bindings: {} }));
    makePublic(path.join(home, "accounts.json"));
    expect((await computeReadiness(input())).runtimes.map((r) => r.state)).toEqual(["unknown", "unknown"]);
  });
  test("loadRoutingAccounts is read once per call", async () => {
    const load = vi.fn((..._args: unknown[]) => ({ accounts: [], bindings: {}, autoRouting: false }));
    await computeReadiness(input({ loadAccounts: load }));
    expect(load).toHaveBeenCalledTimes(1);
  });
  test("a throwing credential check → unknown / inspect_failed, account still named", async () => {
    accountsFile([stored({})]);
    const r = row(await computeReadiness(input({ inspect: () => { throw new Error("EIO"); } })), "codex-direct");
    expect(r).toEqual({ runtime: "codex-direct", state: "unknown", reason: "inspect_failed", account: { id: "acct_abc1234567", implicit: false, authMode: "siwc" } });
  });
});

describe("force and the version cache", () => {
  test("an ordinary call reuses a cached ok answer; force probes again", async () => {
    const { probe, execute } = probeOf(ok);
    await computeReadiness(input({ probe }));
    await computeReadiness(input({ probe }));
    expect(execute).toHaveBeenCalledTimes(1);
    await computeReadiness(input({ probe, force: true }));
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("the reply carries no credential (reverse assertion)", () => {
  test("serialized, it holds none of the fake secrets nor any local path", async () => {
    writePrivateFile(path.join(home, "auth.json"), siwcLogin());
    writePrivateFile(path.join(home, "byok-key"), FAKE.byokKey);
    writePrivateFile(path.join(home, "claude-code-token"), FAKE.claudeToken);
    writeCodexLogin();
    const replies = [
      await computeReadiness(input()),
      await computeReadiness(input({ config: { ...DEFAULT_CONFIG, adapter: "claude-code" } })),
      await computeReadiness(input({ config: { ...DEFAULT_CONFIG, authMode: "byok", model: "fake-model" } })),
      await computeReadiness(input({ config: { ...DEFAULT_CONFIG, authMode: "compat" } })),
    ];
    accountsFile([
      stored({}),
      stored({ id: "acct_byk0000000", authMode: "byok", baseUrl: "https://api.openai.com/v1", order: 1 }),
      stored({ id: "acct_cla0000000", adapter: "claude-code", authMode: undefined }),
    ]);
    writeStoredLogin("acct_abc1234567", siwcLogin());
    saveAccountSecret(home, "acct_byk0000000", "key", FAKE.storedKey);
    saveAccountSecret(home, "acct_cla0000000", "token", FAKE.storedToken);
    replies.push(await computeReadiness(input()));

    const serialized = JSON.stringify(replies);
    expect(replies.every((r) => row(r, "codex-direct").state === "configured" || row(r, "claude-code").state === "configured")).toBe(true);
    for (const secret of [...Object.values(FAKE), "fake-codex-refresh", "fake-acct"]) expect(serialized).not.toContain(secret);
    for (const local of [root, home, codexHome, "auth.json", "byok-key", "claude-code-token"]) expect(serialized).not.toContain(local);
  });

  test("a stored BYOK default is judged (and its key still never leaks)", async () => {
    // The stored BYOK account above is order 1 behind an order-0 SIWC account, so it is never the
    // default and its key is never read. Make it the default to prove the reverse assertion is real.
    accountsFile([stored({ id: "acct_byk0000000", authMode: "byok", baseUrl: "https://api.openai.com/v1", order: 0 })]);
    saveAccountSecret(home, "acct_byk0000000", "key", FAKE.storedKey);
    const reply = await computeReadiness(input({ config: { ...DEFAULT_CONFIG, authMode: "byok", model: "fake-model" } }));
    const r = row(reply, "codex-direct");
    expect(r.state).toBe("configured");
    expect(r.account).toEqual({ id: "acct_byk0000000", implicit: false, authMode: "byok" });
    expect(JSON.stringify(reply)).not.toContain(FAKE.storedKey);
  });
});

describe("the default account matches resolveRoute (no drifting copy)", () => {
  const task = { taskId: "t1", workspaceId: "ws1", prompt: "x" } as unknown as TaskAssign;
  const sets: Account[][] = [
    [],
    [stored({ enabled: false })],
    [stored({ id: "acct_bbb0000000", order: 1 }), stored({ id: "acct_aaa0000000", order: 1 })],
    [stored({ id: "acct_aaa0000000", order: 3 }), stored({ id: "acct_zzz0000000", order: 0 })],
    [stored({ id: "acct_aaa0000000", order: 0, enabled: false }), stored({ id: "acct_ccc0000000", order: 5 })],
    [stored({ id: "acct_cla0000000", adapter: "claude-code", authMode: undefined }), stored({ id: "acct_aaa0000000", order: 9 })],
  ];
  test.each(sets.flatMap((accounts, i) => (["codex-direct", "claude-code"] as const).map((adapter) => [i, adapter, accounts] as const)))(
    "set %i, %s",
    (_i, adapter, accounts) => {
      const result = resolveRoute({
        task, config: { ...DEFAULT_CONFIG }, adapter, accounts, bindings: {}, cooldowns: new Cooldowns(),
        credentialOf: () => "connected", resolveModel: () => "m", autoRouting: false,
      });
      const chosen = defaultAccountFor(accounts, adapter);
      if (result.ok) expect(chosen?.id).toBe(result.account.id);
      else {
        expect(result.failure).toBe("no_account");
        expect(chosen).toBeUndefined();
      }
    },
  );
});
