import { describe, expect, test } from "vitest";
import { MAX_PARAM_LENGTH, TASK_ERROR, type TaskAssign } from "@nema/shared";
import { DEFAULT_CONFIG } from "../../src/config.js";
import { IMPLICIT_ACCOUNT_ID, type Account } from "../../src/accounts/schema.js";
import type { CredentialState } from "../../src/accounts/credentials.js";
import { Cooldowns } from "../../src/routing/cooldown.js";
import { resolveRoute, type RouteResult } from "../../src/routing/index.js";
import { BYOK_MODEL_REQUIRED, MISSING_BYOK_KEY, MISSING_CLAUDE_TOKEN, MISSING_CODEX_LOGIN, NOT_LOGGED_IN, failureFields } from "../../src/routing/messages.js";
import { ReloginRequiredError, UNUSABLE_FILE_MESSAGE } from "../../src/direct/authStore.js";

/*
 * #299 batch 3a: every refusal `resolveRoute` returns carries a code (`route.refusal.*`, or the synthesized
 * account's own `auth.*`) and flat params, beside the unchanged fallback sentence.
 */

const account = (p: Partial<Account>): Account => ({
  id: "acct_aaaaaaaaaa",
  name: "Work",
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

const task = (p: Partial<TaskAssign> = {}): TaskAssign => ({
  type: "task.assign", taskId: "t1", workspaceId: "w1", adapter: "auto", confidential: false, prompt: "p",
  runToken: "rt", hubUrl: "http://hub.test", pluginTools: [], ...p,
});

const image = { id: "a1", kind: "image" as const, name: "shot.png", mime: "image/png", size: 3, sha256: "a".repeat(64), messageId: "m1" };
const pdf = { ...image, id: "a2", kind: "pdf" as const, name: "doc.pdf", mime: "application/pdf" };

function refuse(o: {
  task?: Partial<TaskAssign>;
  adapter?: Account["adapter"];
  accounts: Account[];
  credential?: (a: Account) => CredentialState;
  model?: (a: Account) => string | null;
  autoRouting?: boolean;
  cooldowns?: Cooldowns;
}): Extract<RouteResult, { ok: false }> {
  const r = resolveRoute({
    task: task(o.task),
    config: { ...DEFAULT_CONFIG },
    adapter: o.adapter ?? "codex-direct",
    accounts: o.accounts,
    bindings: {},
    cooldowns: o.cooldowns ?? new Cooldowns({ now: () => 0 }),
    credentialOf: o.credential ?? (() => "connected"),
    resolveModel: o.model ?? ((a) => a.model ?? null),
    autoRouting: o.autoRouting ?? false,
  });
  if (r.ok) throw new Error("expected a refusal");
  return r;
}

describe("route refusal codes", () => {
  test("automatic routing while the switch is off", () => {
    const r = refuse({ task: { routing: "auto" }, accounts: [account({})] });
    expect(r).toMatchObject({ failure: "auto_unavailable", code: TASK_ERROR.routeAutoUnavailable });
    expect(r.params).toBeUndefined();
    expect(r.error).toContain("自动路由未开启");
  });

  test("no enabled account names the adapter", () => {
    const r = refuse({ adapter: "claude-code", accounts: [account({})] });
    expect(r).toMatchObject({ failure: "no_account", code: TASK_ERROR.routeNoAccount, params: { adapter: "claude-code" } });
  });

  test("an unknown account names the id", () => {
    const r = refuse({ task: { accountId: "acct_zzzzzzzzzz" }, accounts: [account({})] });
    expect(r).toMatchObject({ failure: "unknown_account", code: TASK_ERROR.routeUnknownAccount, params: { accountId: "acct_zzzzzzzzzz" } });
  });

  test("an account of the other adapter names both adapters and the account, never the Chinese label", () => {
    const claude = account({ adapter: "claude-code", authMode: undefined, baseUrl: undefined });
    const r = refuse({ task: { accountId: claude.id }, accounts: [claude] });
    expect(r).toMatchObject({
      failure: "adapter_mismatch",
      code: TASK_ERROR.routeAdapterMismatch,
      params: { account: "Work", accountAdapter: "claude-code", adapter: "codex-direct" },
    });
  });

  test("a stored account's missing or unusable credential and missing model", () => {
    expect(refuse({ accounts: [account({})], credential: () => "missing" })).toMatchObject({
      failure: "credential_missing", code: TASK_ERROR.routeCredentialMissing, params: { account: "Work" },
    });
    expect(refuse({ accounts: [account({})], credential: () => "unusable" })).toMatchObject({
      failure: "credential_unusable", code: TASK_ERROR.routeCredentialUnusable, params: { account: "Work" },
    });
    expect(refuse({ accounts: [account({})], model: () => null })).toMatchObject({
      failure: "model_missing", code: TASK_ERROR.routeModelMissing, params: { account: "Work" },
    });
  });

  test("a name that looks like a credential is replaced by the id in the params too", () => {
    const secretish = account({ name: "sk-abcdefghijklmnopqrstuvwxyz" });
    const r = refuse({ accounts: [secretish], credential: () => "missing" });
    expect(r.params).toEqual({ account: secretish.id });
    expect(JSON.stringify(r.params)).not.toContain("sk-abc");
  });

  test("the synthesized account keeps 0.2.0's sentences, each with its own code", () => {
    const implicit = (p: Partial<Account>) => account({ id: IMPLICIT_ACCOUNT_ID, name: "默认账户", ...p });
    const cases: [Partial<Account>, CredentialState, string, string][] = [
      [{ authMode: "siwc", baseUrl: undefined }, "missing", NOT_LOGGED_IN, TASK_ERROR.authNotLoggedIn],
      [{ authMode: "byok" }, "missing", MISSING_BYOK_KEY, TASK_ERROR.byokKeyMissing],
      [{ authMode: "compat", baseUrl: undefined }, "missing", MISSING_CODEX_LOGIN, TASK_ERROR.codexLoginMissing],
      [{ adapter: "claude-code", authMode: undefined, baseUrl: undefined }, "missing", MISSING_CLAUDE_TOKEN, TASK_ERROR.claudeTokenMissing],
      [{ authMode: "siwc", baseUrl: undefined }, "unusable", UNUSABLE_FILE_MESSAGE, TASK_ERROR.authLoginFileUnusable],
    ];
    for (const [p, state, error, code] of cases) {
      const a = implicit(p);
      const r = refuse({ adapter: a.adapter, accounts: [a], credential: () => state });
      expect(r, code).toMatchObject({ error, code });
      expect(r.params, code).toBeUndefined();
    }
    const r = refuse({ accounts: [implicit({ authMode: "byok", model: undefined })], model: () => null });
    expect(r).toMatchObject({ error: BYOK_MODEL_REQUIRED, code: TASK_ERROR.byokModelRequired });
  });
});

describe("automatic routing with no candidate", () => {
  test("nothing set aside: the adapter only", () => {
    const r = refuse({ task: { routing: "auto" }, autoRouting: true, accounts: [] });
    expect(r).toMatchObject({ failure: "no_candidate", code: TASK_ERROR.routeNoCandidate, params: { adapter: "codex-direct" } });
  });

  test("accounts set aside are grouped by reason in flat params", () => {
    const r = refuse({
      task: { routing: "auto" },
      autoRouting: true,
      accounts: [
        account({ id: "acct_aaaaaaaaaa", name: "Off", enabled: false }),
        account({ id: "acct_bbbbbbbbbb", name: "NoKey", order: 1 }),
        account({ id: "acct_cccccccccc", name: "AlsoOff", enabled: false, order: 2 }),
      ],
      credential: (a) => (a.name === "NoKey" ? "missing" : "connected"),
    });
    expect(r.code).toBe(TASK_ERROR.routeNoCandidateExcluded);
    expect(r.params).toEqual({ adapter: "codex-direct", disabled: "Off, AlsoOff", credential_missing: "NoKey" });
    // The fallback sentence is unchanged.
    expect(r.error).toContain("账户「Off」（已停用）");
  });

  test("a long list is cut at a whole name, with a count of what was cut", () => {
    const many = Array.from({ length: 400 }, (_, i) => account({ id: `acct_${String(i).padStart(10, "0")}`, name: `Account number ${i}`, enabled: false, order: i }));
    const r = refuse({ task: { routing: "auto" }, autoRouting: true, accounts: many });
    const listed = String(r.params?.disabled);
    expect(listed.length).toBeLessThanOrEqual(MAX_PARAM_LENGTH);
    expect(listed).toMatch(/, \+\d+$/);
    expect(listed.split(", ").slice(0, -1).every((name) => /^Account number \d+$/.test(name))).toBe(true);
  });

  test("attachments no account declares: the kinds as codes and the accounts that did not declare them", () => {
    const r = refuse({
      task: { routing: "auto", attachments: [image, pdf] },
      autoRouting: true,
      accounts: [account({ capabilities: { image: false, pdf: false } }), account({ id: "acct_bbbbbbbbbb", name: "Other", order: 1, capabilities: { image: false } })],
    });
    expect(r).toMatchObject({ failure: "no_candidate", code: TASK_ERROR.routeNoCapableAccount, params: { needs: "image,pdf", accounts: "Work, Other" } });
  });
});

describe("failureFields", () => {
  test("a dead direct login is coded although its own `code` is the OAuth reason", () => {
    expect(failureFields(new ReloginRequiredError("invalid_grant"))).toEqual({ code: TASK_ERROR.authReloginRequired });
  });

  test("a plain error or a Node error has no code", () => {
    expect(failureFields(new Error("x"))).toEqual({});
    expect(failureFields(Object.assign(new Error("x"), { code: "ENOENT" }))).toEqual({});
  });
});
