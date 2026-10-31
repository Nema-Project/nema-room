import { describe, expect, test } from "vitest";
import {
  AccountsFileSchema,
  COST_TIERS,
  IMPLICIT_ACCOUNT_ID,
  accountNameProblem,
  newAccountId,
  validateAccountsFile,
  type AccountsFile,
} from "../../src/accounts/schema.js";

const base = (over: Record<string, unknown> = {}) => ({
  id: "acct_abc1234567",
  name: "OpenAI 主账号",
  enabled: true,
  adapter: "codex-direct" as const,
  authMode: "byok" as const,
  baseUrl: "https://api.openai.com/v1",
  costTier: "standard" as const,
  order: 0,
  createdAt: "2026-10-31T00:00:00.000Z",
  ...over,
});

const file = (accounts: unknown[], bindings: Record<string, string> = {}): AccountsFile =>
  ({ version: 1, accounts, bindings }) as AccountsFile;

describe("account schema", () => {
  test("accepts the four stored combinations", () => {
    const four = [
      base({ authMode: "siwc", baseUrl: undefined, name: "订阅" }),
      base({ authMode: "compat", baseUrl: undefined, name: "Codex 登录" }),
      base({ name: "API 密钥" }),
      base({ adapter: "claude-code", authMode: undefined, baseUrl: undefined, name: "Claude" }),
    ];
    for (const account of four) {
      expect(AccountsFileSchema.safeParse(file([account])).success).toBe(true);
      expect(validateAccountsFile(file([account]))).toEqual([]);
    }
  });

  test("rejects unknown keys", () => {
    expect(AccountsFileSchema.safeParse(file([base({ secret: "x" })])).success).toBe(false);
  });

  test("rejects a cost tier and an order outside the allowed ranges", () => {
    expect(AccountsFileSchema.safeParse(file([base({ costTier: "cheap" })])).success).toBe(false);
    expect(AccountsFileSchema.safeParse(file([base({ order: -1 })])).success).toBe(false);
    expect(AccountsFileSchema.safeParse(file([base({ order: 1.5 })])).success).toBe(false);
  });

  test("rejects a malformed account id", () => {
    for (const id of ["acct_short", "acct_ABC1234567", "../acct_abc1234567", "abc1234567"]) {
      expect(AccountsFileSchema.safeParse(file([base({ id })])).success).toBe(false);
    }
  });

  test("rejects the reserved implicit id as a stored account", () => {
    // The all-zero id only ever names the synthesized account, whose files stay at the legacy paths.
    // A stored row with it would be mistaken for that account and read the wrong credential.
    expect(AccountsFileSchema.safeParse(file([base({ id: IMPLICIT_ACCOUNT_ID })])).success).toBe(false);
    expect(validateAccountsFile(file([base({ id: IMPLICIT_ACCOUNT_ID })])))
      .toEqual([expect.stringContaining("保留")]);
    // A binding may name it: that is how a workspace keeps its choice before the first edit.
    expect(validateAccountsFile(file([base()], { "ws:w1": IMPLICIT_ACCOUNT_ID })))
      .toEqual([expect.stringContaining("不存在")]);
  });

  test("newAccountId never returns the implicit id and keeps the shape", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = newAccountId();
      expect(id).toMatch(/^acct_[a-z0-9]{10}$/);
      expect(id).not.toBe(IMPLICIT_ACCOUNT_ID);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
    // A generator that keeps drawing the implicit id is refused, not returned.
    expect(() => newAccountId(() => "0000000000")).toThrow();
  });

  test("names are unique ignoring case, ids are unique exactly", () => {
    expect(validateAccountsFile(file([base(), base({ id: "acct_def1234567", name: "openai 主账号" })])))
      .toEqual([expect.stringContaining("重名")]);
    expect(validateAccountsFile(file([base(), base({ name: "另一个" })])))
      .toEqual([expect.stringContaining("重复")]);
  });

  test("each combination keeps only the fields it uses", () => {
    expect(validateAccountsFile(file([base({ authMode: "byok", baseUrl: undefined })])))
      .toEqual([expect.stringContaining("baseUrl")]);
    expect(validateAccountsFile(file([base({ authMode: "compat" })])))
      .toEqual([expect.stringContaining("compat")]);
    expect(validateAccountsFile(file([base({ adapter: "claude-code", authMode: "siwc", baseUrl: undefined })])))
      .toEqual([expect.stringContaining("authMode")]);
    expect(validateAccountsFile(file([base({ authMode: undefined, baseUrl: undefined })])))
      .toEqual([expect.stringContaining("authMode")]);
  });

  test("bindings only accept known scopes and known accounts or auto", () => {
    const one = base();
    expect(validateAccountsFile(file([one], { "ws:w1": one.id }))).toEqual([]);
    expect(validateAccountsFile(file([one], { "thread:t1": "auto" }))).toEqual([]);
    expect(validateAccountsFile(file([one], { "room:r1": one.id })))
      .toEqual([expect.stringContaining("scope")]);
    expect(validateAccountsFile(file([one], { "ws:w1": "acct_missing001" })))
      .toEqual([expect.stringContaining("不存在")]);
  });

  test("accountNameProblem explains what is wrong", () => {
    expect(accountNameProblem("OpenAI 主账号")).toBeNull();
    expect(accountNameProblem("")).not.toBeNull();
    expect(accountNameProblem("x".repeat(41))).toContain("40");
    expect(accountNameProblem("bad\u0000name")).not.toBeNull();
    expect(accountNameProblem("sk-abcdefghijklmnopqrstuvwxyz0123")).toContain("密钥");
  });

  test("COST_TIERS lists the three tiers in order", () => {
    expect(COST_TIERS).toEqual(["low", "standard", "high"]);
  });
});
