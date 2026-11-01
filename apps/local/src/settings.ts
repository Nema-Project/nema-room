import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { saveConfig, loadConfig, type NemaConfig } from "@nema/cli/config";
import { authLogin, authLogout, authProbe, defaultOpenBrowser, listConfiguredModels, ModelsListError, AuthStore, siwcRefresher, siwcLogin, byokKeyPath, saveByokKey, claudeTokenPath, saveClaudeToken, githubTokenPath, saveGithubToken, defaultCodexHome, readCodexCliTokens, accountDir, loadAccounts } from "@nema/cli/localSettings";
import { handleAccounts, accountsJobsSettled, type AccountsReply, type AccountsDeps } from "./accountsApi.js";

export type SettingsOperations = {
  login(options: { signal: AbortSignal }): Promise<{ ok: boolean }>;
  logout(kind: "siwc" | "compat" | "byok" | "claude" | "github"): Promise<void>;
  probe(options: { signal: AbortSignal }): Promise<{ ok: boolean; modelCount?: number }>;
  saveSecret(kind: "byok" | "claude" | "github", value: string): void;
  /** When omitted, the saved provider's catalog is read. A thrown error is not returned to the client. */
  listModels?(options: { signal: AbortSignal }): Promise<string[]>;
};

export type SettingsServiceOptions = { home: string; codexHome?: string; operations?: SettingsOperations };
export type SettingsReply = { status: number; body: Record<string, unknown> };
export type SettingsService = {
  dispatch(method: string, pathname: string, body: unknown): Promise<SettingsReply>;
  cancel(): void;
  stopAccepting(): void;
  waitForJobs(): Promise<void>;
  close(): Promise<void>;
};

function scrubbedError(): SettingsReply { return { status: 500, body: { error: "internal_error" } }; }
function invalid(): SettingsReply { return { status: 400, body: { error: "invalid_request" } }; }
function noBody(body: unknown): boolean { return !!body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0; }

export function isAllowedAuthorizeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "auth.openai.com" && url.pathname === "/api/accounts/authorize" &&
      url.username === "" && url.password === "" && url.port === "" && url.hash === "";
  } catch { return false; }
}

function defaultOperations(home: string, codexHome: string): SettingsOperations {
  return {
    async login({ signal }) {
      const safeOpen = (value: string) => {
        if (!isAllowedAuthorizeUrl(value)) throw new Error("untrusted authorize URL");
        defaultOpenBrowser(value);
      };
      // The helper's opener is replaced at production startup by the fixed browser opener.
      const code = await authLogin({ nemaHome: home, codexHome, signal, requireTrustedAuthorizeUrl: true, redactCallbackErrors: true, out: { log: () => {}, error: () => {} }, openBrowser: safeOpen });
      return { ok: code === 0 };
    },
    async logout(kind) {
      if (kind === "compat") return; // Codex owns that login and its files.
      if (kind === "siwc") {
        const code = await authLogout({ nemaHome: home, out: { log: () => {}, error: () => {} } });
        if (code !== 0) throw new Error("logout failed");
        return;
      }
      const file = kind === "byok" ? byokKeyPath(home) : kind === "claude" ? claudeTokenPath(home) : githubTokenPath(home);
      try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    },
    async probe({ signal }) {
      const config = loadConfig(home);
      if (config.adapter !== "codex-direct") return { ok: false };
      const code = await authProbe({ nemaHome: home, codexHome, signal, out: { log: () => {}, error: () => {} } });
      return { ok: code === 0, modelCount: undefined };
    },
    saveSecret(kind, value) {
      if (kind === "byok") saveByokKey(home, value);
      else if (kind === "claude") saveClaudeToken(home, value);
      else saveGithubToken(home, value);
    },
  };
}

/**
 * The account block of `/_nema/settings` (spec 2026-10-31 §5.1). It is *added* to the response the old web
 * already reads: `config` keeps meaning "the current default account's projection", so the four dropdowns
 * of 0.2.0 keep working and keep switching. Nothing here carries a credential.
 *
 * An unusable file yields no list at all, only the reason, so the page shows why instead of an empty block
 * that would read as "no accounts".
 */
function accountsStatus(home: string, codexHome: string): Record<string, unknown> {
  const reply = handleAccounts("GET", "/_nema/accounts", undefined, accountsDeps(home, codexHome));
  if (!reply || reply.status !== 200) return {};
  // Only the two fields §5.1 names (plus the reason when the file cannot be read). The bindings belong to
  // `/_nema/accounts` alone: the settings response is what an old web reads, and it grows nothing it does
  // not document.
  const { accounts, defaultAccountId, unusableReason } = reply.body as {
    accounts?: unknown;
    defaultAccountId?: unknown;
    unusableReason?: unknown;
  };
  return {
    ...(accounts !== undefined ? { accounts } : {}),
    ...(defaultAccountId !== undefined ? { defaultAccountId } : {}),
    ...(unusableReason !== undefined ? { unusableReason } : {}),
  };
}

function redactedStatus(home: string, codexHome: string): Record<string, unknown> {
  const config = loadConfig(home);
  let state: "connected" | "missing" | "unusable" = "missing";
  let credential: "siwc" | "compat" | "byok" | "claude" = config.authMode;
  if (config.adapter === "claude-code") {
    credential = "claude";
    state = existsSync(claudeTokenPath(home)) ? "connected" : "missing";
  } else if (config.authMode === "compat") {
    try { readCodexCliTokens(codexHome); state = "connected"; } catch { state = "missing"; }
  } else if (config.authMode === "byok") {
    state = existsSync(byokKeyPath(home)) ? "connected" : "missing";
  } else {
    const inspected = new AuthStore(home, siwcRefresher).inspect();
    state = inspected.auth ? "connected" : inspected.reason === "unusable" ? "unusable" : "missing";
  }
  let siwc: "connected" | "missing" | "unusable" = "missing";
  const inspected = new AuthStore(home, siwcRefresher).inspect();
  siwc = inspected.auth ? "connected" : inspected.reason === "unusable" ? "unusable" : "missing";
  let compat: "connected" | "missing" = "missing";
  try { readCodexCliTokens(codexHome); compat = "connected"; } catch { compat = "missing"; }
  return {
    config,
    ...accountsStatus(home, codexHome),
    auth: { mode: config.authMode, credential, state, adapter: config.adapter },
    credentials: {
      siwc,
      compat,
      byok: existsSync(byokKeyPath(home)) ? "connected" : "missing",
      claude: existsSync(claudeTokenPath(home)) ? "connected" : "missing",
    },
    tools: {
      claude: { available: commandOnPath("claude"), tokenSaved: existsSync(claudeTokenPath(home)) },
      github: { available: commandOnPath("github-mcp-server"), tokenSaved: existsSync(githubTokenPath(home)) },
    },
  };
}

function commandOnPath(command: string): boolean {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) if (existsSync(path.join(directory, `${command}${extension}`))) return true;
  }
  return false;
}

function configPatch(value: unknown): Partial<NemaConfig> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.some((key) => !["adapter", "model", "reasoningEffort", "authMode", "byokBaseUrl"].includes(key))) return null;
  if ("model" in record && record.model !== null && (typeof record.model !== "string" || record.model.length === 0)) return null;
  if ("byokBaseUrl" in record && record.byokBaseUrl !== null && typeof record.byokBaseUrl !== "string") return null;
  const patch = { ...record } as Record<string, unknown>;
  if (patch.model === null) patch.model = undefined;
  if (patch.byokBaseUrl === null) patch.byokBaseUrl = undefined;
  return patch as Partial<NemaConfig>;
}

/**
 * The browser login for one account: the PKCE flow, writing into that account's own directory. `baseDir` is
 * what keeps two accounts' logins apart.
 *
 * It calls `siwcLogin` rather than `authLogin` on purpose. `authLogin` first reads `config.json` and, when
 * that says `compat`, runs the Codex-login confirmation instead — the *default* account's mode deciding what
 * a login for a *different* account does. The route has already established that this account is `siwc`.
 *
 * The opener is fixed to the provider's own authorize endpoint, and callback errors are redacted from the
 * browser page, exactly as the single-key route does it.
 */
function accountLogin(options: SettingsServiceOptions, codexHome: string) {
  return async (account: { id: string }, signal: AbortSignal): Promise<{ ok: boolean }> => {
    try {
      await siwcLogin({
        nemaHome: options.home,
        baseDir: accountDir(options.home, account.id),
        signal,
        requireTrustedAuthorizeUrl: true,
        redactCallbackErrors: true,
        openBrowser: (value) => {
          if (!isAllowedAuthorizeUrl(value)) throw new Error("untrusted authorize URL");
          defaultOpenBrowser(value);
        },
      });
      return { ok: true };
    } catch {
      // The reason never leaves this process: the route answers with a code, and the page shows its own text.
      return { ok: false };
    }
  };
}

/** The dependencies the accounts routes run against, built from the same home this service owns. */
export function accountsDeps(home: string, codexHome: string, options?: SettingsServiceOptions): AccountsDeps {
  return {
    home,
    codexHome,
    login: options ? accountLogin(options, codexHome) : async () => ({ ok: false }),
  };
}

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? defaultCodexHome();
  const accounts = accountsDeps(options.home, codexHome, options);
  const operations = options.operations ?? defaultOperations(options.home, codexHome);
  let closed = false;
  let logoutPending = false;
  let logoutPromise: Promise<void> | undefined;
  let active: { name: "login" | "probe"; controller: AbortController; promise: Promise<void>; state: "running" | "cancelling" | "failed" | "succeeded" | "cancelled" } | undefined;
  let lastFailure: "login_failed" | "probe_failed" | null = null;

  const jobSnapshot = () => ({ state: active?.state ?? "idle", error: lastFailure });
  const startJob = (name: "login" | "probe", run: (signal: AbortSignal) => Promise<{ ok: boolean }>): boolean => {
    if (closed || (active && (active.state === "running" || active.state === "cancelling"))) return false;
    lastFailure = null;
    const controller = new AbortController();
    const job: { name: "login" | "probe"; controller: AbortController; promise: Promise<void>; state: "running" | "cancelling" | "failed" | "succeeded" | "cancelled" } = { name, controller, state: "running", promise: Promise.resolve() };
    active = job;
    job.promise = Promise.resolve().then(() => run(controller.signal)).then((result) => {
      if (active !== job) return;
      job.state = controller.signal.aborted ? "cancelled" : result.ok ? "succeeded" : "failed";
      if (job.state === "failed") lastFailure = name === "login" ? "login_failed" : "probe_failed";
    }, () => {
      if (active !== job) return;
      job.state = controller.signal.aborted ? "cancelled" : "failed";
      if (job.state === "failed") lastFailure = name === "login" ? "login_failed" : "probe_failed";
    });
    return true;
  };

  const cancel = () => {
    if (active?.state === "running") {
      active.state = "cancelling";
      active.controller.abort();
    }
  };
  const waitForJobs = async () => { const job = active; if (job) await job.promise; };
  const stopAccepting = () => { closed = true; cancel(); };

  return {
    cancel,
    stopAccepting,
    waitForJobs,
    async close() {
      stopAccepting();
      await Promise.all([waitForJobs(), accountsJobsSettled(), logoutPromise].filter((promise): promise is Promise<void> => promise !== undefined));
    },
    async dispatch(method, pathname, body): Promise<SettingsReply> {
      if (closed) return { status: 503, body: { error: "service_closing" } };
      try {
        if (method === "GET" && pathname === "/_nema/models") {
          const signal = AbortSignal.timeout(20_000);
          try {
            const listed = operations.listModels
              ? await operations.listModels({ signal })
              : await listConfiguredModels({ nemaHome: options.home, codexHome, signal });
            if (!Array.isArray(listed) || listed.some((id) => typeof id !== "string" || id === "")) return { status: 200, body: { models: [], unavailable: "list_failed" } };
            return { status: 200, body: { models: listed } };
          } catch (error) {
            const reason = error instanceof ModelsListError ? error.reason : "list_failed";
            return { status: 200, body: { models: [], unavailable: reason } };
          }
        }
        // Account settings own their own paths and answer `null` for anything else, including every path
        // this dispatch already served: an older web calling those routes sees exactly what it did before.
        const accountsReply: AccountsReply | null = pathname.startsWith("/_nema/accounts")
          ? handleAccounts(method, pathname, body, accounts)
          : null;
        if (accountsReply) return accountsReply;
        if (method === "GET" && pathname === "/_nema/settings") return { status: 200, body: redactedStatus(options.home, codexHome) };
        if (method === "PATCH" && pathname === "/_nema/settings") {
          if (logoutPending) return { status: 409, body: { error: "mutation_conflict" } };
          const patch = configPatch(body);
          if (!patch) return invalid();
          try { return { status: 200, body: { config: saveConfig(options.home, patch) } }; } catch { return invalid(); }
        }
        if (method === "POST" && pathname === "/_nema/auth/login") {
          if (!noBody(body)) return invalid();
          if (logoutPending) return { status: 409, body: { error: "mutation_conflict" } };
          const config = loadConfig(options.home);
          if (config.adapter === "claude-code" || config.authMode === "byok") return { status: 409, body: { error: "login_not_applicable" } };
          if (!startJob("login", (signal) => operations.login({ signal }))) return { status: 409, body: { error: "job_conflict" } };
          return { status: 202, body: { state: "running" } };
        }
        if (method === "GET" && pathname === "/_nema/auth/status") return { status: 200, body: jobSnapshot() };
        if (method === "POST" && pathname === "/_nema/auth/cancel") {
          if (!noBody(body)) return invalid();
          if (logoutPending) return { status: 409, body: { error: "mutation_conflict" } };
          cancel();
          return { status: 200, body: { state: active?.state ?? "idle" } };
        }
        if (method === "POST" && pathname === "/_nema/auth/logout") {
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1) return invalid();
          const rawKind = (body as Record<string, unknown>).kind;
          if (typeof rawKind !== "string" || !["siwc", "compat", "byok", "claude", "github"].includes(rawKind)) return invalid();
          if (logoutPending) return { status: 409, body: { error: "mutation_conflict" } };
          const kind = rawKind as "siwc" | "compat" | "byok" | "claude" | "github";
          logoutPending = true;
          const pending = (async () => {
            cancel();
            await waitForJobs();
            await operations.logout(kind);
          })();
          logoutPromise = pending;
          try { await pending; }
          finally {
            logoutPending = false;
            if (logoutPromise === pending) logoutPromise = undefined;
          }
          return { status: 200, body: { loggedOut: kind !== "compat", kind } };
        }
        if (method === "POST" && pathname === "/_nema/auth/probe") {
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || (body as Record<string, unknown>).confirmQuotaUse !== true) return invalid();
          if (logoutPending) return { status: 409, body: { error: "mutation_conflict" } };
          if (loadConfig(options.home).adapter === "claude-code") return { status: 409, body: { error: "probe_not_supported" } };
          if (!startJob("probe", (signal) => operations.probe({ signal }))) return { status: 409, body: { error: "job_conflict" } };
          return { status: 202, body: { state: "running" } };
        }
        if (method === "POST" && pathname === "/_nema/auth/secret") {
          if (logoutPending) return { status: 409, body: { error: "mutation_conflict" } };
          if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();
          const value = body as Record<string, unknown>;
          if (Object.keys(value).length !== 2 || !("kind" in value) || !("value" in value) || typeof value.kind !== "string" || !["byok", "claude", "github"].includes(value.kind) || typeof value.value !== "string" || value.value.length === 0 || /[\r\n]/.test(value.value)) return invalid();
          operations.saveSecret(value.kind as "byok" | "claude" | "github", value.value);
          return { status: 200, body: { saved: true } };
        }
        return { status: 404, body: { error: "not_found" } };
      } catch { return scrubbedError(); }
    },
  };
}
