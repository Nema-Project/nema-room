import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  AuthStore,
  RefreshError,
  ReloginRequiredError,
  type RefreshResult,
  type Refresher,
  type StoredAuth,
} from "./authStore.js";
import { decodeJwtPayload } from "./jwt.js";
import { withFileLock } from "./lock.js";

/*
 * "Sign in with ChatGPT" (SIWC) token sharing for open-source tools — Nema's own login.
 * Never reads, copies or links ~/.codex/auth.json, and never identifies as codex_cli_rs.
 *
 * Official documentation (all fetched 2026-10-22; Markdown versions via the `.md` suffix):
 *   [SIGN-IN]   https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 *   [SESSIONS]  https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#refreshing-tokens
 *   [TOKENS]    https://developers.openai.com/siwc/token-sharing-open-source/token-reference
 *   [MODELS]    https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
 *   [ERRORS]    https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 *   [QUICK]     https://developers.openai.com/siwc/quickstart (overview only; no parameters)
 *
 * Authorization request [SIGN-IN] "2. Start authorization": open the system browser at
 *   https://auth.openai.com/api/accounts/authorize with (each value URL-encoded):
 *   client_id=dynamic_agent_client for first-time registration, else the saved issued client id;
 *   agent_name_hint (app's actual name, only on initial dynamic registration);
 *   ext_agent_host_id (required, distinct per host, stable; example form `urn:uuid:...`);
 *   id_token_hint / login_hint (optional, reauthorization only — Nema omits both: the hint would put an
 *     ID token into a URL that we print, and [SESSIONS] "Credential security" says to redact such URLs);
 *   response_type=code; redirect_uri (HTTP loopback on 127.0.0.1, path /auth/callback, only the port
 *     may vary, never `localhost`, start the listener before opening the browser, same URI in the
 *     exchange); scope = identity scopes `openid profile email` + plan scopes
 *     `offline_access resource.invoke chatgpt.tokens.use.direct`; resource=https://api.openai.com/v1;
 *   state and nonce (fresh random per attempt); code_challenge_method=S256;
 *   code_challenge = base64url(SHA-256(verifier)) without padding.
 * Callback [SIGN-IN] "3.": `error=access_denied` → validate state, stop, no exchange. New registration
 *   returns code, state and the issued `client_id` (form `oaiapp_...`); a new-registration callback
 *   without it means registration is incomplete. On reauthorization client_id may be omitted (keep the
 *   pending one); a different client_id must be rejected. Validate state before using anything.
 * Code exchange [SIGN-IN] "3.": POST form-encoded `authorization_code` grant to
 *   https://auth.openai.com/api/accounts/oauth/token with the issued client_id, code, code_verifier,
 *   the same redirect_uri and the same resource. No client secret. `invalid_grant` → discard the code
 *   and start a fresh authorization (never retry an exchange: the code is single-use).
 * Token response [TOKENS]: access_token, refresh_token (only with offline_access), id_token, token_type,
 *   expires_in (3600 — access tokens last one hour), scope, earliest_refresh_at. Refresh tokens last
 *   30 days and rotate on every refresh.
 * Validation [SIGN-IN] "Validate the ID token": verify signature against OpenAI's JWKS, issuer, audience
 *   (= issued client id), expiry and nonce; the validated `sub` is the account identity. Granted scopes
 *   must contain chatgpt.tokens.use.direct or plan usage is not authorized.
 *   NOTE: Nema checks iss/aud/exp/nonce/sub on the id_token it received directly from the token endpoint
 *   over TLS, but does NOT verify the JWKS signature (no JOSE dependency yet) — see the task report.
 * Refresh [SESSIONS] "Refreshing tokens": POST form-encoded grant_type=refresh_token, the issued
 *   client_id saved with this token set (not dynamic_agent_client), the saved refresh_token and
 *   resource=https://api.openai.com/v1 to https://auth.openai.com/api/accounts/oauth/token; omit scope to
 *   retain the grant. Store the latest replacement; serialize refreshes (AuthStore holds auth.lock).
 * Refresh errors [ERRORS] "Refresh errors": invalid_grant, invalid_refresh_token, token_expired,
 *   refresh_token_expired, refresh_token_invalidated, refresh_token_reused → clear tokens and repeat
 *   OAuth with the saved issued client id; invalid_client → fix the client configuration. Do not erase
 *   credentials over temporary network/infrastructure failures.
 * Models [MODELS] "1.": GET https://api.openai.com/v1/models with the access token as Bearer; response
 *   has a `models` array; keep `visibility == "list"` in server order; pass `slug` as `model`.
 * Inference [MODELS] "2.": POST https://api.openai.com/v1/responses, `Authorization: Bearer`, JSON;
 *   `store: false` and `stream: true` on every request; success only on `response.completed`;
 *   `response.failed` may carry subscription_sharing_usage_limit_exceeded (429) /
 *   subscription_sharing_usage_unavailable (503) [ERRORS]. Never ChatGPT `backend-api` endpoints.
 * Headers: the docs specify no custom headers. Nema identifies itself as `originator: nema-room` and
 *   `User-Agent: NemaRoom/<cli version>` (project rule), never codex_cli_rs.
 */
export const SIWC = {
  /** [SIGN-IN] first-time registration entrypoint; never saved or used for token exchange. */
  dynamicClientId: "dynamic_agent_client",
  /** [SIGN-IN] app's actual name, used consistently, only on initial registration. */
  agentNameHint: "Nema Room",
  /** [SIGN-IN] */
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
  /** [SIGN-IN] code exchange; [SESSIONS] refresh. */
  tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
  /** [TOKENS] access-token `iss` in production. */
  issuer: "https://auth.openai.com",
  /** [SIGN-IN] `resource` on authorize, exchange and refresh. */
  resource: "https://api.openai.com/v1",
  /** [SIGN-IN] identity scopes (needed for the id_token / account identity). */
  identityScopes: "openid profile email",
  /** [SIGN-IN] ChatGPT plan usage scopes. */
  planScopes: "offline_access resource.invoke chatgpt.tokens.use.direct",
  /** [SIGN-IN] the granted scope that authorizes plan usage. */
  planUsageScope: "chatgpt.tokens.use.direct",
  /** [SIGN-IN] loopback redirect `http://127.0.0.1:<port>/auth/callback`; only the port may vary. */
  callbackHost: "127.0.0.1",
  callbackPath: "/auth/callback",
  /** [SIGN-IN] example port. */
  defaultPort: 1455,
  /** [MODELS] */
  apiBase: "https://api.openai.com/v1",
  /** Project rule (not from the docs). */
  originator: "nema-room",
} as const;

/** [ERRORS] "Refresh errors": codes meaning the refresh token is unusable → re-login. */
export const UNUSABLE_REFRESH_CODES = [
  "invalid_grant",
  "invalid_client", // the saved client registration is gone: log in again with a NEW client
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
] as const;

const EXCHANGE_TIMEOUT_MS = 30_000;

let cachedVersion: string | undefined;
export function cliVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    // src/direct/siwc.ts and dist/direct/siwc.js both sit two levels below apps/cli/package.json.
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    cachedVersion = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export const nemaUserAgent = (): string => `NemaRoom/${cliVersion()}`;
export const nemaHeaders = (): Record<string, string> => ({ originator: SIWC.originator, "User-Agent": nemaUserAgent() });

/** This host's stable `ext_agent_host_id` ([SIGN-IN]: choose and persist it before the first sign-in). */
export function hostId(nemaHome: string): string {
  const file = path.join(nemaHome, "host-id");
  const readExisting = (): string | null => {
    try {
      const v = readFileSync(file, "utf8").trim();
      return v === "" ? null : v;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  };
  const existing = readExisting();
  if (existing) return existing;
  mkdirSync(nemaHome, { recursive: true, mode: 0o700 });
  const id = `urn:uuid:${randomUUID()}`;
  try {
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeSync(fd, id + "\n");
    } finally {
      closeSync(fd);
    }
    return id;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const raced = readExisting(); // a concurrent login created it first
    if (!raced) throw e;
    return raced;
  }
}

export type SiwcEndpoints = { authorizeUrl?: string; tokenUrl?: string };

export type SiwcLoginOptions = {
  nemaHome: string;
  /** Always called with the authorize URL; the caller also prints it. */
  openBrowser: (url: string) => void;
  /** Default 1455; when omitted and 1455 is busy an OS-assigned port is used ([SIGN-IN]: only the port may vary). */
  port?: number;
  /** Default 300000. */
  timeoutMs?: number;
  /** Test-only override of the auth.openai.com endpoints. */
  endpoints?: SiwcEndpoints;
};

const b64url = (buf: Buffer) => buf.toString("base64url");
const randomToken = () => b64url(randomBytes(32));

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => {
      server.off("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, SIWC.callbackHost); // loopback only
  });
}

async function startCallbackServer(server: Server, port: number | undefined): Promise<number> {
  const wanted = port ?? SIWC.defaultPort;
  try {
    return await listen(server, wanted);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE" && port === undefined) return listen(server, 0);
    if (code === "EADDRINUSE") throw new Error(`登录回调端口 ${SIWC.callbackHost}:${wanted} 已被占用，请换一个端口（--port）`, { cause: e });
    throw e;
  }
}

function page(res: ServerResponse, status: number, message: string): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  const esc = message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  res.end(`<!doctype html><meta charset="utf-8"><title>Nema Room</title><p>${esc}</p>`);
}

type Callback = { code: string; clientId: string; scope?: string; res: ServerResponse };

/** Waits for one request on the callback path, validating state ([SIGN-IN] "3."). */
function waitForCallback(
  server: Server,
  expected: { state: string; clientId?: string },
  timeoutMs: number,
): Promise<Callback> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`登录超时：${Math.round(timeoutMs / 1000)} 秒内未收到浏览器回调`))),
      timeoutMs,
    );
    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${SIWC.callbackHost}`);
      if (req.method !== "GET" || url.pathname !== SIWC.callbackPath) {
        res.writeHead(404).end();
        return;
      }
      if (done) {
        page(res, 409, "此登录请求已处理，可以关闭此页面。");
        return;
      }
      const q = url.searchParams;
      const fail = (status: number, msg: string) => {
        page(res, status, msg);
        finish(() => reject(new Error(msg)));
      };
      if (!safeEqual(q.get("state") ?? "", expected.state)) return fail(400, "登录失败：state 不匹配，已拒绝此回调");
      const error = q.get("error");
      if (error) return fail(400, `登录失败：授权服务器返回 ${error}${error === "access_denied" ? "（用户拒绝授权）" : ""}`);
      const code = q.get("code");
      if (!code) return fail(400, "登录失败：回调缺少 code");
      const returned = q.get("client_id") ?? undefined;
      let clientId: string;
      if (expected.clientId) {
        if (returned !== undefined && returned !== expected.clientId) {
          return fail(400, "登录失败：回调返回的 client_id 与已保存的注册不一致，已拒绝");
        }
        clientId = expected.clientId;
      } else {
        if (!returned || returned === SIWC.dynamicClientId) return fail(400, "登录失败：首次注册的回调缺少签发的 client_id，注册未完成");
        clientId = returned;
      }
      finish(() => resolve({ code, clientId, scope: q.get("scope") ?? undefined, res }));
    });
  });
}

type TokenResponse = { access_token: string; refresh_token: string; id_token?: string; scope?: string };

async function errorCode(res: Response): Promise<{ code?: string; detail?: string }> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error;
    if (typeof err === "string") return { code: err, detail: typeof body.error_description === "string" ? body.error_description : undefined };
    if (err && typeof err === "object") {
      const o = err as Record<string, unknown>;
      return {
        code: typeof o.code === "string" ? o.code : typeof o.type === "string" ? o.type : undefined,
        detail: typeof o.message === "string" ? o.message : undefined,
      };
    }
    if (typeof body.detail === "string") return { detail: body.detail }; // [ERRORS] admission failures
  } catch {
    /* not JSON */
  }
  return {};
}

async function exchangeCode(tokenUrl: string, form: Record<string, string>): Promise<TokenResponse> {
  // Single attempt: the authorization code is one-time ([SIGN-IN] "invalid_grant → discard the code").
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { ...nemaHeaders(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const { code, detail } = await errorCode(res);
    throw new Error(`换取令牌失败：HTTP ${res.status}${code ? ` ${code}` : ""}${detail ? `（${detail}）` : ""}`);
  }
  const body = (await res.json()) as Partial<Record<keyof TokenResponse, unknown>>;
  if (typeof body.access_token !== "string" || body.access_token === "") throw new Error("换取令牌失败：响应缺少 access_token");
  if (typeof body.refresh_token !== "string" || body.refresh_token === "") {
    throw new Error("换取令牌失败：响应缺少 refresh_token（未授予 offline_access）");
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    id_token: typeof body.id_token === "string" ? body.id_token : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
  };
}

/** Claim checks from [SIGN-IN] "Validate the ID token" (signature not verified — see header note). */
function validateIdToken(idToken: string | undefined, expected: { clientId: string; nonce: string; nowS: number }): string {
  if (!idToken) throw new Error("登录失败：令牌响应缺少 id_token");
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwtPayload(idToken);
  } catch {
    throw new Error("登录失败：id_token 无法解析");
  }
  if (claims.iss !== SIWC.issuer) throw new Error("登录失败：id_token 的 issuer 不符");
  const aud = claims.aud;
  const audOk = typeof aud === "string" ? aud === expected.clientId : Array.isArray(aud) && aud.includes(expected.clientId);
  if (!audOk) throw new Error("登录失败：id_token 的 audience 与签发的 client_id 不符");
  if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, expected.nonce)) throw new Error("登录失败：id_token 的 nonce 不匹配");
  if (typeof claims.exp === "number" && claims.exp <= expected.nowS) throw new Error("登录失败：id_token 已过期");
  if (typeof claims.sub !== "string" || claims.sub === "") throw new Error("登录失败：id_token 缺少 sub");
  return claims.sub;
}

function grantedScopes(tokens: TokenResponse, callbackScope?: string): string[] | null {
  if (tokens.scope !== undefined) return tokens.scope.split(/[\s+]+/).filter(Boolean);
  try {
    const s = decodeJwtPayload(tokens.access_token).scope;
    if (typeof s === "string") return s.split(/\s+/).filter(Boolean);
  } catch {
    /* opaque token */
  }
  return callbackScope !== undefined ? callbackScope.split(/[\s+]+/).filter(Boolean) : null;
}

/** Browser PKCE login ([SIGN-IN]); saves `<nemaHome>/auth.json` (mode "siwc") under auth.lock. */
export async function siwcLogin(opts: SiwcLoginOptions): Promise<StoredAuth> {
  const { nemaHome } = opts;
  const authorizeUrl = opts.endpoints?.authorizeUrl ?? SIWC.authorizeUrl;
  const tokenUrl = opts.endpoints?.tokenUrl ?? SIWC.tokenUrl;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const store = new AuthStore(nemaHome, siwcRefresher);

  const prior = store.read();
  // After an invalid_client failure the saved registration is dead: register a new client instead of reusing it.
  const savedClientId =
    prior &&
    prior.mode === "siwc" &&
    prior.clientId !== "" &&
    prior.clientId !== SIWC.dynamicClientId &&
    prior.lastAuthError?.code !== "invalid_client"
      ? prior.clientId
      : undefined;
  const extAgentHostId = hostId(nemaHome);
  const verifier = randomToken();
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = randomToken();
  const nonce = randomToken();

  const server = createServer();
  try {
    // [SIGN-IN] start the listener before opening the browser.
    const port = await startCallbackServer(server, opts.port);
    const redirectUri = `http://${SIWC.callbackHost}:${port}${SIWC.callbackPath}`;
    const params = new URLSearchParams({
      client_id: savedClientId ?? SIWC.dynamicClientId,
      ...(savedClientId ? {} : { agent_name_hint: SIWC.agentNameHint }),
      ext_agent_host_id: extAgentHostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: `${SIWC.identityScopes} ${SIWC.planScopes}`,
      resource: SIWC.resource,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    const callback = waitForCallback(server, { state, clientId: savedClientId }, timeoutMs);
    try {
      opts.openBrowser(`${authorizeUrl}?${params.toString()}`);
    } catch {
      /* the caller prints the URL; keep waiting for the callback */
    }
    const cb = await callback;

    try {
      const tokens = await exchangeCode(tokenUrl, {
        grant_type: "authorization_code",
        client_id: cb.clientId,
        code: cb.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: SIWC.resource,
      });
      const scopes = grantedScopes(tokens, cb.scope);
      if (!scopes || !scopes.includes(SIWC.planUsageScope)) {
        throw new Error(`登录失败：未授予 ${SIWC.planUsageScope}（该账号未允许 Nema 使用 ChatGPT 套餐额度），未保存凭证`);
      }
      const accountId = validateIdToken(tokens.id_token, { clientId: cb.clientId, nonce, nowS: Math.floor(Date.now() / 1000) });
      const auth: StoredAuth = {
        version: 1,
        mode: "siwc",
        clientId: cb.clientId,
        tokens: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
        },
        accountId,
        lastRefresh: new Date().toISOString(),
      };
      // AuthStore.save() is unlocked; serialize with refreshers via auth.lock.
      await withFileLock(path.join(nemaHome, "auth.lock"), async () => store.save(auth), { timeoutMs: 15_000 });
      page(cb.res, 200, "Nema Room 登录成功，可以关闭此页面并回到终端。");
      return auth;
    } catch (e) {
      page(cb.res, 500, e instanceof Error ? e.message : "登录失败");
      throw e;
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** Refresh per [SESSIONS] "Refreshing tokens". `tokenUrl` is overridable for tests. */
export function makeSiwcRefresher(tokenUrl: string = SIWC.tokenUrl): Refresher {
  return async (auth: StoredAuth, signal?: AbortSignal): Promise<RefreshResult> => {
    if (auth.mode !== "siwc") throw new ReloginRequiredError("mode_mismatch");
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { ...nemaHeaders(), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.tokens.refresh_token,
        client_id: auth.clientId,
        resource: SIWC.resource, // scope omitted to retain the grant
      }).toString(),
      signal,
    });
    if (!res.ok) {
      const { code } = await errorCode(res);
      if (code && (UNUSABLE_REFRESH_CODES as readonly string[]).includes(code)) throw new ReloginRequiredError(code);
      const ra = Number(res.headers.get("retry-after"));
      throw new RefreshError(res.status, { code, retryAfterS: Number.isFinite(ra) && ra >= 0 && res.headers.has("retry-after") ? ra : undefined });
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.access_token !== "string" || body.access_token === "") throw new Error("刷新响应缺少 access_token");
    return {
      access_token: body.access_token,
      ...(typeof body.refresh_token === "string" && body.refresh_token !== "" ? { refresh_token: body.refresh_token } : {}),
      ...(typeof body.id_token === "string" && body.id_token !== "" ? { id_token: body.id_token } : {}),
    };
  };
}

export const siwcRefresher: Refresher = makeSiwcRefresher();
