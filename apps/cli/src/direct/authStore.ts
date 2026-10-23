import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { jwtExp } from "./jwt.js";
import { LockTimeoutError, withFileLock, type LockOptions } from "./lock.js";

// Nema's own direct-mode login (`<nemaHome>/auth.json`). Never reads or links ~/.codex/auth.json.

export const REFRESH_SKEW_MS = 120_000;
export const TERMINAL_CODES = [
  "invalid_grant",
  "invalid_client",
  "invalid_token",
  "refresh_token_reused",
  "refresh_token_expired",
  "refresh_token_invalidated",
] as const;
export const RELOGIN_MESSAGE = "直连登录已失效，请在终端运行 nema auth login";
/** The file exists but cannot be trusted or parsed (wrong permissions, symlink, not ours, corrupt). */
export const UNUSABLE_FILE_MESSAGE = "凭证文件不可用（权限/符号链接/损坏），请重新运行 nema auth login";

const StoredAuthSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["siwc", "compat"]),
  clientId: z.string(),
  tokens: z.object({ access_token: z.string(), refresh_token: z.string(), id_token: z.string().optional() }),
  accountId: z.string().optional(),
  lastRefresh: z.string(),
  lastAuthError: z.object({ code: z.string(), message: z.string(), at: z.string() }).optional(),
});

export type StoredAuth = {
  version: 1;
  mode: "siwc" | "compat" | "byok";
  clientId: string;
  tokens: { access_token: string; refresh_token: string; id_token?: string };
  accountId?: string;
  lastRefresh: string;
  lastAuthError?: { code: string; message: string; at: string };
};

export type RefreshResult = { access_token: string; refresh_token?: string; id_token?: string };
/**
 * Exchanges `auth.tokens.refresh_token`; throws RefreshError on an HTTP error response. `signal` aborts when
 * AuthStore gives up waiting (refresh deadline), so the refresher should pass it to its HTTP request.
 */
export type Refresher = (auth: StoredAuth, signal?: AbortSignal) => Promise<RefreshResult>;

export const REFRESH_TIMEOUT_MS = 20_000;
export type AuthStoreOptions = { refreshTimeoutMs?: number; lock?: LockOptions };

type StatLike = { isFile(): boolean; mode: number; uid: number };
/** A credential file is trusted only if it is a regular file, mode 0600, and (where uids exist) owned by us. */
export function isTrustedAuthStat(st: StatLike, uid: number | null = process.getuid?.() ?? null): boolean {
  return st.isFile() && (st.mode & 0o777) === 0o600 && (uid === null || st.uid === uid);
}

export class RefreshError extends Error {
  readonly code?: string;
  readonly retryAfterS?: number;
  constructor(readonly status: number, opts: { code?: string; retryAfterS?: number; message?: string } = {}) {
    super(opts.message ?? `Token refresh failed: HTTP ${status}${opts.code ? ` (${opts.code})` : ""}`);
    this.name = "RefreshError";
    this.code = opts.code;
    this.retryAfterS = opts.retryAfterS;
  }
}

export class ReloginRequiredError extends Error {
  constructor(readonly code?: string, options?: ErrorOptions) {
    super(RELOGIN_MESSAGE, options);
    this.name = "ReloginRequiredError";
  }
}

export class AuthRateLimitedError extends Error {
  constructor(readonly retryAfterS?: number, options?: ErrorOptions) {
    super(`直连登录刷新被限流${retryAfterS !== undefined ? `，请约 ${retryAfterS} 秒后重试` : "，请稍后重试"}`, options);
    this.name = "AuthRateLimitedError";
  }
}

export class TransientAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransientAuthError";
  }
}

type AuthResult = { accessToken: string; auth: StoredAuth };
const result = (auth: StoredAuth): AuthResult => ({ accessToken: auth.tokens.access_token, auth });
const hasRefreshToken = (a: StoredAuth | null): a is StoredAuth => !!a && a.tokens.refresh_token !== "";
const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AuthStore {
  private readonly file: string;
  private readonly lockPath: string;

  constructor(
    private readonly nemaHome: string,
    private readonly refresher: Refresher,
    private readonly now: () => number = Date.now,
    private readonly opts: AuthStoreOptions = {},
  ) {
    this.file = path.join(nemaHome, "auth.json");
    this.lockPath = path.join(nemaHome, "auth.lock");
  }

  /** The stored login, or null if missing, a symlink, not a regular file, not 0600, not ours, or malformed. */
  read(): StoredAuth | null {
    return this.inspect().auth;
  }

  /** Like read(), but says why there is no login: "missing" (no file) or "unusable" (present but untrusted/corrupt). */
  inspect(): { auth: StoredAuth | null; reason?: "missing" | "unusable" } {
    try {
      if (!isTrustedAuthStat(lstatSync(this.file))) return { auth: null, reason: "unusable" };
      // O_NOFOLLOW + O_NONBLOCK: a symlink or FIFO swapped in after lstat neither redirects nor hangs the open;
      // fstat then re-checks the file we actually opened.
      const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw: string;
      try {
        if (!isTrustedAuthStat(fstatSync(fd))) return { auth: null, reason: "unusable" };
        raw = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
      const parsed = StoredAuthSchema.safeParse(JSON.parse(raw));
      return parsed.success ? { auth: parsed.data as StoredAuth } : { auth: null, reason: "unusable" };
    } catch (e) {
      return { auth: null, reason: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unusable" };
    }
  }

  /**
   * Records an auth problem in the file WITHOUT clearing the tokens (used when the model API rejects a token
   * that refreshing could not fix). Best effort: only if the file still holds the same refresh token.
   */
  async recordAuthError(reason: { code: string; message: string }, forAuth: StoredAuth): Promise<void> {
    try {
      await withFileLock(
        this.lockPath,
        async () => {
          const cur = this.read();
          if (!cur || cur.tokens.refresh_token !== forAuth.tokens.refresh_token) return;
          this.save({ ...cur, lastAuthError: { code: reason.code, message: reason.message, at: new Date(this.now()).toISOString() } });
        },
        { timeoutMs: 5_000, ...this.opts.lock },
      );
    } catch {
      /* diagnostics only */
    }
  }

  /** Atomic write (exclusive 0600 temp file + fsync + rename) under a 0700 directory. */
  save(auth: StoredAuth): void {
    mkdirSync(this.nemaHome, { recursive: true, mode: 0o700 });
    if (statSync(this.nemaHome).mode & 0o077) chmodSync(this.nemaHome, 0o700);
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      try {
        writeSync(fd, JSON.stringify(auth, null, 2) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file); // replaces a planted symlink rather than following it
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
    try {
      const dfd = openSync(this.nemaHome, "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      /* directory fsync is best effort */
    }
  }

  /** Without a reason: log out (delete the file). With a reason: drop the tokens and record lastAuthError. */
  clear(reason?: { code: string; message: string }): void {
    if (!reason) {
      try {
        unlinkSync(this.file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      return;
    }
    const base = this.read();
    if (base) this.save(this.cleared(base, reason));
  }

  /**
   * A valid access token, refreshing under auth.lock when it is within 120 s of expiry or when forced.
   * Pass the token the server just rejected as `rejectedAccessToken` with `force`: if a peer has already
   * replaced it on disk, that token is returned without a refresh POST.
   */
  async getAccessToken(opts: { force?: boolean; rejectedAccessToken?: string } = {}): Promise<AuthResult> {
    const held = this.read();
    if (!hasRefreshToken(held)) throw new ReloginRequiredError();
    const req = { force: !!opts.force, rejected: opts.rejectedAccessToken };
    if (this.usableWithoutRefresh(held, held, req)) return result(held);
    const refreshTimeoutMs = this.opts.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS;
    const lockOpts: LockOptions = { timeoutMs: Math.max(15_000, refreshTimeoutMs + 5_000), ...this.opts.lock };
    try {
      return await withFileLock(this.lockPath, () => this.refreshLocked(held, req), lockOpts);
    } catch (e) {
      if (e instanceof LockTimeoutError) throw new TransientAuthError("等待直连登录凭证锁超时，请稍后重试", { cause: e });
      throw e;
    }
  }

  private expiring(auth: StoredAuth): boolean {
    const exp = jwtExp(auth.tokens.access_token);
    return exp === null || exp * 1000 - this.now() < REFRESH_SKEW_MS;
  }

  // The normal refresh decision: an expiring token is never usable; otherwise usable unless forced, and a
  // forced call still takes a token that a peer has rotated in (new refresh token or a different access token
  // than the one rejected).
  private usableWithoutRefresh(auth: StoredAuth, held: StoredAuth, req: { force: boolean; rejected?: string }): boolean {
    if (this.expiring(auth)) return false;
    if (!req.force) return true;
    if (auth.tokens.refresh_token !== held.tokens.refresh_token) return true;
    return req.rejected !== undefined && auth.tokens.access_token !== req.rejected;
  }

  private cleared(base: StoredAuth, reason: { code: string; message: string }): StoredAuth {
    return {
      ...base,
      tokens: { access_token: "", refresh_token: "" },
      lastAuthError: { code: reason.code, message: reason.message, at: new Date(this.now()).toISOString() },
    };
  }

  // Runs with auth.lock held: re-read, adopt a peer's rotation, else refresh and persist before unlocking.
  private async refreshLocked(held: StoredAuth, req: { force: boolean; rejected?: string }): Promise<AuthResult> {
    const disk = this.read();
    if (!hasRefreshToken(disk)) throw new ReloginRequiredError();
    if (this.usableWithoutRefresh(disk, held, req)) return result(disk);
    return this.refreshWith(disk, 1);
  }

  private async callRefresher(auth: StoredAuth): Promise<RefreshResult> {
    const ms = this.opts.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS;
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new TransientAuthError(`刷新直连登录超时（${Math.round(ms / 1000)} 秒），请稍后重试`));
      }, ms);
    });
    try {
      return await Promise.race([this.refresher(auth, ac.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async refreshWith(disk: StoredAuth, retries: number): Promise<AuthResult> {
    let res: RefreshResult;
    try {
      res = await this.callRefresher(disk);
    } catch (e) {
      return this.onRefreshFailure(disk, e, retries);
    }
    if (!res || typeof res.access_token !== "string" || res.access_token === "") {
      throw new TransientAuthError("刷新响应缺少 access_token");
    }

    const idToken = res.id_token || disk.tokens.id_token;
    const next: StoredAuth = {
      ...disk,
      tokens: {
        access_token: res.access_token,
        refresh_token: res.refresh_token || disk.tokens.refresh_token,
        ...(idToken ? { id_token: idToken } : {}),
      },
      lastRefresh: new Date(this.now()).toISOString(),
    };
    delete next.lastAuthError;
    try {
      this.save(next);
    } catch (e) {
      // The old refresh token is already spent, so this is unrecoverable. Make sure it is not left on disk
      // for a later replay: the atomic path just failed, so overwrite the existing file in place — but only
      // if it still holds that spent token (never clobber a newer login, never recreate a deleted file).
      const current = this.read();
      if (current && current.tokens.refresh_token === disk.tokens.refresh_token) {
        this.overwriteInPlace(this.cleared(current, { code: "credential_persist_failed", message: errMessage(e) }));
      }
      throw new ReloginRequiredError("credential_persist_failed", { cause: e });
    }
    return result(next);
  }

  private async onRefreshFailure(failed: StoredAuth, e: unknown, retries: number): Promise<AuthResult> {
    if (e instanceof AuthRateLimitedError || e instanceof TransientAuthError) throw e;
    if (e instanceof RefreshError && e.status === 429) throw new AuthRateLimitedError(e.retryAfterS, { cause: e });

    const terminal =
      e instanceof ReloginRequiredError ||
      (e instanceof RefreshError &&
        (e.status === 401 || e.status === 403 || (TERMINAL_CODES as readonly string[]).includes(e.code ?? "")));
    if (!terminal) {
      if (e instanceof RefreshError) {
        throw new TransientAuthError(`刷新直连登录失败（HTTP ${e.status}），请稍后重试`, { cause: e });
      }
      throw new TransientAuthError(`刷新直连登录失败：${errMessage(e)}`, { cause: e });
    }

    const code =
      e instanceof ReloginRequiredError ? (e.code ?? "relogin_required") : `${(e as RefreshError).code ?? `http_${(e as RefreshError).status}`}`;
    const relogin = e instanceof ReloginRequiredError ? e : new ReloginRequiredError(code, { cause: e });
    const current = this.read();
    if (hasRefreshToken(current) && current.tokens.refresh_token !== failed.tokens.refresh_token) {
      // Newer tokens arrived meanwhile (e.g. a fresh login): keep them, and use them via the normal decision.
      if (!this.expiring(current)) return result(current);
      if (retries > 0) return this.refreshWith(current, retries - 1);
      throw relogin;
    }
    // Quarantine only the failed token, and only in a file we can read: a deleted (logged-out) or
    // unreadable file is left alone rather than recreated or overwritten.
    if (current && current.tokens.refresh_token === failed.tokens.refresh_token) {
      const next = this.cleared(current, { code, message: errMessage(e) });
      try {
        this.save(next);
      } catch {
        this.overwriteInPlace(next);
      }
    }
    throw relogin;
  }

  // Last-resort, non-atomic write into the existing regular file (no symlink following). Best effort.
  private overwriteInPlace(auth: StoredAuth): void {
    try {
      const fd = openSync(this.file, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
      try {
        writeSync(fd, JSON.stringify(auth, null, 2) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* nothing more can be done */
    }
  }
}
