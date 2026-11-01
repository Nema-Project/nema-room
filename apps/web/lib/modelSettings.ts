export type ModelAdapter = "codex-direct" | "claude-code";
export type AuthMode = "siwc" | "compat" | "byok";
export type CredentialKind = AuthMode | "claude";
export type SettingMode = AuthMode | "claude";

export type ModelConfig = {
  adapter: ModelAdapter;
  authMode: AuthMode;
  reasoningEffort: "low" | "medium" | "high";
  model?: string;
  byokBaseUrl?: string;
};
export type CredentialState = "connected" | "missing" | "unusable";
export type ModelSettingsDto = {
  config: ModelConfig;
  auth: { mode: AuthMode; credential: CredentialKind; state: CredentialState; adapter: ModelAdapter };
  /** Each provider's own login. Absent on older responses; the active provider then uses `auth`. */
  credentials?: Partial<Record<CredentialKind, CredentialState>>;
  tools: Record<"claude" | "github", { available: boolean; tokenSaved: boolean }>;
  /**
   * The accounts block (spec 2026-10-31 §5.1). Both fields are additions: an older daemon omits them and
   * this page then shows exactly what it showed in 0.2.0. `accounts` is absent — not empty — when the
   * daemon has an account file it cannot read, and `unusableReason` says which way it failed.
   */
  accounts?: import("./accounts").AccountView[];
  defaultAccountId?: string;
  unusableReason?: "symlink" | "mode" | "owner" | "corrupt" | "invalid";
};
export type AuthJob = { state: "idle" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled"; error: "login_failed" | "probe_failed" | null };
export type ModelsCatalog = { models: string[]; unavailable?: "not_connected" | "not_applicable" | "list_failed" };

export type SettingsPatch = Partial<Pick<ModelConfig, "adapter" | "authMode" | "reasoningEffort">> & {
  model?: string | null;
  byokBaseUrl?: string | null;
};

/**
 * Every refusal the local settings service can name. The three account codes come from its accounts routes
 * (`lib/accounts.ts`); the set below is the subset `/_nema/settings` itself can answer, so a code from the
 * other routes is never mistaken for one of those.
 */
export type SettingsErrorCode =
  | "invalid_request" | "job_conflict" | "login_not_applicable" | "mutation_conflict" | "probe_not_supported" | "service_unavailable"
  | "account_exists" | "account_in_use" | "accounts_unusable";

export class ModelSettingsError extends Error {
  constructor(readonly code: SettingsErrorCode) {
    super(code);
    this.name = "ModelSettingsError";
  }
}

const ERROR_CODES = new Set<SettingsErrorCode>([
  "invalid_request", "job_conflict", "login_not_applicable", "mutation_conflict", "probe_not_supported", "service_unavailable",
]);

async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ModelSettingsError("service_unavailable");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const code = payload && typeof payload === "object" && "error" in payload ? (payload as { error: unknown }).error : null;
    throw new ModelSettingsError(typeof code === "string" && ERROR_CODES.has(code as SettingsErrorCode) ? code as SettingsErrorCode : "service_unavailable");
  }
  return payload as T;
}

export const modelSettingsApi = {
  read: (signal?: AbortSignal) => request<ModelSettingsDto>("/_nema/settings", "GET", undefined, signal),
  models: (signal?: AbortSignal) => request<ModelsCatalog>("/_nema/models", "GET", undefined, signal),
  patch: (body: SettingsPatch) => request<{ config: ModelConfig }>("/_nema/settings", "PATCH", body),
  login: () => request<{ state: "running" }>("/_nema/auth/login", "POST", {}),
  status: (signal?: AbortSignal) => request<AuthJob>("/_nema/auth/status", "GET", undefined, signal),
  cancel: () => request<AuthJob>("/_nema/auth/cancel", "POST", {}),
  logout: (kind: CredentialKind | "github") => request<{ loggedOut: boolean; kind: string }>("/_nema/auth/logout", "POST", { kind }),
  saveSecret: (kind: "byok" | "claude" | "github", value: string) => request<{ saved: true }>("/_nema/auth/secret", "POST", { kind, value }),
  probe: () => request<{ state: "running" }>("/_nema/auth/probe", "POST", { confirmQuotaUse: true }),
};

export function validateByokBaseUrl(raw: string): boolean {
  if (raw === "") return true;
  if (raw !== raw.trim() || raw.includes("?") || raw.includes("#")) return false;
  try {
    const url = new URL(raw);
    const localHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    return (url.protocol === "https:" || localHttp) && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
