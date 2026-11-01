import { describe, expect, test } from "vitest";
import type { TaskAssign } from "@nema/shared";
import { DEFAULT_CONFIG, type NemaConfig } from "../../src/config.js";
import type { Account } from "../../src/accounts/schema.js";
import { IMPLICIT_ACCOUNT_ID } from "../../src/accounts/schema.js";
import type { CredentialState } from "../../src/accounts/credentials.js";
import { Cooldowns } from "../../src/routing/cooldown.js";
import { resolveRoute, routeDecision } from "../../src/routing/index.js";

const account = (p: Partial<Account>): Account => ({
  id: "acct_aaaaaaaaaa",
  name: "A",
  enabled: true,
  adapter: "codex-direct",
  authMode: "byok",
  baseUrl: "https://api.example.test/v1",
  model: "model-a",
  costTier: "standard",
  order: 0,
  createdAt: "2026-10-31T00:00:00.000Z",
  ...p,
});

const FIRST = account({ id: "acct_aaaaaaaaaa", name: "First", order: 0 });
const SECOND = account({ id: "acct_bbbbbbbbbb", name: "Second", order: 1 });
const THIRD = account({ id: "acct_cccccccccc", name: "Third", order: 2 });

const task = (p: Partial<TaskAssign> = {}): TaskAssign => ({
  type: "task.assign",
  taskId: "t1",
  workspaceId: "w1",
  adapter: "auto",
  confidential: false,
  prompt: "p",
  runToken: "rt",
  hubUrl: "http://hub.test",
  pluginTools: [],
  ...p,
});

const resolve = (o: {
  task?: Partial<TaskAssign>;
  accounts?: Account[];
  bindings?: Record<string, string>;
  credential?: (a: Account) => CredentialState;
  config?: NemaConfig;
  cooldowns?: Cooldowns;
  model?: (a: Account) => string | null;
}) =>
  resolveRoute({
    task: task(o.task),
    config: o.config ?? { ...DEFAULT_CONFIG, authMode: "byok" },
    accounts: o.accounts ?? [FIRST, SECOND, THIRD],
    bindings: o.bindings ?? {},
    cooldowns: o.cooldowns ?? new Cooldowns({ now: () => 0 }),
    credentialOf: o.credential ?? (() => "connected"),
    resolveModel: o.model ?? ((a) => a.model ?? null),
  });

describe("resolveRoute scope", () => {
  test("the account named on this message wins, and says so", () => {
    const r = resolve({ task: { accountId: SECOND.id }, bindings: { "thread:m_t": THIRD.id, "ws:w1": FIRST.id } });
    expect(r).toMatchObject({ ok: true, mode: "manual", reason: "user_message" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.account.id).toBe(SECOND.id);
    expect(r.model).toBe("model-a");
  });

  test("a thread binding beats a workspace binding", () => {
    const r = resolve({ task: { threadId: "m_t" }, bindings: { "thread:m_t": THIRD.id, "ws:w1": SECOND.id } });
    expect(r).toMatchObject({ ok: true, reason: "user_thread" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.account.id).toBe(THIRD.id);
  });

  test("a workspace binding is used when this message names nothing and the thread has none", () => {
    const r = resolve({ bindings: { "ws:w1": SECOND.id } });
    expect(r).toMatchObject({ ok: true, reason: "user_workspace" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.account.id).toBe(SECOND.id);
  });

  test("with no choice anywhere it falls to the machine's default: smallest order, enabled", () => {
    const r = resolve({ accounts: [THIRD, SECOND, account({ ...FIRST, enabled: false })] });
    expect(r).toMatchObject({ ok: true, reason: "default" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.account.id).toBe(SECOND.id);
  });

  test("a thread binding for another thread does not apply", () => {
    const r = resolve({ task: { threadId: "m_other" }, bindings: { "thread:m_t": THIRD.id } });
    expect(r).toMatchObject({ ok: true, reason: "default" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.account.id).toBe(FIRST.id);
  });
});

describe("resolveRoute failures", () => {
  test("an account id this machine does not have fails and says that, without falling back", () => {
    const r = resolve({ task: { accountId: "acct_zzzzzzzzzz" } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("unknown_account");
    expect(r.error).toContain("不存在");
    // The point of the sentence: it must not claim to have used the default instead.
    expect(r.error).not.toContain(SECOND.name);
  });

  test("a named account with no credential fails before anything runs", () => {
    const r = resolve({ task: { accountId: SECOND.id }, credential: (a) => (a.id === SECOND.id ? "missing" : "connected") });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("credential_missing");
    // The user has to be able to tell which account needs the key.
    expect(r.error).toContain(SECOND.name);
  });

  test("a named account with an unusable credential is told apart from a missing one", () => {
    const r = resolve({ task: { accountId: SECOND.id }, credential: () => "unusable" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("credential_unusable");
  });

  test("an account of the other adapter is refused rather than run by the wrong one", () => {
    const claude = account({ id: "acct_dddddddddd", name: "Claude", adapter: "claude-code", authMode: undefined, baseUrl: undefined });
    const r = resolve({ accounts: [FIRST, claude], task: { accountId: claude.id } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("adapter_mismatch");
    expect(r.error).toContain("claude-code");
  });

  test("automatic routing is refused in this version and says so", () => {
    const r = resolve({ task: { routing: "auto" } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("auto_unavailable");
    expect(r.error).toContain("后续版本");
  });

  test("an auto binding is refused the same way, not quietly ignored", () => {
    const r = resolve({ bindings: { "ws:w1": "auto" } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("auto_unavailable");
  });

  test("no enabled account of this adapter at all fails with a sentence about the adapter", () => {
    const r = resolve({ accounts: [account({ ...FIRST, enabled: false })] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("no_account");
    expect(r.error).toContain("codex-direct");
  });

  test("a byok account with no model fails and says how to set one", () => {
    const r = resolve({ task: { accountId: SECOND.id }, model: () => null });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("model_missing");
    expect(r.error).toContain(SECOND.name);
  });
});

describe("resolveRoute leaves credentials alone", () => {
  test("the stored route record carries no endpoint and no credential", () => {
    // The record is stored in the message and exported with the conversation: an endpoint in it would leave
    // the machine with the transcript, so base URL stays out even though this resolve step knew it.
    const r = resolve({ accounts: [account({ ...FIRST, baseUrl: "https://key.example.test/v1", name: "First" })] });
    if (!r.ok) throw new Error("expected ok");
    const record = JSON.stringify(routeDecision(r, "model-a"));
    expect(record).not.toContain("key.example.test");
    expect(record).not.toContain("baseUrl");
  });

  test("no result carries a credential value", () => {
    const key = "sk-very-secret-value-0123456789";
    const withKey = account({ ...FIRST });
    const r = resolve({ accounts: [withKey], task: { accountId: withKey.id } });
    expect(JSON.stringify(r)).not.toContain(key);
  });

  test("a failure message never repeats a credential-shaped name", () => {
    // Names are user text. One that looks like a key is refused by the schema, but a message must still not
    // repeat one that got in some other way.
    const suspicious = account({ ...SECOND, name: "sk-abcdefghijklmnopqrstuvwxyz" });
    const r = resolve({ accounts: [FIRST, suspicious], task: { accountId: suspicious.id }, credential: () => "missing" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(r.error).toContain(suspicious.id);
  });
});

describe("exclusions", () => {
  test("carries what the candidate computation set aside, for the details panel", () => {
    const r = resolve({
      accounts: [FIRST, SECOND, account({ ...THIRD, enabled: false })],
      credential: (a) => (a.id === SECOND.id ? "missing" : "connected"),
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.excluded.map((e) => e.reason).sort()).toEqual(["credential_missing", "disabled"]);
  });

  test("the default account is the smallest order, not the first with a working credential", () => {
    // Nobody named an account, so nothing may be picked on the user's behalf beyond the documented rule:
    // order. Falling through to a usable account would spend a different account's quota silently.
    const r = resolve({ accounts: [SECOND, THIRD], credential: (a) => (a.id === SECOND.id ? "missing" : "connected") });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("credential_missing");
    expect(r.error).toContain(SECOND.name);
  });
});

describe("routeDecision", () => {
  test("turns a choice into the record the message stores", () => {
    const r = resolve({ task: { accountId: SECOND.id } });
    if (!r.ok) throw new Error("expected ok");
    expect(routeDecision(r, "model-z")).toEqual({
      accountId: SECOND.id,
      accountName: SECOND.name,
      model: "model-z",
      mode: "manual",
      reason: "user_message",
    });
  });

  test("the implicit account is a route like any other", () => {
    const implicit = account({ id: IMPLICIT_ACCOUNT_ID, name: "默认账户", model: "m" });
    const r = resolve({ accounts: [implicit] });
    if (!r.ok) throw new Error("expected ok");
    expect(routeDecision(r, "m")).toMatchObject({ accountId: IMPLICIT_ACCOUNT_ID, reason: "default", mode: "manual" });
  });
});

describe("the adapter a task runs as", () => {
  test("a task naming claude-code is routed among claude-code accounts", () => {
    const claude = account({ id: "acct_dddddddddd", name: "Claude", adapter: "claude-code", authMode: undefined, baseUrl: undefined });
    const r = resolve({ accounts: [FIRST, claude], task: { adapter: "claude-code", accountId: claude.id } });
    expect(r).toMatchObject({ ok: true, reason: "user_message" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.account.id).toBe(claude.id);
  });

  test("\"auto\" means the configured adapter, so a claude account is not a candidate in a codex task", () => {
    const claude = account({ id: "acct_dddddddddd", name: "Claude", adapter: "claude-code", authMode: undefined, baseUrl: undefined });
    const r = resolve({ accounts: [claude], task: { adapter: "auto" } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("no_account");
    expect(r.error).toContain("codex-direct");
  });

  test("the retired codex CLI name still routes to codex-direct", () => {
    const r = resolve({ task: { adapter: "codex" } });
    expect(r).toMatchObject({ ok: true, reason: "default" });
  });
});
