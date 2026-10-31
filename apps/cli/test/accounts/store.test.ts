import { canSymlinkFiles } from "../links.js";
import { expectPrivate } from "../nativePermissions.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { accountsPath, accountDir, readAccounts, writeAccounts } from "../../src/accounts/store.js";
import type { AccountsFile } from "../../src/accounts/schema.js";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-accounts-store-"));
  home = join(root, "nema");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const account = (over: Record<string, unknown> = {}) => ({
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

const file = (accounts: unknown[] = [account()], bindings: Record<string, string> = {}): AccountsFile =>
  ({ version: 1, accounts, bindings }) as AccountsFile;

describe("accounts.json", () => {
  test("round-trips and stays private", () => {
    writeAccounts(home, file([account()], { "ws:w1": "acct_abc1234567" }));

    const read = readAccounts(home);
    expect(read).toEqual({ status: "ok", file: file([account()], { "ws:w1": "acct_abc1234567" }) });
    expectPrivate(accountsPath(home), 0o600);
    expectPrivate(home, 0o700);
  });

  test("a missing file is not an error", () => {
    expect(readAccounts(home)).toEqual({ status: "missing" });
  });

  test.runIf(canSymlinkFiles)("refuses a symlinked file without reading through it", () => {
    mkdirSync(home, { recursive: true });
    const target = join(root, "elsewhere.json");
    writeFileSync(target, JSON.stringify(file()));
    symlinkSync(target, accountsPath(home));

    expect(readAccounts(home)).toEqual({ status: "unusable", reason: "symlink" });
  });

  test("refuses a file anyone else can read", () => {
    if (process.platform === "win32") return; // synthetic mode bits carry no meaning here
    writeAccounts(home, file());
    chmodSync(accountsPath(home), 0o644);

    expect(readAccounts(home)).toEqual({ status: "unusable", reason: "mode" });
  });

  test("reports broken JSON and schema failures separately", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(accountsPath(home), "{ not json", { mode: 0o600 });
    expect(readAccounts(home)).toEqual({ status: "unusable", reason: "corrupt" });

    writeFileSync(accountsPath(home), JSON.stringify({ version: 2, accounts: [], bindings: {} }), { mode: 0o600 });
    expect(readAccounts(home)).toEqual({ status: "unusable", reason: "corrupt" });
  });

  test("reports a file whose rows contradict each other", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(accountsPath(home), JSON.stringify(file([account(), account({ name: "另一个" })])), { mode: 0o600 });

    const read = readAccounts(home);
    expect(read).toMatchObject({ status: "unusable", reason: "invalid" });
    // The settings page shows why, so the reasons travel with the result.
    expect((read as { problems?: string[] }).problems?.[0]).toContain("重复");
  });

  test("a refused write leaves the existing file untouched", () => {
    writeAccounts(home, file());
    const before = readFileSync(accountsPath(home), "utf8");

    expect(() => writeAccounts(home, file([account(), account({ name: "另一个" })]))).toThrow(/重复/);
    expect(readFileSync(accountsPath(home), "utf8")).toBe(before);
  });

  test("accountDir refuses an id that could escape the directory", () => {
    expect(() => accountDir(home, "../x")).toThrow();
    expect(() => accountDir(home, "acct_0000000000")).not.toThrow();
    expect(accountDir(home, "acct_abc1234567")).toBe(join(home, "secrets", "accounts", "acct_abc1234567"));
  });

  test("writes no file when the directory does not exist yet", () => {
    expect(existsSync(home)).toBe(false);
    expect(readAccounts(home)).toEqual({ status: "missing" });
    expect(existsSync(home)).toBe(false);
  });
});
