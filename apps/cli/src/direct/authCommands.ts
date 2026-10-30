import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { browserCommand } from "../platform.js";
import { configErrorMessage, DEFAULT_BYOK_BASE_URL, loadConfig, type NemaConfig } from "../config.js";
import { AuthStore, ReloginRequiredError, UNUSABLE_FILE_MESSAGE, type Refresher } from "./authStore.js";
import { CodexFileTokenSource, CodexLoginError, defaultCodexHome, readCodexCliTokens } from "./codexLogin.js";
import { jwtExp } from "./jwt.js";
import { LockTimeoutError, withFileLock } from "./lock.js";
import { cliVersion, siwcLogin, siwcRefresher, type SiwcEndpoints } from "./siwc.js";
import { BYOK_PROFILE, COMPAT_PROFILE, listModels, outputText, SIWC_PROFILE, streamResponse, type TokenSource, type TransportProfile } from "./transport.js";
import { byokKeyPath, ByokTokenSource, readByokKey } from "./byok.js";

// `nema auth login|byok|status|logout|probe`. Nothing here ever prints a token.

export { authByok } from "./byok.js";

export type Out = { log: (s: string) => void; error: (s: string) => void };

/** Why the saved provider's model catalog could not be read. The message is the reason, never an upstream body. */
export class ModelsListError extends Error {
  constructor(readonly reason: "not_applicable" | "not_connected" | "list_failed") {
    super(reason);
    this.name = "ModelsListError";
  }
}
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

/**
 * BYOK has no login: report the saved endpoint, model and whether the key file is usable, from the same config
 * snapshot that selected this branch. The key is never printed. Only codex-direct uses BYOK, so under another
 * adapter the settings are shown as unused and the status is not healthy.
 */
function byokStatus(o: { nemaHome: string; out: Out }, config: NemaConfig): number {
  o.out.log("模式：byok");
  o.out.log(`adapter：${config.adapter}`);
  o.out.log(config.byokBaseUrl ? `base URL：${config.byokBaseUrl}` : `base URL：${DEFAULT_BYOK_BASE_URL}（默认）`);
  o.out.log(config.model ? `模型：${config.model}` : "模型：未设置（BYOK 需要指定模型，请运行 nema config set model <名称>）");
  let keyOk = false;
  const present = keyFilePresence(byokKeyPath(o.nemaHome));
  if (present === "missing") {
    o.out.log("API key：未保存（请把 key 从标准输入交给 nema auth byok）");
  } else if (present !== "present") {
    o.out.log(`API key：不可用（无法检查 key 文件：${errMessage(present.error)}）`);
  } else {
    try {
      readByokKey(o.nemaHome);
      keyOk = true;
      o.out.log("API key：已保存");
    } catch (e) {
      o.out.log(`API key：不可用（${errMessage(e)}）`);
    }
  }
  if (config.adapter !== "codex-direct") {
    o.out.log(`当前 adapter 不使用 BYOK：${config.adapter} 用它自己的凭证。要用 BYOK，请运行 nema config set adapter codex-direct`);
    return 1;
  }
  return keyOk && config.model ? 0 : 1;
}

/** lstat, so a dangling symlink counts as present (then unusable). Only ENOENT means missing; other errors are kept. */
function keyFilePresence(file: string): "present" | "missing" | { error: unknown } {
  try {
    lstatSync(file);
    return "present";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : { error: e };
  }
}

export function authStatus(o: { nemaHome: string; out: Out; codexHome?: string }): number {
  let config: NemaConfig;
  try {
    config = loadConfig(o.nemaHome);
  } catch (e) {
    o.out.error(configErrorMessage(e));
    return 1;
  }
  const { authMode } = config;
  if (authMode === "compat") return confirmCodexLogin(o) === 0 ? 0 : 1;
  if (authMode === "byok") return byokStatus(o, config);
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

/** Listed models for the saved provider. Does not send a generation request. */
export async function listConfiguredModels(o: {
  nemaHome: string;
  codexHome?: string;
  refresher?: Refresher;
  signal?: AbortSignal;
}): Promise<string[]> {
  let config;
  try {
    config = loadConfig(o.nemaHome);
  } catch {
    throw new ModelsListError("list_failed");
  }
  if (config.adapter === "claude-code") throw new ModelsListError("not_applicable");
  const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  let source: TokenSource;
  let profile: TransportProfile;
  try {
    if (config.authMode === "compat") {
      source = new CodexFileTokenSource(o.codexHome ?? defaultCodexHome());
      await source.getAccessToken({ signal });
      profile = COMPAT_PROFILE;
    } else if (config.authMode === "byok") {
      source = new ByokTokenSource(o.nemaHome);
      await source.getAccessToken({ signal });
      profile = { ...BYOK_PROFILE, baseUrl: config.byokBaseUrl ?? BYOK_PROFILE.baseUrl };
    } else {
      const store = new AuthStore(o.nemaHome, o.refresher ?? siwcRefresher);
      const { auth } = store.inspect();
      if (!auth || auth.tokens.refresh_token === "" || auth.mode !== "siwc") throw new ModelsListError("not_connected");
      await store.getAccessToken({ signal });
      source = store;
      profile = SIWC_PROFILE;
    }
  } catch (error) {
    if (error instanceof ModelsListError) throw error;
    throw new ModelsListError("not_connected");
  }
  try {
    return await listModels({ auth: source, profile, version: cliVersion(), signal });
  } catch {
    throw new ModelsListError("list_failed");
  }
}
