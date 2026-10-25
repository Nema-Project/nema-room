import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { browserCommand } from "../platform.js";
import { configErrorMessage, loadConfig } from "../config.js";
import { AuthStore, ReloginRequiredError, UNUSABLE_FILE_MESSAGE, type Refresher } from "./authStore.js";
import { CodexFileTokenSource, CodexLoginError, defaultCodexHome, readCodexCliTokens } from "./codexLogin.js";
import { jwtExp } from "./jwt.js";
import { LockTimeoutError, withFileLock } from "./lock.js";
import { cliVersion, siwcLogin, siwcRefresher, type SiwcEndpoints } from "./siwc.js";
import { BYOK_PROFILE, COMPAT_PROFILE, listModels, outputText, SIWC_PROFILE, streamResponse, type TokenSource, type TransportProfile } from "./transport.js";
import { ByokTokenSource } from "./byok.js";

// `nema auth login|byok|status|logout|probe`. Nothing here ever prints a token.

export { authByok } from "./byok.js";

export type Out = { log: (s: string) => void; error: (s: string) => void };
export const consoleOut: Out = { log: (s) => console.log(s), error: (s) => console.error(s) };

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tail4 = (s: string | undefined) => (s ? `…${s.slice(-4)}` : "未知");
const NOT_LOGGED_IN = "尚未登录直连模式，请在终端运行 nema auth login";

/** Opens the system browser without a shell; the URL is printed if launching fails. */
export function defaultOpenBrowser(url: string): void {
  const command = browserCommand(url);
  try {
    const child = spawn(command.bin, command.args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the URL is printed anyway */
  }
}

export async function authLogin(o: {
  nemaHome: string;
  out: Out;
  openBrowser?: (url: string) => void;
  port?: number;
  timeoutMs?: number;
  endpoints?: SiwcEndpoints;
  /** Codex CLI home for authMode=compat. Defaults to $CODEX_HOME or ~/.codex. */
  codexHome?: string;
  signal?: AbortSignal;
  requireTrustedAuthorizeUrl?: boolean;
  redactCallbackErrors?: boolean;
}): Promise<number> {
  let authMode: string;
  try {
    ({ authMode } = loadConfig(o.nemaHome));
  } catch (e) {
    o.out.error(configErrorMessage(e));
    return 1;
  }
  if (authMode === "compat") return confirmCodexLogin(o);
  const open = o.openBrowser ?? defaultOpenBrowser;
  try {
    const auth = await siwcLogin({
      nemaHome: o.nemaHome,
      port: o.port,
      timeoutMs: o.timeoutMs,
      endpoints: o.endpoints,
      signal: o.signal,
      requireTrustedAuthorizeUrl: o.requireTrustedAuthorizeUrl,
      redactCallbackErrors: o.redactCallbackErrors,
      openBrowser: (url) => {
        o.out.log(`请在浏览器中完成「Sign in with ChatGPT」登录。若浏览器没有自动打开，请访问：\n${url}`);
        try {
          open(url);
        } catch {
          /* printed above */
        }
      },
    });
    o.out.log(`登录成功：模式 siwc，账号 ${tail4(auth.accountId)}，client id ${auth.clientId}`);
    return 0;
  } catch (e) {
    o.out.error(`登录失败：${errMessage(e)}`);
    return 1;
  }
}

function confirmCodexLogin(o: { out: Out; codexHome?: string }): number {
  try {
    const t = readCodexCliTokens(o.codexHome ?? defaultCodexHome());
    const exp = t.exp === null ? "未知" : new Date(t.exp * 1000).toISOString();
    o.out.log(`已使用 Codex 登录：账号 ${tail4(t.accountId)}，access token 到期 ${exp}。Nema 只读取该文件，不会刷新或改写它。`);
    return 0;
  } catch (e) {
    o.out.error(e instanceof CodexLoginError ? e.message : `登录失败：${errMessage(e)}`);
    return 1;
  }
}

export function authStatus(o: { nemaHome: string; out: Out; codexHome?: string }): number {
  let authMode: string;
  try {
    ({ authMode } = loadConfig(o.nemaHome));
  } catch (e) {
    o.out.error(configErrorMessage(e));
    return 1;
  }
  if (authMode === "compat") return confirmCodexLogin(o) === 0 ? 0 : 1;
  const { auth, reason } = new AuthStore(o.nemaHome, siwcRefresher).inspect();
  if (!auth) {
    o.out.log(reason === "unusable" ? UNUSABLE_FILE_MESSAGE : NOT_LOGGED_IN);
    return 1;
  }
  o.out.log(`模式：${auth.mode}`);
  o.out.log(`账号：${tail4(auth.accountId)}`);
  o.out.log(`client id：${auth.clientId}`);
  if (auth.tokens.refresh_token === "") {
    o.out.log("令牌：已失效，需要重新登录（nema auth login）");
  } else {
    const exp = jwtExp(auth.tokens.access_token);
    o.out.log(`access token 过期时间：${exp === null ? "未知" : new Date(exp * 1000).toISOString()}`);
  }
  o.out.log(`上次刷新：${auth.lastRefresh}`);
  if (auth.lastAuthError) {
    const e = auth.lastAuthError;
    o.out.log(`最近一次认证错误：${e.code}（${e.message}）于 ${e.at}`);
  }
  return 0;
}

export async function authLogout(o: { nemaHome: string; out: Out; lockTimeoutMs?: number }): Promise<number> {
  const store = new AuthStore(o.nemaHome, siwcRefresher);
  if (!existsSync(o.nemaHome)) {
    o.out.log("当前没有直连登录。");
    return 0;
  }
  try {
    await withFileLock(path.join(o.nemaHome, "auth.lock"), async () => store.clear(), { timeoutMs: o.lockTimeoutMs ?? 15_000 });
  } catch (e) {
    if (e instanceof LockTimeoutError) {
      o.out.error("等待凭证锁超时（可能有其他 nema 进程正在刷新登录），请稍后重试 nema auth logout");
      return 1;
    }
    throw e;
  }
  o.out.log("已退出直连登录（已删除 auth.json）。");
  return 0;
}

const PROBE_PROMPT = "只回复 ok";
const PROBE_INSTRUCTIONS = "You are a connectivity probe. Reply with exactly what the user asks.";
const PROBE_TIMEOUT_MS = 60_000;

export async function authProbe(o: {
  nemaHome: string;
  out: Out;
  apiBase?: string;
  refresher?: Refresher;
  forceRefresh?: boolean;
  codexHome?: string;
  signal?: AbortSignal;
}): Promise<number> {
  let authMode: string;
  try {
    ({ authMode } = loadConfig(o.nemaHome));
  } catch (e) {
    o.out.error(configErrorMessage(e));
    return 1;
  }
  if (authMode === "compat") {
    const source = new CodexFileTokenSource(o.codexHome ?? defaultCodexHome());
    try {
      await source.getAccessToken({ signal: o.signal });
    } catch (e) {
      o.out.error(e instanceof CodexLoginError ? e.message : errMessage(e));
      return 1;
    }
    if (o.forceRefresh) o.out.log("已重新读取 Codex 登录（Nema 不刷新该凭证）");
    const profile = o.apiBase ? { ...COMPAT_PROFILE, baseUrl: o.apiBase } : COMPAT_PROFILE;
    return runProbe(o, source, profile, o.signal);
  }
  const config = loadConfig(o.nemaHome);
  if (config.authMode === "byok") {
    const profile = { ...BYOK_PROFILE, baseUrl: config.byokBaseUrl ?? BYOK_PROFILE.baseUrl };
    return runProbe(o, new ByokTokenSource(o.nemaHome), profile, o.signal);
  }
  const store = new AuthStore(o.nemaHome, o.refresher ?? siwcRefresher);
  const { auth, reason } = store.inspect();
  if (!auth || auth.tokens.refresh_token === "") {
    o.out.error(reason === "unusable" ? UNUSABLE_FILE_MESSAGE : NOT_LOGGED_IN);
    return 1;
  }
  if (auth.mode !== "siwc") {
    o.out.error("当前登录不是 siwc 模式；compat 模式请把 authMode 设为 compat。");
    return 1;
  }
  const profile = o.apiBase ? { ...SIWC_PROFILE, baseUrl: o.apiBase } : SIWC_PROFILE;
  if (o.forceRefresh) {
    const before = auth.lastRefresh;
    const { auth: current } = await store.getAccessToken({ force: true, signal: o.signal });
    o.out.log(current.lastRefresh !== before ? `已强制刷新令牌（${current.lastRefresh}）` : "令牌未刷新");
  }
  return runProbe(o, store, profile, o.signal);
}

async function runProbe(o: { nemaHome: string; out: Out }, source: TokenSource, profile: TransportProfile, ownerSignal?: AbortSignal): Promise<number> {
  try {
    const ctx = { auth: source, profile, version: cliVersion(), signal: ownerSignal ? AbortSignal.any([ownerSignal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) : AbortSignal.timeout(PROBE_TIMEOUT_MS) };
    const models = await listModels(ctx);
    o.out.log(`可用模型（${models.length}）：${models.join(", ") || "无"}`);
    if (models.length === 0) {
      o.out.error("探针失败：模型列表为空");
      return 1;
    }
    const { model: configured } = loadConfig(o.nemaHome);
    const model = configured && models.includes(configured) ? configured : models[0]!;
    let streamed = "";
    const r = await streamResponse(
      {
        model,
        instructions: PROBE_INSTRUCTIONS,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: PROBE_PROMPT }] }],
        tools: [],
        reasoning: { effort: "low", summary: "auto" },
        sessionId: randomUUID(),
      },
      { ...ctx, onTextDelta: (t) => (streamed += t) },
    );
    o.out.log(`模型：${model}`);
    if (r.status !== "completed") {
      o.out.error(`探针失败：响应不完整（${r.incompleteReason ?? "incomplete"}）`);
      return 1;
    }
    o.out.log(`结果：${(outputText(r.items) || streamed).trim()}`);
    return 0;
  } catch (e) {
    if (e instanceof ReloginRequiredError) {
      o.out.error(e.message);
      return 1;
    }
    o.out.error(`探针失败：${errMessage(e)}`);
    return 1;
  }
}
