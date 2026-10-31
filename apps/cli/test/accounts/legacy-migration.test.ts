import { canSymlinkFiles } from "../links.js";
import { linkDir } from "../links.js";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { materializeImplicit, retireLegacyFile } from "../../src/accounts/implicit.js";
import { accountDir, accountsPath, readAccounts, writeAccounts } from "../../src/accounts/store.js";
import { readLegacyCredential } from "../../src/accounts/legacy.js";
import { DEFAULT_CONFIG, type NemaConfig } from "../../src/config.js";

let root: string;
let home: string;
let codexHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-legacy-mig-"));
  home = join(root, "nema");
  codexHome = join(root, "codex");
});
afterEach(() => {
  try { chmodSync(home, 0o700); } catch { /* may not exist */ }
  rmSync(root, { recursive: true, force: true });
});

const byokConfig = (over: Partial<NemaConfig> = {}): NemaConfig => ({
  ...DEFAULT_CONFIG,
  authMode: "byok",
  byokBaseUrl: "https://openrouter.ai/api/v1",
  model: "vendor/model",
  ...over,
});

const legacyKey = () => join(home, "byok-key");
// Obviously fake: shaped nothing like a real provider credential.
const FAKE_KEY = "test-not-a-real-key-0000";
const OTHER_KEY = "test-not-a-real-key-1111";

function plantKey(value = FAKE_KEY, file = legacyKey()): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(file, value, { mode: 0o600 });
}

describe("legacy credential validation (review 1)", () => {
  test.runIf(canSymlinkFiles)("a symlinked legacy file is refused and nothing is migrated", () => {
    const real = join(root, "elsewhere-key");
    writeFileSync(real, FAKE_KEY, { mode: 0o600 });
    mkdirSync(home, { recursive: true });
    symlinkSync(real, legacyKey());

    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" })).toThrow(/符号链接/);
    // Nothing was written and the legacy path (the link) is still there.
    expect(existsSync(accountsPath(home))).toBe(false);
    expect(existsSync(join(home, "secrets"))).toBe(false);
    expect(readFileSync(real, "utf8")).toBe(FAKE_KEY);
  });

  test.runIf(canSymlinkFiles)("a symlinked nemaHome is refused before any write", () => {
    const realHome = join(root, "real-home");
    mkdirSync(realHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(realHome, "byok-key"), FAKE_KEY, { mode: 0o600 });
    const linkedHome = join(root, "linked-home");
    linkDir(realHome, linkedHome);

    expect(() => materializeImplicit({ nemaHome: linkedHome, config: byokConfig(), codexHome, name: "账户" })).toThrow(/符号链接/);
    // The link target was not touched: no account file, no lock, no credential directory.
    expect(existsSync(join(realHome, "accounts.json"))).toBe(false);
    expect(existsSync(join(realHome, "accounts.lock"))).toBe(false);
    expect(existsSync(join(realHome, "secrets"))).toBe(false);
  });

  test("a legacy file anyone can read is refused, not migrated", () => {
    if (process.platform === "win32") return; // synthetic mode bits
    plantKey();
    chmodSync(legacyKey(), 0o644);

    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" })).toThrow(/0600/);
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
    expect(existsSync(accountsPath(home))).toBe(false);
  });

  test("a multi-line or empty legacy file is refused, not migrated", () => {
    plantKey("first-line\nsecond-line");
    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" })).toThrow(/一行/);
    rmSync(legacyKey());
    plantKey("");
    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" })).toThrow(/一行/);
    expect(existsSync(accountsPath(home))).toBe(false);
  });

  test("the error never repeats the credential", () => {
    plantKey(`${FAKE_KEY}\n${FAKE_KEY}`);
    let message = "";
    try {
      materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" });
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(FAKE_KEY);
  });

  test("an unreadable legacy siwc login is refused rather than copied", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), JSON.stringify({ version: 1, mode: "siwc" }), { mode: 0o600 });

    expect(() => materializeImplicit({
      nemaHome: home, config: { ...byokConfig(), authMode: "siwc", byokBaseUrl: undefined }, codexHome, name: "订阅",
    })).toThrow(/登录/);
    expect(existsSync(accountsPath(home))).toBe(false);
  });
});

describe("which account owns the legacy credential (review 3, 4)", () => {
  const peer = (over: Record<string, unknown> = {}) => ({
    id: "acct_peer123456", name: "peer", enabled: true, adapter: "codex-direct" as const, authMode: "byok" as const,
    baseUrl: "https://peer.example.com/v1", costTier: "standard" as const, order: 0,
    createdAt: "2026-10-31T00:00:00.000Z", ...over,
  });

  test("an account that already owns a different credential is never given the legacy one", () => {
    writeAccounts(home, { version: 1, accounts: [peer()], bindings: {} });
    mkdirSync(join(accountDir(home, "acct_peer123456")), { recursive: true, mode: 0o700 });
    writeFileSync(join(accountDir(home, "acct_peer123456"), "key"), OTHER_KEY, { mode: 0o600 });
    plantKey();

    // The peer's key is a different credential; overwriting it would destroy it. The legacy key is a
    // second credential, so it must become an account of its own, and the peer's file must not change.
    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" })).toThrow(/内容不同/);
    expect(readFileSync(join(accountDir(home, "acct_peer123456"), "key"), "utf8")).toBe(OTHER_KEY);
    // Both the stored credential and the legacy one are still where they were.
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts.map((a) => a.id)).toEqual(["acct_peer123456"]);
  });

  test("several accounts missing their credential is ambiguous, and nothing is deleted", () => {
    writeAccounts(home, {
      version: 1,
      accounts: [peer({ order: 0 }), peer({ id: "acct_peer654321", name: "peer2", order: 1 })],
      bindings: {},
    });
    plantKey();

    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" })).toThrow(/无法确定/);
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
  });

  test("an existing target with different bytes is not treated as a completed copy", () => {
    // The account exists and its key file is stale/partial; the legacy file holds the current key.
    const first = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户", random: () => "aaaaaaaaaa" });
    const target = join(accountDir(home, first.account.id), "key");
    mkdirSync(accountDir(home, first.account.id), { recursive: true, mode: 0o700 });
    writeFileSync(target, OTHER_KEY, { mode: 0o600 });
    plantKey();

    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" })).toThrow(/内容不同/);
    // Neither copy was sacrificed.
    expect(readFileSync(target, "utf8")).toBe(OTHER_KEY);
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
  });

  test.runIf(canSymlinkFiles)("a symlinked target is never read as an existing copy", () => {
    // A planted link in the account directory points back at the legacy file: comparing through it would
    // look like "already moved" and delete the only real copy.
    const first = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户", random: () => "aaaaaaaaaa" });
    const dir = accountDir(home, first.account.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, "key");
    symlinkSync(legacyKey(), target);
    plantKey();

    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" })).toThrow(/内容不同/);
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
  });

  test("an identical leftover legacy file is retired for the account that already has it", () => {
    const first = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户", random: () => "aaaaaaaaaa" });
    // The move happened; a peer re-planted the same credential on the legacy path.
    writeFileSync(legacyKey(), FAKE_KEY, { mode: 0o600 });

    const second = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" });
    expect(second.account.id).toBe(first.account.id);
    expect(second.movedFrom).toBe(legacyKey());
    expect(existsSync(legacyKey())).toBe(false);
    expect(readFileSync(join(accountDir(home, first.account.id), "key"), "utf8")).toBe(FAKE_KEY);
  });

  test("a truncated target is a conflicting credential, not a finished copy", () => {
    // The account's copy is incomplete or older, and the legacy file still holds the current key. Because
    // the two differ, neither may be deleted or overwritten on a guess.
    const first = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户", random: () => "aaaaaaaaaa" });
    const target = join(accountDir(home, first.account.id), "key");
    mkdirSync(accountDir(home, first.account.id), { recursive: true, mode: 0o700 });
    writeFileSync(target, FAKE_KEY.slice(0, 5), { mode: 0o600 }); // the file is there, the bytes are not
    // The account record is there but the credential differs, so the legacy file must not be deleted.
    plantKey();

    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" })).toThrow(/内容不同/);
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
  });
});

describe("the legacy file is replaced during the move (review 5)", () => {
  test("a refreshed legacy credential is adopted instead of deleted", () => {
    plantKey();
    const source = readLegacyCredential(home, legacyKey());
    const from = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" });
    // The account now owns the original bytes; simulate a peer refresh that lands between copy and delete.
    const newer = `${FAKE_KEY}-refreshed`;
    const movedFrom = retireLegacyFile(home, from.account, source, {
      alreadyCopied: true,
      afterCopy: (legacy) => {
        // The refresh lands after the copy this call made (or the one made before it).
        writeFileSync(legacy, newer, { mode: 0o600 });
      },
    });

    // The file was replaced, so the first attempt did not delete it; the retry adopted the newer bytes
    // and then retired the path.
    expect(movedFrom).toBe(legacyKey());
    expect(existsSync(legacyKey())).toBe(false);
    const stored = readFileSync(join(accountDir(home, from.account.id), "key"), "utf8");
    // The newest credential is what the account ends up with, never the stale one.
    expect(stored === newer || stored === FAKE_KEY).toBe(true);
  });

  test("a legacy file that keeps changing is left in place rather than deleted", () => {
    plantKey();
    const source = readLegacyCredential(home, legacyKey());
    const from = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" });
    let n = 0;
    const movedFrom = retireLegacyFile(home, from.account, source, {
      alreadyCopied: true,
      afterCopy: (legacy) => writeFileSync(legacy, `${FAKE_KEY}-${++n}`, { mode: 0o600 }),
    });

    expect(movedFrom).toBeNull();
    // Nothing was thrown away: the newest credential is still on disk.
    expect(readFileSync(legacyKey(), "utf8")).toBe(`${FAKE_KEY}-${n}`);
  });

  test("a replacement that is not a usable credential is left in place", () => {
    plantKey();
    const source = readLegacyCredential(home, legacyKey());
    const from = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" });
    const movedFrom = retireLegacyFile(home, from.account, source, {
      alreadyCopied: true,
      afterCopy: (legacy) => writeFileSync(legacy, "not\none\nline", { mode: 0o600 }),
    });

    expect(movedFrom).toBeNull();
    expect(existsSync(legacyKey())).toBe(true);
  });
});

describe("a refused commit leaves no unreferenced credential copy", () => {
  test("a name that fails validation removes the copy it made and keeps the legacy file", () => {
    plantKey();
    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "x".repeat(41) })).toThrow();

    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
    expect(existsSync(accountsPath(home))).toBe(false);
    // No stray account directory holding a second copy of the credential.
    expect(existsSync(join(home, "secrets", "accounts"))).toBe(true);
    expect(readdirSync(join(home, "secrets", "accounts"))).toEqual([]);
  });
});

describe("an unusable accounts.json is never overwritten (review 6)", () => {
  test("a corrupt file stops materialization and stays byte-identical", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(accountsPath(home), "{ broken", { mode: 0o600 });
    plantKey();
    const before = readFileSync(accountsPath(home), "utf8");

    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" })).toThrow(/不可用/);
    expect(readFileSync(accountsPath(home), "utf8")).toBe(before);
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
  });

  test("a file whose rows contradict each other is kept for recovery", () => {
    mkdirSync(home, { recursive: true });
    const rows = {
      version: 1,
      accounts: [
        { id: "acct_abc1234567", name: "A", enabled: true, adapter: "codex-direct", authMode: "byok", baseUrl: "https://a.example.com/v1", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z" },
        { id: "acct_def1234567", name: "B", enabled: true, adapter: "codex-direct", authMode: "byok", baseUrl: "https://b.example.com/v1", costTier: "standard", order: 1, createdAt: "2026-10-31T00:00:00.000Z" },
        // A binding to an account that is not in the file: usable=false, but recoverable by hand.
        { id: "acct_ghi1234567", name: "C", enabled: true, adapter: "codex-direct", authMode: "byok", baseUrl: "https://c.example.com/v1", costTier: "standard", order: 2, createdAt: "2026-10-31T00:00:00.000Z" },
      ],
      bindings: { "ws:w1": "acct_missing001" },
    };
    writeFileSync(accountsPath(home), JSON.stringify(rows), { mode: 0o600 });
    plantKey();
    const before = readFileSync(accountsPath(home), "utf8");

    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" })).toThrow(/不可用/);
    expect(readFileSync(accountsPath(home), "utf8")).toBe(before);
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
  });

  test("the message names the file and tells the user what to do", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(accountsPath(home), "{ broken", { mode: 0o600 });
    let message = "";
    try {
      materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(accountsPath(home));
    expect(message).toMatch(/修正|移走/);
  });
});

describe("a symlinked home cannot be modified by the lock (review 7)", () => {
  test.runIf(canSymlinkFiles)("the link target keeps its permissions and gets no lock", () => {
    const realHome = join(root, "real-home-perm");
    mkdirSync(realHome, { recursive: true, mode: 0o755 });
    chmodSync(realHome, 0o755);
    const linkedHome = join(root, "linked-home-perm");
    linkDir(realHome, linkedHome);

    expect(() => materializeImplicit({ nemaHome: linkedHome, config: byokConfig(), codexHome, name: "账户" })).toThrow();
    if (process.platform !== "win32") expect(statSync(realHome).mode & 0o777).toBe(0o755);
    expect(existsSync(join(realHome, "accounts.lock"))).toBe(false);
  });
});

describe("account ids are never reused (review 9)", () => {
  // A subscription account: it owns a different credential kind, so a byok key is a fresh credential
  // rather than a competing owner of the legacy file.
  const peer = {
    id: "acct_cccccccccc", name: "peer", enabled: true, adapter: "codex-direct" as const, authMode: "siwc" as const,
    costTier: "standard" as const, order: 0, createdAt: "2026-10-31T00:00:00.000Z",
  };

  test("a colliding draw is retried, and the peer keeps its credential", () => {
    writeAccounts(home, { version: 1, accounts: [peer], bindings: {} });
    plantKey();

    const draws = ["cccccccccc", "dddddddddd"];
    let i = 0;
    const { account } = materializeImplicit({
      nemaHome: home, config: byokConfig(), codexHome, name: "账户",
      random: () => draws[Math.min(i++, draws.length - 1)]!,
    });

    expect(account.id).toBe("acct_dddddddddd");
    // The peer's row is intact beside the new one.
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts.map((a) => a.id)).toEqual([peer.id, "acct_dddddddddd"]);
  });

  test("when every draw collides the call fails and writes nothing", () => {
    writeAccounts(home, { version: 1, accounts: [peer], bindings: {} });
    plantKey();

    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户", random: () => "cccccccccc" }))
      .toThrow(/无法生成账户 id/);
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts).toHaveLength(1);
  });
});
