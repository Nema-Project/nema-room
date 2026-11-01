import { describe, expect, test } from "vitest";
import { computeCandidates, type Excluded } from "../../src/routing/candidates.js";
import type { CredentialState } from "../../src/accounts/credentials.js";
import type { Account } from "../../src/accounts/schema.js";

const account = (p: Partial<Account>): Account => ({
  id: "acct_aaaaaaaaaa",
  name: "A",
  enabled: true,
  adapter: "codex-direct",
  authMode: "byok",
  baseUrl: "https://api.example.test/v1",
  model: "m-a",
  costTier: "standard",
  order: 0,
  createdAt: "2026-10-31T00:00:00.000Z",
  ...p,
});

const A = account({ id: "acct_aaaaaaaaaa", name: "A", order: 1 });
const B = account({ id: "acct_bbbbbbbbbb", name: "B", order: 0 });
const C = account({ id: "acct_cccccccccc", name: "C", order: 2, costTier: "low" });
const claude = account({ id: "acct_dddddddddd", name: "Claude", adapter: "claude-code", authMode: undefined, baseUrl: undefined, order: 0 });

const compute = (o: {
  accounts?: Account[];
  adapter?: Account["adapter"];
  needs?: { image?: boolean; pdf?: boolean };
  credential?: (a: Account) => CredentialState;
  cooling?: (id: string) => number | null;
  model?: (a: Account) => string | null;
  now?: number;
}) =>
  computeCandidates({
    accounts: o.accounts ?? [A, B, C],
    adapter: o.adapter ?? "codex-direct",
    needs: o.needs ?? {},
    credentialOf: o.credential ?? (() => "connected"),
    coolingUntil: o.cooling ?? (() => null),
    now: () => o.now ?? 1_000,
    resolveModel: o.model ?? ((a) => a.model ?? null),
  });

const ids = (r: { candidates: { account: Account }[] }) => r.candidates.map((c) => c.account.id);
const why = (r: { excluded: Excluded[] }, id: string) => r.excluded.find((e) => e.accountId === id)?.reason ?? null;

describe("computeCandidates", () => {
  test("keeps only accounts of the task's adapter, and does not report the others as excluded", () => {
    const r = compute({ accounts: [A, claude] });
    expect(ids(r)).toEqual([A.id]);
    // An account of another adapter is not a candidate that lost; it was never in this race.
    expect(r.excluded).toEqual([]);
  });

  test("drops a disabled account and says so", () => {
    const r = compute({ accounts: [A, account({ ...B, enabled: false })] });
    expect(ids(r)).toEqual([A.id]);
    expect(why(r, B.id)).toBe("disabled");
  });

  test("drops an account whose credential is missing or unusable, telling the two apart", () => {
    const r = compute({
      accounts: [A, B, C],
      credential: (a) => (a.id === B.id ? "missing" : a.id === C.id ? "unusable" : "connected"),
    });
    expect(ids(r)).toEqual([A.id]);
    expect(why(r, B.id)).toBe("credential_missing");
    expect(why(r, C.id)).toBe("credential_unusable");
  });

  test("a compat account whose Codex login is unreadable is excluded as such", () => {
    const compat = account({ id: "acct_eeeeeeeeee", name: "E", authMode: "compat", baseUrl: undefined });
    const r = compute({ accounts: [A, compat], credential: (a) => (a.id === compat.id ? "missing" : "connected") });
    expect(why(r, compat.id)).toBe("compat_unreadable");
  });

  test("drops an account that is cooling down, until its time passes", () => {
    const until = 5_000;
    const r = compute({ accounts: [A, B], cooling: (id) => (id === B.id ? until : null), now: 1_000 });
    expect(ids(r)).toEqual([A.id]);
    expect(why(r, B.id)).toBe("cooling");
    // Same table, later clock: the account is back in the race without anything being cleared by hand.
    const later = compute({ accounts: [A, B], cooling: (id) => (id === B.id ? until : null), now: 5_000 });
    expect(ids(later)).toEqual([B.id, A.id]);
  });

  test("drops an account that does not declare what the task needs", () => {
    const claudeAccounts = [
      account({ id: "acct_1111111111", name: "Claude", adapter: "claude-code", authMode: undefined, baseUrl: undefined, order: 0 }),
      account({ id: "acct_2222222222", name: "ClaudePDF", adapter: "claude-code", authMode: undefined, baseUrl: undefined, order: 1, capabilities: { pdf: true } }),
    ];
    const r = compute({ accounts: claudeAccounts, adapter: "claude-code", needs: { pdf: true } });
    expect(ids(r)).toEqual(["acct_2222222222"]);
    expect(why(r, "acct_1111111111")).toBe("capability");
  });

  test("drops an account with no model to run", () => {
    const r = compute({ model: (a) => (a.id === B.id ? null : "m") });
    expect(ids(r)).toEqual([A.id, C.id]);
    expect(why(r, B.id)).toBe("model_missing");
  });

  test("sorts by order, then costTier, then id, and is stable across repeated calls", () => {
    const x = account({ id: "acct_bbbbbbbbbb", name: "B", order: 1, costTier: "high" });
    const y = account({ id: "acct_aaaaaaaaaa", name: "A", order: 1, costTier: "low" });
    const z = account({ id: "acct_cccccccccc", name: "C", order: 1, costTier: "low" });
    const first = compute({ accounts: [x, y, z] });
    expect(ids(first)).toEqual([y.id, z.id, x.id]);
    expect(ids(compute({ accounts: [z, x, y] }))).toEqual(ids(first));
  });

  test("reports an empty set instead of guessing one account", () => {
    const r = compute({ accounts: [A], credential: () => "missing" });
    expect(r.empty).toBe(true);
    expect(r.candidates).toEqual([]);
    expect(r.excluded).toHaveLength(1);
  });

  test("carries the model and the resolved capabilities on each candidate", () => {
    const r = compute({ accounts: [A], model: () => "chosen-model" });
    expect(r.candidates[0]).toMatchObject({ model: "chosen-model", capabilities: { image: "yes", pdf: "yes" } });
  });
});
