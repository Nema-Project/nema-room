import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG, type NemaConfig } from "../../src/config.js";
import { accountsPath } from "../../src/accounts/store.js";

// Counts the reads that actually produce routing's answer. `vi.hoisted` so the mock factory can see it.
const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/accounts/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/accounts/store.js")>();
  return {
    ...actual,
    readAccounts: (nemaHome: string) => {
      reads.count += 1;
      return actual.readAccounts(nemaHome);
    },
  };
});
import { IMPLICIT_ACCOUNT_ID } from "../../src/accounts/schema.js";
import { loadRoutingAccounts } from "../../src/routing/accountSet.js";
import { writePrivateFile } from "../nativePermissions.js";

let root: string;
let home: string;
let codexHome: string;
const config = (): NemaConfig => ({ ...DEFAULT_CONFIG, adapter: "codex-direct", authMode: "byok", model: "m", byokBaseUrl: "https://a.example.test/v1" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-routing-accountset-"));
  home = join(root, "nema");
  codexHome = join(root, "codex");
  mkdirSync(home, { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const stored = (id = "acct_abc1234567") => ({
  id, name: "A", enabled: true, adapter: "codex-direct", authMode: "byok",
  baseUrl: "https://a.example.test/v1", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z",
});

describe("the accounts a daemon routes over", () => {
  test("a missing accounts.json keeps the 0.2.0 behaviour: one synthesized account, no bindings", () => {
    const picked = loadRoutingAccounts(home, config(), codexHome);
    expect(picked.accounts.map((a) => a.id)).toEqual([IMPLICIT_ACCOUNT_ID]);
    expect(picked.bindings).toEqual({});
  });

  test("a stored file is what is routed over, bindings included", () => {
    writePrivateFile(accountsPath(home), JSON.stringify({ version: 1, accounts: [stored()], bindings: { "ws:w1": "acct_abc1234567" } }));
    const picked = loadRoutingAccounts(home, config(), codexHome);
    expect(picked.accounts.map((a) => a.id)).toEqual(["acct_abc1234567"]);
    expect(picked.bindings).toEqual({ "ws:w1": "acct_abc1234567" });
  });

  test("an unreadable accounts.json fails instead of routing on the synthesized account", () => {
    // The dangerous case: there are accounts on this machine and none can be read. Falling back would run
    // the task on the legacy single credential and a projected endpoint — a different account, silently.
    writeFileSync(accountsPath(home), "{ broken", { mode: 0o600 });
    expect(() => loadRoutingAccounts(home, config(), codexHome)).toThrow(/accounts\.json|账户设置/);
  });

  test("a world-readable accounts.json is refused too, rather than quietly ignored", () => {
    writePrivateFile(accountsPath(home), JSON.stringify({ version: 1, accounts: [stored()], bindings: {} }));
    if (process.platform === "win32") return; // mode bits are synthetic there; the DACL case is covered in accounts/
    // chmod, not writeFileSync({ mode }): that argument only applies when the file is created, and this one
    // already exists at 0600 from the helper above.
    chmodSync(accountsPath(home), 0o644);
    expect(() => loadRoutingAccounts(home, config(), codexHome)).toThrow(/账户设置/);
  });
});

describe("the file is read once", () => {
  test("accounts, bindings and the error all come from a single read", () => {
    // The settings page writes accounts.json under a lock this read does not take, so two reads can describe
    // two different versions of the file. Worse, a second read that failed would hand back `{}` for every
    // binding — silently unbinding every scope while looking like a normal answer. One read makes both
    // impossible, and this counts it rather than trusting the shape of the function.
    writePrivateFile(
      accountsPath(home),
      JSON.stringify({ version: 1, accounts: [stored()], bindings: { "ws:w1": "acct_abc1234567" } }),
    );
    reads.count = 0;
    const picked = loadRoutingAccounts(home, config(), codexHome);
    expect(reads.count).toBe(1);
    expect(picked.accounts.map((a) => a.id)).toEqual(["acct_abc1234567"]);
    expect(picked.bindings).toEqual({ "ws:w1": "acct_abc1234567" });

    // The unusable path reports instead of returning empty bindings, from that same read.
    chmodSync(accountsPath(home), 0o644);
    if (process.platform === "win32") return; // synthetic mode bits; the DACL case is covered in accounts/
    reads.count = 0;
    expect(() => loadRoutingAccounts(home, config(), codexHome)).toThrow(/账户设置/);
    expect(reads.count).toBe(1);
  });
});
