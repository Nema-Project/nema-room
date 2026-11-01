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
  /** The adapter the runner chose. Not read from the task or the config: the task's "auto" means nothing here. */
  adapter?: Account["adapter"];
  accounts?: Account[];
  bindings?: Record<string, string>;
  credential?: (a: Account) => CredentialState;
  config?: NemaConfig;
  cooldowns?: Cooldowns;
  model?: (a: Account) => string | null;
  /** The global switch (D-3). Off in every test that does not name it, which is the shipped default. */
  autoRouting?: boolean;
}) =>
  resolveRoute({
    task: task(o.task),
    config: o.config ?? { ...DEFAULT_CONFIG, authMode: "byok" },
    adapter: o.adapter ?? "codex-direct",
    accounts: o.accounts ?? [FIRST, SECOND, THIRD],
    bindings: o.bindings ?? {},
    cooldowns: o.cooldowns ?? new Cooldowns({ now: () => 0 }),
    credentialOf: o.credential ?? (() => "connected"),
    resolveModel: o.model ?? ((a) => a.model ?? null),
    autoRouting: o.autoRouting ?? false,
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

  test("automatic routing is refused while the switch is off, and says so", () => {
    const r = resolve({ task: { routing: "auto" } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("auto_unavailable");
    expect(r.error).toContain("自动路由未开启");
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

describe("a named account is honoured as given", () => {
  test("a disabled account runs when the user names it, and is still excluded from the default pick", () => {
    // Spec step 2: a named account is not excluded for capability, enabled state or cooldown; only the
    // credential is checked. Disabling parks an account against automatic selection, it does not refuse an
    // account the user then pointed at.
    const off = account({ ...SECOND, enabled: false });
    const named = resolve({ accounts: [FIRST, off], task: { accountId: off.id } });
    if (!named.ok) throw new Error(`expected ok, got ${named.failure}: ${named.error}`);
    expect(named.account.id).toBe(off.id);

    // The default path is where the flag still has its effect: it is never picked on the user's behalf.
    const byDefault = resolve({ accounts: [off], task: {} });
    if (byDefault.ok) throw new Error("expected failure");
    expect(byDefault.failure).toBe("no_account");
  });

  test("a disabled account with no credential still fails, naming the credential and not the flag", () => {
    const off = account({ ...SECOND, enabled: false });
    const r = resolve({ accounts: [off], task: { accountId: off.id }, credential: () => "missing" });
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("credential_missing");
    expect(r.error).toContain(off.name);
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

describe("the adapter the task actually runs as", () => {
  const claude = account({ id: "acct_dddddddddd", name: "Claude", adapter: "claude-code", authMode: undefined, baseUrl: undefined });

  test("a claude task is routed among claude accounts", () => {
    const r = resolve({ adapter: "claude-code", accounts: [FIRST, claude], task: { accountId: claude.id } });
    expect(r).toMatchObject({ ok: true, reason: "user_message" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.account.id).toBe(claude.id);
  });

  test("a claude task with only codex accounts fails instead of running one of them", () => {
    const r = resolve({ adapter: "claude-code", accounts: [FIRST] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("no_account");
    expect(r.error).toContain("claude-code");
  });

  test("the configured adapter in config.json does not decide the route", () => {
    // A workspace can run a claude-code task while config.json names codex-direct (the setting is a projection
    // of the *default* account). Reading it here would route the task among the wrong adapter's accounts.
    const r = resolve({ adapter: "codex-direct", accounts: [claude] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("no_account");
    expect(r.error).toContain("codex-direct");
  });
});

describe("automatic routing and the switch", () => {
  test("a request for automatic routing fails while the switch is off, and says the switch is off", () => {
    // S4 keeps the S3 guarantee: an explicit `routing: "auto"` never quietly becomes a single-account run.
    // What changes is the sentence — the feature exists now, it is just not turned on.
    const r = resolve({ task: { routing: "auto" }, autoRouting: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("auto_unavailable");
    expect(r.error).toContain("自动路由未开启");
    // The sentence has to say how to turn it on, or it is just a refusal.
    expect(r.error).toContain("设置");
  });

  test("an \"auto\" binding fails the same way while the switch is off", () => {
    const r = resolve({ bindings: { "ws:w1": "auto" }, autoRouting: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.failure).toBe("auto_unavailable");
    expect(r.error).toContain("自动路由未开启");
  });

  test("a thread bound to auto is not skipped in favour of the workspace binding", () => {
    // An `auto` binding is a choice the user made. Falling through to the workspace's account instead would
    // be the silent substitution the whole feature exists to prevent.
    const r = resolve({ task: { threadId: "m_t" }, bindings: { "thread:m_t": "auto", "ws:w1": SECOND.id }, autoRouting: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.error).toContain("自动路由未开启");
  });

  test("with the switch on, an unqualified task still runs on the default account in manual mode", () => {
    // The switch unlocks the option; it does not make anything automatic on its own (D-3). Nothing bound and
    // nothing named is still the default account, and the record still says so.
    const r = resolve({ autoRouting: true });
    if (!r.ok) throw new Error(`expected ok, got ${r.failure}: ${r.error}`);
    expect(r.account.id).toBe(FIRST.id);
    expect(r.mode).toBe("manual");
    expect(r.reason).toBe("default");
  });
});
