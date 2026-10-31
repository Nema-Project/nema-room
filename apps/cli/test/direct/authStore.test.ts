import { expectPrivate, makePublic } from "../nativePermissions.js";
import { canSymlinkFiles } from "../links.js";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AuthRateLimitedError,
  AuthStore,
  RefreshError,
  ReloginRequiredError,
  TERMINAL_CODES,
  TransientAuthError,
  isTrustedAuthStat,
  type Refresher,
  type StoredAuth,
} from "../../src/direct/authStore.js";
import { withFileLock } from "../../src/direct/lock.js";
import { decodeJwtPayload, jwtExp } from "../../src/direct/jwt.js";

const RELOGIN_MSG = "直连登录已失效，请在终端运行 nema auth login";

const b64u = (s: string) => Buffer.from(s).toString("base64url");
function jwt(payload: Record<string, unknown>): string {
  return `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify(payload))}.sig`;
}
const tokenExpiringIn = (sec: number, tag = "a") => jwt({ exp: Math.floor(Date.now() / 1000) + sec, tag });

function auth(over: Partial<StoredAuth["tokens"]> = {}, extra: Partial<StoredAuth> = {}): StoredAuth {
  return {
    version: 1,
    mode: "siwc",
    clientId: "oaiapp_test",
    tokens: { access_token: tokenExpiringIn(3600), refresh_token: "rt-1", id_token: "idt", ...over },
    accountId: "acct-1",
    lastRefresh: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

let home: string;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-auth-test-"));
  home = join(root, "nema");
});
afterEach(() => {
  try { chmodSync(home, 0o700); } catch { /* may not exist */ }
  rmSync(root, { recursive: true, force: true });
});

const authFile = () => join(home, "auth.json");
const lockFile = () => join(home, "auth.lock");
const neverRefresh: Refresher = async () => { throw new Error("refresher must not be called"); };

describe("jwt", () => {
  test("decodes the payload without verifying and extracts exp", () => {
    const t = jwt({ exp: 123, sub: "x" });
    expect(decodeJwtPayload(t)).toEqual({ exp: 123, sub: "x" });
    expect(jwtExp(t)).toBe(123);
    expect(jwtExp(jwt({ sub: "x" }))).toBeNull();
    expect(jwtExp("not-a-jwt")).toBeNull();
    expect(() => decodeJwtPayload("a.b")).toThrow();
  });
});

describe("save / read / clear", () => {
  test("save writes 0600 under a 0700 dir and read round-trips", () => {
    const s = new AuthStore(home, neverRefresh);
    const a = auth();
    s.save(a);
    expectPrivate(authFile(), 0o600);
    expectPrivate(home, 0o700);
    expect(s.read()).toEqual(a);
  });

  test("read is null for a missing file, a symlink, 0644, corrupt JSON, or a wrong shape", () => {
    const s = new AuthStore(home, neverRefresh);
    expect(s.read()).toBeNull();
    mkdirSync(home, { recursive: true, mode: 0o700 });

    // Planting a file symlink needs privilege on Windows; without it only this link case is not exercised.
    if (canSymlinkFiles) {
      const real = join(root, "elsewhere.json");
      writeFileSync(real, JSON.stringify(auth()), { mode: 0o600 });
      symlinkSync(real, authFile());
      expect(s.read()).toBeNull();
      rmSync(authFile());
    }

    writeFileSync(authFile(), JSON.stringify(auth()), { mode: 0o644 });
    makePublic(authFile());
    expect(s.read()).toBeNull();
    rmSync(authFile());

    writeFileSync(authFile(), "{not json", { mode: 0o600 });
    expect(s.read()).toBeNull();
    rmSync(authFile());

    writeFileSync(authFile(), JSON.stringify({ version: 2, tokens: {} }), { mode: 0o600 });
    expect(s.read()).toBeNull();
    rmSync(authFile());

    mkdirSync(authFile());
    expect(s.read()).toBeNull();
  });

  test("inspect says why there is no login: missing vs unusable (perms, symlink, corrupt)", () => {
    const s = new AuthStore(home, neverRefresh);
    expect(s.inspect()).toEqual({ auth: null, reason: "missing" });
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(authFile(), JSON.stringify(auth()), { mode: 0o644 });
    makePublic(authFile());
    expect(s.inspect()).toEqual({ auth: null, reason: "unusable" });
    rmSync(authFile());
    writeFileSync(authFile(), "{not json", { mode: 0o600 });
    expect(s.inspect()).toEqual({ auth: null, reason: "unusable" });
    rmSync(authFile());
    if (canSymlinkFiles) { // see the note in the previous test
      const real = join(root, "elsewhere.json");
      writeFileSync(real, JSON.stringify(auth()), { mode: 0o600 });
      symlinkSync(real, authFile());
      expect(s.inspect().reason).toBe("unusable");
      rmSync(authFile());
    }
    // Pin the clock across a second boundary: auth() embeds Date.now() in the token's exp.
    let tick = 1_799_999_999_999;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => tick++);
    try {
      const saved = auth();
      s.save(saved);
      expect(s.inspect()).toEqual({ auth: saved, reason: undefined });
    } finally {
      clock.mockRestore();
    }
  });

  test("recordAuthError keeps the tokens and records lastAuthError; ignores a different refresh token", async () => {
    const s = new AuthStore(home, neverRefresh);
    s.save(auth());
    await s.recordAuthError({ code: "model_unauthorized", message: "x" }, auth({ refresh_token: "other" }));
    expect(s.read()!.lastAuthError).toBeUndefined();
    await s.recordAuthError({ code: "model_unauthorized", message: "x" }, auth());
    const d = s.read()!;
    expect(d.lastAuthError?.code).toBe("model_unauthorized");
    expect(d.tokens.refresh_token).toBe("rt-1");
  });

  // A file symlink needs privilege on Windows, so this runs only where one can be created.
  test.runIf(canSymlinkFiles)("save replaces a planted symlink instead of writing through it", () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const target = join(root, "victim.txt");
    writeFileSync(target, "untouched");
    symlinkSync(target, authFile());
    new AuthStore(home, neverRefresh).save(auth());
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(lstatSync(authFile()).isSymbolicLink()).toBe(false);
  });

  test("clear() removes the file; clear(reason) drops tokens and records lastAuthError", () => {
    const s = new AuthStore(home, neverRefresh);
    s.save(auth());
    s.clear({ code: "x", message: "y" });
    const after = s.read()!;
    expect(after.tokens.access_token).toBe("");
    expect(after.tokens.refresh_token).toBe("");
    expect(after.lastAuthError).toMatchObject({ code: "x", message: "y" });
    s.clear();
    expect(existsSync(authFile())).toBe(false);
  });
});

describe("owner cancellation", () => {
  test("a refresh rotation received before cancellation is persisted before abort is reported", async () => {
    const controller = new AbortController();
    const store = new AuthStore(home, async (_held, signal) => {
      void signal;
      controller.abort(new DOMException("owner closed after refresh", "AbortError"));
      return { access_token: "late-access", refresh_token: "late-refresh" };
    });
    const original = auth({ access_token: tokenExpiringIn(0), refresh_token: "original-refresh" });
    store.save(original);
    const pending = store.getAccessToken({ signal: controller.signal });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(store.read()?.tokens).toMatchObject({ access_token: "late-access", refresh_token: "late-refresh" });
  });
});

describe("getAccessToken", () => {
  test("missing login → ReloginRequiredError", async () => {
    const err = await new AuthStore(home, neverRefresh).getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(ReloginRequiredError);
    expect(err.message).toBe(RELOGIN_MSG);
  });

  test("an unexpired token is returned without refreshing", async () => {
    const a = auth();
    const s = new AuthStore(home, neverRefresh);
    s.save(a);
    const r = await s.getAccessToken();
    expect(r.accessToken).toBe(a.tokens.access_token);
    expect(r.auth).toEqual(a);
  });

  test("within 120 s of expiry it refreshes, rotates the refresh token, and persists", async () => {
    const fresh = tokenExpiringIn(3600, "new");
    const refresher = vi.fn<Refresher>(async () => ({ access_token: fresh, refresh_token: "rt-2", id_token: "idt-2" }));
    const now = Date.parse("2026-10-22T10:00:00.000Z");
    const s = new AuthStore(home, refresher, () => now);
    s.save(auth({ access_token: jwt({ exp: Math.floor(now / 1000) + 119 }) }));
    const r = await s.getAccessToken();
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(refresher.mock.calls[0]![0].tokens.refresh_token).toBe("rt-1");
    expect(r.accessToken).toBe(fresh);
    const disk = s.read()!;
    expect(disk.tokens).toEqual({ access_token: fresh, refresh_token: "rt-2", id_token: "idt-2" });
    expect(disk.lastRefresh).toBe("2026-10-22T10:00:00.000Z");
    expect(disk.accountId).toBe("acct-1");
    expectPrivate(authFile(), 0o600);
    expect(existsSync(lockFile())).toBe(false);
  });

  test("121 s before expiry no refresh happens", async () => {
    const now = Date.parse("2026-10-22T10:00:00.000Z");
    const s = new AuthStore(home, neverRefresh, () => now);
    s.save(auth({ access_token: jwt({ exp: Math.floor(now / 1000) + 121 }) }));
    await expect(s.getAccessToken()).resolves.toBeTruthy();
  });

  test("keeps the old refresh token (and id token) when the response has none", async () => {
    const fresh = tokenExpiringIn(3600, "new");
    const s = new AuthStore(home, async () => ({ access_token: fresh }));
    s.save(auth({ access_token: tokenExpiringIn(10) }));
    await s.getAccessToken();
    expect(s.read()!.tokens).toEqual({ access_token: fresh, refresh_token: "rt-1", id_token: "idt" });
  });

  test("force refreshes an unexpired token and clears a previous lastAuthError", async () => {
    const fresh = tokenExpiringIn(3600, "new");
    const refresher = vi.fn<Refresher>(async () => ({ access_token: fresh, refresh_token: "rt-2" }));
    const s = new AuthStore(home, refresher);
    s.save(auth({}, { lastAuthError: { code: "old", message: "old", at: "2026-10-01T00:00:00.000Z" } }));
    expect((await s.getAccessToken({ force: true })).accessToken).toBe(fresh);
    expect(refresher).toHaveBeenCalledTimes(1);
    expect(s.read()!.lastAuthError).toBeUndefined();
  });

  test("adopts a peer-rotated token found on disk under the lock without calling the refresher", async () => {
    const s = new AuthStore(home, neverRefresh);
    s.save(auth({ access_token: tokenExpiringIn(10) }));
    const peerToken = tokenExpiringIn(3600, "peer");
    let pending!: Promise<{ accessToken: string; auth: StoredAuth }>;
    await withFileLock(lockFile(), async () => {
      pending = s.getAccessToken({ force: true }); // reads rt-1 now, then blocks on the lock
      await new Promise((r) => setTimeout(r, 60));
      new AuthStore(home, neverRefresh).save(auth({ access_token: peerToken, refresh_token: "rt-peer" }));
    });
    const r = await pending;
    expect(r.accessToken).toBe(peerToken);
    expect(r.auth.tokens.refresh_token).toBe("rt-peer");
  });

  const terminal: Array<[string, RefreshError, string]> = [
    ...TERMINAL_CODES.map((c): [string, RefreshError, string] => [c, new RefreshError(400, { code: c }), c]),
    ["invalid_client (literal)", new RefreshError(400, { code: "invalid_client" }), "invalid_client"],
    ["401", new RefreshError(401), "http_401"],
    ["403", new RefreshError(403), "http_403"],
  ];
  test.each(terminal)("terminal %s → tokens cleared, lastAuthError recorded, ReloginRequiredError", async (_n, rerr, code) => {
    const refresher = vi.fn<Refresher>(async () => { throw rerr; });
    const s = new AuthStore(home, refresher);
    s.save(auth({ access_token: tokenExpiringIn(10) }));
    const err = await s.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(ReloginRequiredError);
    expect(err.message).toBe(RELOGIN_MSG);
    const disk = s.read()!;
    expect(disk.tokens.access_token).toBe("");
    expect(disk.tokens.refresh_token).toBe("");
    expect(disk.lastAuthError?.code).toBe(code);
    expect(disk.clientId).toBe("oaiapp_test");
    // The spent refresh token is never replayed.
    await expect(s.getAccessToken({ force: true })).rejects.toBeInstanceOf(ReloginRequiredError);
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  test("a terminal error does not clear newer tokens already on disk", async () => {
    const newer = tokenExpiringIn(3600, "newer");
    const s = new AuthStore(home, async () => {
      new AuthStore(home, neverRefresh).save(auth({ access_token: newer, refresh_token: "rt-newer" }));
      throw new RefreshError(400, { code: "refresh_token_reused" });
    });
    s.save(auth({ access_token: tokenExpiringIn(10) }));
    const r = await s.getAccessToken();
    expect(r.accessToken).toBe(newer);
    const disk = s.read()!;
    expect(disk.tokens.refresh_token).toBe("rt-newer");
    expect(disk.lastAuthError).toBeUndefined();
  });

  test("429 → AuthRateLimitedError with retryAfterS; tokens kept", async () => {
    const s = new AuthStore(home, async () => { throw new RefreshError(429, { retryAfterS: 30 }); });
    const a = auth({ access_token: tokenExpiringIn(10) });
    s.save(a);
    const err = await s.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthRateLimitedError);
    expect(err.retryAfterS).toBe(30);
    expect(s.read()).toEqual(a);
  });

  test.each([
    ["500", () => new RefreshError(500)],
    ["502 with unknown code", () => new RefreshError(502, { code: "server_error" })],
    ["400 non-terminal code", () => new RefreshError(400, { code: "invalid_request_x" })],
    ["network failure", () => new TypeError("fetch failed")],
  ])("%s → TransientAuthError; tokens kept", async (_n, mk) => {
    const s = new AuthStore(home, async () => { throw mk(); });
    const a = auth({ access_token: tokenExpiringIn(10) });
    s.save(a);
    await expect(s.getAccessToken()).rejects.toBeInstanceOf(TransientAuthError);
    expect(s.read()).toEqual(a);
  });

  test("a response without an access token → TransientAuthError", async () => {
    const s = new AuthStore(home, async () => ({ access_token: "" }));
    s.save(auth({ access_token: tokenExpiringIn(10) }));
    await expect(s.getAccessToken()).rejects.toBeInstanceOf(TransientAuthError);
  });

  test("persist failure after a successful refresh → credential_persist_failed (terminal)", async () => {
    const s = new AuthStore(home, async () => ({ access_token: tokenExpiringIn(3600, "lost"), refresh_token: "rt-lost" }));
    s.save(auth({ access_token: tokenExpiringIn(10) }));
    vi.spyOn(s, "save").mockImplementation(() => { throw new Error("simulated disk failure"); });
    const err = await s.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(ReloginRequiredError);
    expect(err.message).toBe(RELOGIN_MSG);
    expect(err.code).toBe("credential_persist_failed");
    const disk = s.read()!;
    expect(disk.tokens.refresh_token).toBe(""); // the spent rt-1 is not left behind for a replay
    expect(disk.lastAuthError?.code).toBe("credential_persist_failed");
  });
});

describe("review fixes", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("a refresh slower than staleMs is not taken over: the waiting peer adopts instead of replaying rt-1", async () => {
    const posted: string[] = [];
    const lock = { staleMs: 150, pollMs: 10 };
    const fresh = tokenExpiringIn(3600, "slow");
    const a = new AuthStore(home, async (au) => {
      posted.push(au.tokens.refresh_token);
      await sleep(450); // 3x staleMs
      return { access_token: fresh, refresh_token: "rt-2" };
    }, Date.now, { lock });
    const b = new AuthStore(home, async (au) => {
      posted.push(au.tokens.refresh_token);
      return { access_token: tokenExpiringIn(3600, "b"), refresh_token: "rt-3" };
    }, Date.now, { lock });
    a.save(auth());
    const pa = a.getAccessToken({ force: true });
    await sleep(30);
    const pb = b.getAccessToken({ force: true }); // holds rt-1 in hand, waits on the lock
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(posted).toEqual(["rt-1"]);
    expect(ra.accessToken).toBe(fresh);
    expect(rb.accessToken).toBe(fresh);
  });

  test("the refresher has a deadline: timeout → TransientAuthError, signal aborted, nothing persisted", async () => {
    let aborted = false;
    const s = new AuthStore(home, (_au, signal) => new Promise((_, reject) => {
      signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    }), Date.now, { refreshTimeoutMs: 100 });
    const a = auth({ access_token: tokenExpiringIn(10) });
    s.save(a);
    const err = await s.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(TransientAuthError);
    expect(aborted).toBe(true);
    expect(s.read()).toEqual(a);
    expect(existsSync(lockFile())).toBe(false);
  });

  test("a ReloginRequiredError from the refresher is rethrown unchanged and quarantines the token", async () => {
    const thrown = new ReloginRequiredError("custom_code");
    const s = new AuthStore(home, async () => { throw thrown; });
    s.save(auth({ access_token: tokenExpiringIn(10) }));
    expect(await s.getAccessToken().catch((e) => e)).toBe(thrown);
    const disk = s.read()!;
    expect(disk.tokens.refresh_token).toBe("");
    expect(disk.lastAuthError?.code).toBe("custom_code");

    const s2home = join(root, "nema2");
    const s2 = new AuthStore(s2home, async () => { throw new ReloginRequiredError(); });
    s2.save(auth({ access_token: tokenExpiringIn(10) }));
    await expect(s2.getAccessToken()).rejects.toBeInstanceOf(ReloginRequiredError);
    expect(s2.read()!.lastAuthError?.code).toBe("relogin_required");
  });

  test("an AuthRateLimitedError from the refresher is rethrown unchanged; tokens kept", async () => {
    const thrown = new AuthRateLimitedError(42);
    const s = new AuthStore(home, async () => { throw thrown; });
    const a = auth({ access_token: tokenExpiringIn(10) });
    s.save(a);
    expect(await s.getAccessToken().catch((e) => e)).toBe(thrown);
    expect(s.read()).toEqual(a);
  });

  test("rejectedAccessToken: a token already replaced on disk is returned without a POST", async () => {
    const old = auth().tokens.access_token;
    const fresh = tokenExpiringIn(3600, "fresh");
    const a = new AuthStore(home, async () => ({ access_token: fresh, refresh_token: "rt-2" }));
    a.save(auth());
    await a.getAccessToken({ force: true, rejectedAccessToken: old });
    const b = new AuthStore(home, neverRefresh); // reads only after the rotation
    expect((await b.getAccessToken({ force: true, rejectedAccessToken: old })).accessToken).toBe(fresh);

    const posted = vi.fn<Refresher>(async () => ({ access_token: tokenExpiringIn(3600, "again") }));
    const c = new AuthStore(home, posted);
    await c.getAccessToken({ force: true, rejectedAccessToken: fresh }); // disk token is the rejected one
    expect(posted).toHaveBeenCalledTimes(1);
  });

  test("two concurrent 401-forced callers → exactly one POST even without refresh-token rotation", async () => {
    const old = auth().tokens.access_token;
    const fresh = tokenExpiringIn(3600, "fresh");
    let posts = 0;
    const refresher: Refresher = async () => { posts++; await sleep(100); return { access_token: fresh }; };
    const a = new AuthStore(home, refresher);
    const b = new AuthStore(home, refresher);
    a.save(auth());
    const [ra, rb] = await Promise.all([
      a.getAccessToken({ force: true, rejectedAccessToken: old }),
      b.getAccessToken({ force: true, rejectedAccessToken: old }),
    ]);
    expect(posts).toBe(1);
    expect(ra.accessToken).toBe(fresh);
    expect(rb.accessToken).toBe(fresh);
  });

  test("a terminal error never recreates a deleted (logged-out) auth.json", async () => {
    const s = new AuthStore(home, async () => { s.clear(); throw new RefreshError(401); });
    s.save(auth({ access_token: tokenExpiringIn(10) }));
    await expect(s.getAccessToken()).rejects.toBeInstanceOf(ReloginRequiredError);
    expect(existsSync(authFile())).toBe(false);
  });

  test("a terminal error never overwrites an unreadable/corrupt auth.json", async () => {
    const s = new AuthStore(home, async () => {
      writeFileSync(authFile(), "{corrupt", { mode: 0o600 });
      throw new RefreshError(400, { code: "invalid_grant" });
    });
    s.save(auth({ access_token: tokenExpiringIn(10) }));
    await expect(s.getAccessToken()).rejects.toBeInstanceOf(ReloginRequiredError);
    expect(readFileSync(authFile(), "utf8")).toBe("{corrupt");
  });

  test("newer-but-expired tokens on disk after a terminal error go through a normal refresh", async () => {
    const fresh = tokenExpiringIn(3600, "fresh");
    const posted: string[] = [];
    const s = new AuthStore(home, async (au) => {
      posted.push(au.tokens.refresh_token);
      if (posted.length === 1) {
        new AuthStore(home, neverRefresh).save(auth({ access_token: tokenExpiringIn(-60), refresh_token: "rt-newer" }));
        throw new RefreshError(401);
      }
      return { access_token: fresh, refresh_token: "rt-3" };
    });
    s.save(auth({ access_token: tokenExpiringIn(10) }));
    const r = await s.getAccessToken();
    expect(posted).toEqual(["rt-1", "rt-newer"]);
    expect(r.accessToken).toBe(fresh);
    expect(s.read()!.tokens.refresh_token).toBe("rt-3");
  });

  test("isTrustedAuthStat (used on both lstat and the opened fd's fstat) checks type, mode and owner", () => {
    const st = (over: Partial<{ file: boolean; mode: number; uid: number }> = {}) => ({
      isFile: () => over.file ?? true, mode: 0o100000 | (over.mode ?? 0o600), uid: over.uid ?? 501,
    });
    // Pinned to linux: on Windows mode bits are synthetic and the DACL is checked when the file is opened.
    expect(isTrustedAuthStat(st(), 501, "linux")).toBe(true);
    expect(isTrustedAuthStat(st(), null, "linux")).toBe(true); // no uids on this platform
    expect(isTrustedAuthStat(st({ file: false }), 501, "linux")).toBe(false);
    expect(isTrustedAuthStat(st({ mode: 0o644 }), 501, "linux")).toBe(false);
    expect(isTrustedAuthStat(st({ mode: 0o640 }), 501, "linux")).toBe(false);
    expect(isTrustedAuthStat(st({ uid: 0 }), 501, "linux")).toBe(false);
    expect(isTrustedAuthStat(st({ mode: 0o644 }), null, "win32")).toBe(true);
    expect(isTrustedAuthStat(st({ file: false }), null, "win32")).toBe(false);
  });

  test("a FIFO at auth.json is rejected without hanging", () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", ["-m", "600", authFile()]);
    expect(new AuthStore(home, neverRefresh).read()).toBeNull();
  });
});

describe("cross-process refresh", () => {
  const cliDir = fileURLToPath(new URL("../..", import.meta.url));
  const worker = fileURLToPath(new URL("../fixtures/refresh-worker.mjs", import.meta.url));
  let server: Server | undefined;
  const children: ChildProcess[] = [];
  afterEach(async () => {
    for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  function startChild(url: string) {
    const child = spawn(process.execPath, ["--import", "tsx", worker, home, url], { cwd: cliDir, stdio: ["pipe", "pipe", "pipe"] });
    children.push(child);
    let out = "";
    let errOut = "";
    child.stderr!.on("data", (d) => (errOut += d));
    const lines: string[] = [];
    const waiters: Array<() => void> = [];
    child.stdout!.on("data", (d) => {
      out += d;
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        lines.push(out.slice(0, i));
        out = out.slice(i + 1);
        waiters.splice(0).forEach((w) => w());
      }
    });
    const nextLine = (idx: number, ms: number) =>
      new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`child timed out; stderr: ${errOut}`)), ms);
        const check = () => {
          if (lines.length > idx) { clearTimeout(t); resolve(lines[idx]!); }
          else if (child.exitCode !== null) { clearTimeout(t); reject(new Error(`child exited ${child.exitCode}; stderr: ${errOut}`)); }
          else waiters.push(check);
        };
        child.on("exit", () => waiters.splice(0).forEach((w) => w()));
        check();
      });
    return { child, nextLine };
  }

  test("two processes force-refresh at once: exactly one POST, both get the same new token", async () => {
    const newAccess = tokenExpiringIn(3600, "rotated");
    const seen: string[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        seen.push(JSON.parse(body).refresh_token);
        // Hold the response so the peer is certainly queued on the lock with the old token in hand.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: newAccess, refresh_token: "rt-2" }));
        }, 800);
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/token`;

    new AuthStore(home, neverRefresh).save(auth());
    const a = startChild(url);
    const b = startChild(url);
    expect(await a.nextLine(0, 20_000)).toBe("ready");
    expect(await b.nextLine(0, 20_000)).toBe("ready");
    a.child.stdin!.write("go\n");
    b.child.stdin!.write("go\n");
    const [ra, rb] = (await Promise.all([a.nextLine(1, 20_000), b.nextLine(1, 20_000)])).map((l) => JSON.parse(l));

    expect(ra).toEqual({ ok: true, accessToken: newAccess, refreshToken: "rt-2" });
    expect(rb).toEqual({ ok: true, accessToken: newAccess, refreshToken: "rt-2" });
    expect(seen).toEqual(["rt-1"]);
    expect(new AuthStore(home, neverRefresh).read()!.tokens.refresh_token).toBe("rt-2");
    expect(existsSync(lockFile())).toBe(false);
  }, 45_000);
});

describe("AuthStore under an account directory", () => {
  test("keeps auth.json and auth.lock in baseDir and nothing in nemaHome", () => {
    const root = mkdtempSync(join(tmpdir(), "nema-authstore-home-"));
    const accountDir = join(root, "secrets", "accounts", "acct_abc1234567");
    mkdirSync(accountDir, { recursive: true, mode: 0o700 });
    const store = new AuthStore(root, async () => ({ access_token: tokenExpiringIn(3600) }), Date.now, { baseDir: accountDir });

    store.save(auth());

    expect(existsSync(join(accountDir, "auth.json"))).toBe(true);
    expect(existsSync(join(root, "auth.json"))).toBe(false);
    expect(store.read()?.tokens.refresh_token).toBe("rt-1");
  });

  test("two stores with different baseDirs keep separate logins", () => {
    const root = mkdtempSync(join(tmpdir(), "nema-authstore-two-"));
    const one = join(root, "one");
    const two = join(root, "two");
    mkdirSync(one, { recursive: true, mode: 0o700 });
    mkdirSync(two, { recursive: true, mode: 0o700 });
    const a = new AuthStore(root, async () => ({ access_token: tokenExpiringIn(3600) }), Date.now, { baseDir: one });
    const b = new AuthStore(root, async () => ({ access_token: tokenExpiringIn(3600) }), Date.now, { baseDir: two });

    a.save(auth({ refresh_token: "ra" }));
    b.save(auth({ refresh_token: "rb" }));

    expect(a.read()?.tokens.refresh_token).toBe("ra");
    expect(b.read()?.tokens.refresh_token).toBe("rb");
  });
});
