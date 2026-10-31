import { closeSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCodexAuth } from "../codex/isolation.js";
import { openPrivateFile } from "../secrets/permissions.js";
import type { StoredAuth } from "./authStore.js";
import { decodeJwtPayload, jwtExp } from "./jwt.js";

// Hermes `_import_codex_cli_tokens` (hermes_cli/auth_codex.py): read `$CODEX_HOME/auth.json`
// (default ~/.codex) and use tokens.access_token / tokens.refresh_token only while the access
// token is unexpired. Never write that file. Nema also does not refresh it: a refresh rotates
// the single-use refresh token and invalidates the Codex CLI's own login.

export const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

export class CodexLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexLoginError";
  }
}

export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CODEX_HOME?.trim();
  return raw ? raw : path.join(os.homedir(), ".codex");
}

type AuthClaim = { chatgpt_account_id?: unknown; chatgpt_data_residency?: unknown; chatgpt_compute_residency?: unknown };

function authClaim(accessToken: string): AuthClaim {
  try {
    const claim = decodeJwtPayload(accessToken)[CODEX_AUTH_CLAIM];
    return claim && typeof claim === "object" && !Array.isArray(claim) ? (claim as AuthClaim) : {};
  } catch {
    return {};
  }
}

/** Account headers Hermes sends on chatgpt.com/backend-api/codex. A malformed token yields none. */
export function codexAccountHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const claim = authClaim(accessToken);
  if (typeof claim.chatgpt_account_id === "string" && claim.chatgpt_account_id !== "") {
    headers["ChatGPT-Account-ID"] = claim.chatgpt_account_id;
  }
  const residency = claim.chatgpt_data_residency ?? claim.chatgpt_compute_residency;
  if (typeof residency === "string" && residency.trim() !== "") headers["x-openai-internal-codex-residency"] = residency.trim();
  return headers;
}

export type CodexCliTokens = { accessToken: string; refreshToken: string; accountId?: string; exp: number | null };

/**
 * Read the Codex CLI login. Throws CodexLoginError when it cannot be used. Does not write the file.
 *
 * The file is opened with `openPrivateFile`, which refuses a symlink, checks that the file really is a
 * regular file, and verifies the Windows DACL: a login other users can read is not a login Nema should
 * send to a provider. The tokens are taken from the bytes read through that descriptor.
 */
export function readCodexCliTokens(codexHome: string, now = Date.now()): CodexCliTokens {
  const checked = checkCodexAuth(codexHome);
  if (!checked.ok) throw new CodexLoginError(checked.error);
  let raw: string;
  try {
    const fd = openPrivateFile(checked.authPath);
    try {
      raw = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new CodexLoginError(`Codex 登录文件 ${checked.authPath} 是符号链接，已拒绝读取。`);
    throw new CodexLoginError(`无法读取 Codex 登录文件 ${checked.authPath}：${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CodexLoginError(`无法读取 Codex 登录文件 ${checked.authPath}：${e instanceof Error ? e.message : String(e)}`);
  }
  const tokens = parsed && typeof parsed === "object" ? (parsed as { tokens?: unknown }).tokens : undefined;
  const access = tokens && typeof tokens === "object" ? (tokens as { access_token?: unknown }).access_token : undefined;
  const refresh = tokens && typeof tokens === "object" ? (tokens as { refresh_token?: unknown }).refresh_token : undefined;
  if (typeof access !== "string" || access === "" || typeof refresh !== "string" || refresh === "") {
    throw new CodexLoginError(`Codex 登录文件 ${checked.authPath} 里没有可用的 access_token 和 refresh_token。请重新运行 codex login。`);
  }
  const exp = jwtExp(access);
  // Hermes import uses skew 0: only a numeric exp at or before now is expired. A missing exp is kept.
  if (exp !== null && exp * 1000 <= now) {
    throw new CodexLoginError(
      `Codex 的 access token 已过期（${checked.authPath}）。请打开一次 Codex 让它刷新登录。Nema 只读取该文件，不会刷新，以免作废 Codex 自己的登录。`,
    );
  }
  const accountId = authClaim(access).chatgpt_account_id;
  return { accessToken: access, refreshToken: refresh, accountId: typeof accountId === "string" && accountId !== "" ? accountId : undefined, exp };
}

/**
 * Token source for authMode=compat. Re-reads the Codex file on every call, including after a 401,
 * so a token Codex itself rotated is picked up. Never refreshes and never writes the file.
 */
export class CodexFileTokenSource {
  constructor(private readonly codexHome: string, private readonly now: () => number = Date.now) {}

  async getAccessToken(opts: { force?: boolean; rejectedAccessToken?: string; signal?: AbortSignal } = {}): Promise<{ accessToken: string; auth: StoredAuth }> {
    opts.signal?.throwIfAborted();
    const t = readCodexCliTokens(this.codexHome, this.now());
    if (opts.rejectedAccessToken !== undefined && t.accessToken === opts.rejectedAccessToken) {
      throw new CodexLoginError("模型接口拒绝了当前的 Codex 登录。Nema 不会刷新 ~/.codex/auth.json。请在 Codex 里重新登录后再试。");
    }
    const auth: StoredAuth = {
      version: 1,
      mode: "compat",
      clientId: "codex-cli-file",
      tokens: { access_token: t.accessToken, refresh_token: t.refreshToken },
      accountId: t.accountId,
      lastRefresh: new Date(this.now()).toISOString(),
    };
    return { accessToken: t.accessToken, auth };
  }

  async recordAuthError(): Promise<void> {
    /* The Codex file is not ours to annotate. */
  }
}
