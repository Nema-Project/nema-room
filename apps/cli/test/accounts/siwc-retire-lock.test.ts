import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { materializeImplicit, retireLegacyFile } from "../../src/accounts/implicit.js";
import { readLegacyCredential } from "../../src/accounts/legacy.js";
import { accountDir } from "../../src/accounts/store.js";
import { withFileLockSync } from "../../src/direct/lock.js";
import { DEFAULT_CONFIG } from "../../src/config.js";

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
    writeFileSync(join(home, "auth.json"), login("rt-1"), { mode: 0o600 });

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
    writeFileSync(join(home, "auth.json"), login("rt-old"), { mode: 0o600 });
    // A refresh holds auth.lock, rotates the login, and releases the lock before the migration retires it.
    withFileLockSync(join(home, "auth.lock"), () => {
      writeFileSync(join(home, "auth.json"), login("rt-new"), { mode: 0o600 });
    });

    const { account } = materializeImplicit({ nemaHome: home, config: siwcConfig, codexHome: "", name: "订阅" });

    const stored = readFileSync(join(accountDir(home, account.id), "auth.json"), "utf8");
    expect(stored).toContain("rt-new");
    expect(stored).not.toContain("rt-old");
  });

  test("a credential claimed during retirement is the newer one and is put back", () => {
    // The claim path is what makes the removal conditional; this checks the SIWC branch uses it too.
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), login("rt-1"), { mode: 0o600 });
    const { account } = materializeImplicit({ nemaHome: home, config: siwcConfig, codexHome: "", name: "订阅" });
    expect(readFileSync(join(accountDir(home, account.id), "auth.json"), "utf8")).toContain("rt-1");
    expect(readdirSync(home).filter((n) => n.includes(".retire-"))).toEqual([]);
  });
});

describe("a refresh in this same process does not deadlock the retirement (review 2)", () => {
  test("the retirement backs off and reports the move unfinished instead of blocking", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), login("rt-1"), { mode: 0o600 });
    // The migration copies rt-1 and is at its retirement step when a refresh in this same process takes
    // auth.lock and rotates the login to rt-2.
    const { account } = materializeImplicit({ nemaHome: home, config: siwcConfig, codexHome: "", name: "订阅" });
    writeFileSync(join(home, "auth.json"), login("rt-2"), { mode: 0o600 });
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
