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

  test("newAccountId skips ids that are already taken", () => {
    const taken = new Set(["acct_taken00000"]);
    const seq = ["taken00000", "fresh00000"];
    let i = 0;

    expect(newAccountId(() => seq[i++]!, (id) => taken.has(id))).toBe("acct_fresh00000");
    // A generator that only produces taken ids fails instead of returning one that would overwrite
    // another account's credential.
    expect(() => newAccountId(() => "taken00000", (id) => taken.has(id))).toThrow(/无法生成账户 id/);
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

  test("the name limit is counted in code points, the same unit the problem message uses (review 7)", () => {
    // 30 emoji are 30 characters and 60 UTF-16 units. `.max(40)` counted units, so the schema refused a name
    // `accountNameProblem` accepted: the settings page and the stored-file validator disagreed.
    const emoji = "😀".repeat(30);
    expect(Array.from(emoji)).toHaveLength(30);
    expect(emoji.length).toBe(60);

    expect(accountNameProblem(emoji)).toBeNull();
    expect(AccountsFileSchema.safeParse(file([base({ name: emoji })])).success).toBe(true);
    expect(validateAccountsFile(file([base({ name: emoji })]))).toEqual([]);

    // 41 code points is still refused by both, with the same message.
    const tooLong = "😀".repeat(41);
    expect(accountNameProblem(tooLong)).toContain("40");
    const parsed = AccountsFileSchema.safeParse(file([base({ name: tooLong })]));
    expect(parsed.success).toBe(false);
    // The schema states the limit in the same words the validator uses, instead of zod's English default:
    // this rule is user-facing, and the two rules describe one limit.
    expect(JSON.stringify(parsed.error?.issues)).toContain("名字最多 40 个字符");
    expect(validateAccountsFile(file([base({ name: tooLong })]))).toEqual([expect.stringContaining("40")]);
  });

  test("createdAt must be an ISO 8601 timestamp (review 7)", () => {
    // Every producer writes `toISOString()`, and the settings page renders the value as a date.
    expect(AccountsFileSchema.safeParse(file([base({ createdAt: "2026-10-31T00:00:00.000Z" })])).success).toBe(true);
    expect(AccountsFileSchema.safeParse(file([base({ createdAt: new Date().toISOString() })])).success).toBe(true);
    for (const bad of ["x", "", "2026-10-31", "yesterday"]) {
      expect(AccountsFileSchema.safeParse(file([base({ createdAt: bad })])).success).toBe(false);
    }
  });

  test("a timestamp with a numeric offset is accepted, both here and end to end", () => {
    // `z.string().datetime()` takes only `Z`. This file is hand-editable and the user is in UTC+9, so
    // `+09:00` is the form a human or another tool writes: refusing it made the whole file read as corrupt
    // and every account vanished from the app while the data was still on disk.
    const withOffset = "2026-10-31T09:00:00+09:00";
    expect(AccountsFileSchema.safeParse(file([base({ createdAt: withOffset })])).success).toBe(true);
    expect(AccountsFileSchema.safeParse(file([base({ createdAt: "2026-10-31T00:00:00.000Z" })])).success).toBe(true);
    expect(AccountsFileSchema.safeParse(file([base({ createdAt: "not a date" })])).success).toBe(false);
    // Both forms name the same instant, and a `Date` renders either.
    expect(Date.parse(withOffset)).toBe(Date.parse("2026-10-31T00:00:00.000Z"));
  });

  test("accountNameProblem explains what is wrong", () => {
    expect(accountNameProblem("OpenAI 主账号")).toBeNull();
    expect(accountNameProblem("")).not.toBeNull();
    expect(accountNameProblem("x".repeat(41))).toContain("40");
    expect(accountNameProblem("bad\u0000name")).not.toBeNull();
    expect(accountNameProblem("fakecredentialname0123456789abcdef")).toContain("密钥");
  });

  test("a name that looks like a secret is never echoed back in an error", () => {
    // The settings page shows these messages, and they can reach a log. A pasted key must not come back.
    const secret = "fake-test-value-not-a-real-credential";
    const problems = validateAccountsFile(file([base({ name: secret })]));

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).not.toContain(secret);
    expect(problems.join(" ")).toMatch(/密钥|凭据/);
  });

  test("a secret-like name is reported without quoting any part of it", () => {
    const secret = "fake-test-value-not-a-real-credential-2";
    const problems = validateAccountsFile(file([base({ name: secret })]));

    for (const problem of problems) expect(problem).not.toMatch(/fake-test-value|not-a-real/i);
  });

  test("a name that is not secret-like is still never echoed", () => {
    // A short credential pasted into a name does not match SECRET_LIKE, and the message still must not
    // repeat it.
    const pasted = "fake-test-value";
    // This row has an unrelated problem (siwc must not carry a baseUrl), so a message does name it.
    const problems = validateAccountsFile(file([base({ name: pasted, authMode: "siwc" })]));

    expect(problems.join(" ")).not.toContain(pasted);
    // A row is identified only by its account id.
    expect(problems.join(" ")).toContain("acct_abc1234567");
  });

  test("a pasted credential in a binding value never comes back in the error", () => {
    const pasted = "fake-test-value-not-a-real-credential";
    const problems = validateAccountsFile(file([base()], { "ws:w1": pasted }));

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).not.toContain("fake-test-value");
    expect(problems.join(" ")).toContain("不存在");
  });

  test("a pasted credential in a scope never comes back in the error", () => {
    const pasted = "fake-test-value-not-a-real-credential";
    const problems = validateAccountsFile(file([base()], { [pasted]: "auto" }));

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).not.toContain("fake-test-value");
    expect(problems.join(" ")).toContain("scope");
  });

  test("an id that is not one of ours is never echoed either", () => {
    // A file can carry free text in the id field too; the message must not repeat it.
    const pasted = "fake-test-value-in-the-id-field";
    const problems = validateAccountsFile(file([base({ id: pasted })]));

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).not.toContain(pasted);
    expect(problems.join(" ")).toContain("id 不合法");
  });

  test("a duplicate name is reported by account id, never by name", () => {
    const problems = validateAccountsFile(file([base(), base({ id: "acct_def1234567", name: "OPENAI 主账号" })]));

    expect(problems).toEqual([expect.stringContaining("重名")]);
    expect(problems.join(" ")).not.toContain("OPENAI");
    expect(problems.join(" ")).not.toContain("OpenAI");
  });

  test("COST_TIERS lists the three tiers in order", () => {
    expect(COST_TIERS).toEqual(["low", "standard", "high"]);
  });
});

describe("BYOK endpoint safety", () => {
  test("an endpoint that config.json would refuse is refused in account data too", () => {
    // The API key is sent to this address: remote http, URLs carrying credentials, query strings and
    // fragments must all be refused before they are stored.
    for (const baseUrl of [
      "http://evil.example/v1",
      "http://192.168.1.5/v1",
      "https://user:pw@api.example.com/v1",
      "https://api.example.com/v1?key=1",
      "https://api.example.com/v1#frag",
      "https://api.example.com/v1 ",
      "ftp://api.example.com/v1",
    ]) {
      expect(AccountsFileSchema.safeParse(file([base({ baseUrl })])).success).toBe(false);
      expect(validateAccountsFile(file([base({ baseUrl })])).join(" ")).toContain("https");
    }
  });

  test("https and local http endpoints are accepted", () => {
    for (const baseUrl of ["https://api.example.com/v1", "http://127.0.0.1:8080/v1", "http://localhost/v1"]) {
      expect(AccountsFileSchema.safeParse(file([base({ baseUrl })])).success).toBe(true);
      expect(validateAccountsFile(file([base({ baseUrl })]))).toEqual([]);
    }
  });

  test("a stored endpoint is normalized, so path building never doubles a slash", () => {
    // config.json stores the normalized form (no trailing slash) and consumers append `/responses`.
    const parsed = AccountsFileSchema.parse(file([base({ baseUrl: "https://api.example.com/v1/" })]));
    expect(parsed.accounts[0]!.baseUrl).toBe("https://api.example.com/v1");
    expect(`${parsed.accounts[0]!.baseUrl}/responses`).toBe("https://api.example.com/v1/responses");

    // Already-normalized values are unchanged, and an unusable one is still refused rather than normalized.
    expect(AccountsFileSchema.parse(file([base({ baseUrl: "https://api.example.com/v1" })])).accounts[0]!.baseUrl)
      .toBe("https://api.example.com/v1");
    expect(AccountsFileSchema.safeParse(file([base({ baseUrl: "http://evil.example/v1/" })])).success).toBe(false);
  });

  test("the rule is the config rule, not a copy: its message is reused verbatim", () => {
    const problem = validateAccountsFile(file([base({ baseUrl: "http://evil.example/v1" })])).join(" ");
    expect(problem).toContain("byokBaseUrl 只允许 https");
  });
});
