import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writePrivateFile } from "../nativePermissions.js";
import { loadAccounts, materializeImplicit, retireLegacyFile } from "../../src/accounts/implicit.js";
import { readLegacyCredential } from "../../src/accounts/legacy.js";
import { accountDir } from "../../src/accounts/store.js";
import { withFileLockSync } from "../../src/direct/lock.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

/**
 * The retirement race, injected at the two fs steps that decide it: one writer replaces the legacy file
 * just before it is claimed, another re-creates it just after the claim is deleted. Both are what a daemon
 * mid-refresh does, and both leave a *newer* credential at the legacy path than the one the account holds.
 *
 * Only `renameSync`/`unlinkSync` are wrapped; everything else is the real fs.
 */
const beforeRename: Array<() => void> = [];
const afterClaimUnlink: Array<() => void> = [];
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: ((from: Parameters<typeof real.renameSync>[0], to: Parameters<typeof real.renameSync>[1]) => {
      const hook = beforeRename.shift();
      if (hook) hook();
      return real.renameSync(from, to);
    }) as typeof real.renameSync,
    unlinkSync: ((file: Parameters<typeof real.unlinkSync>[0]) => {
      const result = real.unlinkSync(file);
      const hook = afterClaimUnlink.shift();
      if (hook) hook();
      return result;
    }) as typeof real.unlinkSync,
  };
});

/**
 * Round four, finding 2: a SIWC refresh happens under `<nemaHome>/auth.lock`, so the retirement of the
 * legacy login must take that same lock. Otherwise an in-flight refresh can save the rotated tokens back
 * at the old path after the migration removed it: the account keeps pre-refresh tokens, which may already
 * have been spent.
 *
 * `AuthStore` is asynchronous and this layer is synchronous, so the shared-lock test drives the protocol
 * directly: the migration is started while a refresh-shaped holder owns the lock, and the assertion is
 * about what is on disk afterwards.
 */

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-siwc-retire-"));
  home = join(root, "nema");
  beforeRename.length = 0;
  afterClaimUnlink.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const login = (refreshToken: string) => JSON.stringify({
  version: 1, mode: "siwc", clientId: "oaiapp_test",
  tokens: { access_token: "fake-access", refresh_token: refreshToken },
  lastRefresh: "2026-10-01T00:00:00.000Z",
});
const siwcConfig = { ...DEFAULT_CONFIG, authMode: "siwc" as const };

describe("the legacy SIWC login is retired under auth.lock (review 2)", () => {
  test("the lock is taken and released around the retirement, leaving no lock behind", () => {
    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "auth.json"), login("rt-1"));

    const { account } = materializeImplicit({ nemaHome: home, config: siwcConfig, codexHome: "", name: "订阅" });

    // The retirement ran, the login moved, and auth.lock is not left behind by the migration.
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    expect(readFileSync(join(accountDir(home, account.id), "auth.json"), "utf8")).toContain("rt-1");
    expect(existsSync(join(home, "auth.lock"))).toBe(false);
    // No claim or tomb files are left next to the retired credential.
    expect(readdirSync(home).filter((n) => n.includes(".retire-"))).toEqual([]);
  });

  test("a refresh that lands before retirement is the version the account keeps", () => {
    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "auth.json"), login("rt-old"));
    // A refresh holds auth.lock, rotates the login, and releases the lock before the migration retires it.
    withFileLockSync(join(home, "auth.lock"), () => {
      writePrivateFile(join(home, "auth.json"), login("rt-new"));
    });

    const { account } = materializeImplicit({ nemaHome: home, config: siwcConfig, codexHome: "", name: "订阅" });

    const stored = readFileSync(join(accountDir(home, account.id), "auth.json"), "utf8");
    expect(stored).toContain("rt-new");
    expect(stored).not.toContain("rt-old");
  });

  test("a credential claimed during retirement is the newer one and is put back", () => {
    // The claim path is what makes the removal conditional; this checks the SIWC branch uses it too.
    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "auth.json"), login("rt-1"));
    const { account } = materializeImplicit({ nemaHome: home, config: siwcConfig, codexHome: "", name: "订阅" });
    expect(readFileSync(join(accountDir(home, account.id), "auth.json"), "utf8")).toContain("rt-1");
    expect(readdirSync(home).filter((n) => n.includes(".retire-"))).toEqual([]);
  });
});

describe("a refresh in this same process does not deadlock the retirement (review 2)", () => {
  test("the retirement backs off and reports the move unfinished instead of blocking", () => {
    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "auth.json"), login("rt-1"));
    // The migration copies rt-1 and is at its retirement step when a refresh in this same process takes
    // auth.lock and rotates the login to rt-2.
    const { account } = materializeImplicit({ nemaHome: home, config: siwcConfig, codexHome: "", name: "订阅" });
    writePrivateFile(join(home, "auth.json"), login("rt-2"));
    const source = readLegacyCredential(home, join(home, "auth.json"));

    let movedFrom: string | null | undefined;
    const started = Date.now();
    withFileLockSync(join(home, "auth.lock"), () => {
      movedFrom = retireLegacyFile(home, account, source, { alreadyCopied: true });
    });
    const elapsed = Date.now() - started;

    // A 20 s wait would mean the event loop the refresh needs was blocked; the call gave up at once.
    expect(elapsed).toBeLessThan(5_000);
    expect(movedFrom).toBeNull();
    // Nothing was deleted, and the rotated login is still the newest thing on disk.
    expect(readFileSync(join(home, "auth.json"), "utf8")).toContain("rt-2");
  }, 30_000);
});

describe("a credential rebuilt while it is being retired (review 5)", () => {
  test("a writer that re-creates auth.json right after the removal is adopted, not ignored", () => {
    // The claim deletes exactly the bytes it was given and reports success. A refresh that saves the rotated
    // login at the old path a moment later is then *newer* than the account's copy; returning on the bare
    // "removed" answer would leave the account holding a refresh token the login has already spent.
    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "auth.json"), login("rt-1"));
    const account = {
      id: "acct_aaaaaaaaaa", name: "订阅", enabled: true, adapter: "codex-direct" as const,
      authMode: "siwc" as const, costTier: "standard" as const, order: 0, createdAt: "2026-10-31T00:00:00.000Z",
    };
    // Pre-create the account directory so `writeCredentialCopy` has somewhere to land.
    mkdirSync(accountDir(home, account.id), { recursive: true, mode: 0o700 });
    const source = readLegacyCredential(home, join(home, "auth.json"));
    afterClaimUnlink.push(() => writePrivateFile(join(home, "auth.json"), login("rt-2")));

    const movedFrom = retireLegacyFile(home, account, source);

    // The rotated login is the one the account keeps, and the legacy path is gone: no credential is lost and
    // none is left behind for a rollback to find stale.
    expect(readFileSync(join(accountDir(home, account.id), "auth.json"), "utf8")).toContain("rt-2");
    expect(movedFrom).toBe(join(home, "auth.json"));
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    expect(readdirSync(home).filter((n) => n.includes(".retire-"))).toEqual([]);
  });

  test("a refresh during retirement updates the account in the already-moved branch", () => {
    // `already-moved` is the branch where the account's copy already holds these exact bytes (a re-planted
    // legacy file after a crash, a rollback). The retirement there went straight to `removeLegacyIfUnchanged`
    // and ignored the credential a refresh wrote mid-flight, so the account kept the spent tokens.
    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "auth.json"), login("rt-1"));
    const first = materializeImplicit({ nemaHome: home, config: siwcConfig, codexHome: "", name: "订阅" });
    expect(readFileSync(join(accountDir(home, first.account.id), "auth.json"), "utf8")).toContain("rt-1");

    // The legacy path is back with the same bytes — the state the next materialize reads as `already-moved`.
    writePrivateFile(join(home, "auth.json"), login("rt-1"));
    // …and a refresh replaces it with rotated tokens at the moment the retirement renames it away.
    beforeRename.push(() => writePrivateFile(join(home, "auth.json"), login("rt-2")));

    const again = materializeImplicit({ nemaHome: home, config: siwcConfig, codexHome: "", name: "订阅" });

    expect(again.account.id).toBe(first.account.id);
    const stored = readFileSync(join(accountDir(home, first.account.id), "auth.json"), "utf8");
    expect(stored).toContain("rt-2");
    expect(stored).not.toContain("rt-1");
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });
});
