import { ModelSettingsError, type CredentialState, type ModelAdapter, type SettingsErrorCode } from "@/lib/modelSettings";

/**
 * The accounts settings client (spec 2026-10-31 §5.2, §5.3).
 *
 * Its type is written out here rather than imported from the backend: the web bundle must not pull in the
 * CLI's zod schemas, and the two shapes are held together by the API tests on each side.
 *
 * The one degradation this needs: an older daemon answers `404 { error: "not_found" }` for
 * `/_nema/accounts`, which means "this daemon has no accounts feature", not "something went wrong". That
 * becomes `AccountsUnsupportedError`, and the settings page hides the account block and keeps the four
 * dropdowns of 0.2.0.
 */

export type AccountCapabilities = { image?: boolean; pdf?: boolean; contextTokens?: number };

export type AccountView = {
  id: string;
  name: string;
  enabled: boolean;
  adapter: ModelAdapter;
  authMode?: "siwc" | "compat" | "byok";
  baseUrl?: string;
  model?: string;
  capabilities?: AccountCapabilities;
  costTier: "low" | "standard" | "high";
  order: number;
  credential: CredentialState;
  implicit: boolean;
};

export type AccountsList = {
  accounts: AccountView[];
  defaultAccountId: string;
  bindings: Record<string, string>;
  unusableReason?: "symlink" | "mode" | "owner" | "corrupt" | "invalid";
};

export type AccountCreate = {
  name: string;
  adapter: ModelAdapter;
  authMode?: "siwc" | "compat" | "byok";
  baseUrl?: string;
  model?: string;
  capabilities?: AccountCapabilities;
  costTier?: "low" | "standard" | "high";
  order?: number;
  enabled?: boolean;
};

export type AccountUpdate = Partial<AccountCreate> & { id: string };

/**
 * The daemon predates accounts. Distinct from `ModelSettingsError` so a caller can choose to hide a block
 * instead of showing a failure, and never confuses an old daemon with a broken one.
 */
export class AccountsUnsupportedError extends Error {
  constructor() {
    super("accounts_unsupported");
    this.name = "AccountsUnsupportedError";
  }
}

/** The codes the accounts routes add to the settings set. */
export type AccountsErrorCode = "account_exists" | "account_in_use" | "accounts_unusable";

/**
 * A refusal the server named. `code` is the accounts set as well as the settings set, because these routes
 * add three (`account_exists`, `account_in_use`, `accounts_unusable`) and a caller has to be able to act on
 * them; `bindings` is what `account_in_use` carries, and it is the only useful answer to "why can't I delete
 * this". It is a `ModelSettingsError` so a caller that only wants "some settings operation failed" works.
 */
export class AccountsError extends ModelSettingsError {
  constructor(readonly code: SettingsErrorCode, readonly bindings?: string[]) {
    super(code);
    this.name = "AccountsError";
  }
}

const CODES = new Set<string>([
  "invalid_request", "job_conflict", "login_not_applicable", "mutation_conflict", "probe_not_supported",
  "service_unavailable", "account_exists", "account_in_use", "accounts_unusable",
]);

/**
 * `detectUnsupported` is for the one request that asks whether the feature exists at all. A 404 from a
 * mutation means "that account is not here", which is an ordinary refusal; treating it as "this daemon has
 * no accounts" would make the whole block disappear the first time a stale row was clicked.
 */
async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal, detectUnsupported = false): Promise<T> {
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
    // Offline or a dropped connection is not "this daemon is old": it is an unavailable service.
    throw new ModelSettingsError("service_unavailable");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  // A 404 means "no such route" only when asking for the list; the daemon answers it for paths it does not
  // serve. Any other request answers 404 for a different reason and keeps its own handling.
  if (detectUnsupported && response.status === 404) throw new AccountsUnsupportedError();
  if (!response.ok) {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const code = typeof record.error === "string" && CODES.has(record.error) ? record.error : "service_unavailable";
    const bindings = Array.isArray(record.bindings) ? record.bindings.filter((b): b is string => typeof b === "string") : undefined;
    throw new AccountsError(code as SettingsErrorCode | AccountsErrorCode, bindings);
  }
  return payload as T;
}

export const accountsApi = {
  list: (signal?: AbortSignal) => request<AccountsList>("/_nema/accounts", "GET", undefined, signal, true),
  create: (body: AccountCreate) => request<{ account: AccountView }>("/_nema/accounts", "POST", body),
  update: (body: AccountUpdate) => request<{ account: AccountView }>("/_nema/accounts", "PATCH", body),
  remove: (id: string) => request<{ deleted: string }>("/_nema/accounts", "DELETE", { id }),
  /** Write-only: nothing here ever reads a value back. */
  saveSecret: (id: string, kind: "byok" | "claude", value: string) =>
    request<{ saved: true }>("/_nema/accounts/secret", "POST", { id, kind, value }),
  bind: (scope: string, accountId: string | null) => request<{ scope: string; accountId: string | null }>("/_nema/accounts/bind", "POST", { scope, accountId }),
  login: (id: string) => request<{ state: "running" }>("/_nema/accounts/login", "POST", { id }),
  probe: (id: string) => request<{ state: "running" }>("/_nema/accounts/probe", "POST", { id, confirmQuotaUse: true }),
};

/**
 * The stored choice for a scope, exactly as stored: an account id, `"auto"`, or null for "not chosen"
 * (which follows the workspace, then the global default).
 *
 * `"auto"` is passed through rather than folded into null. A picker has to show what is actually stored —
 * the batch that unlocks automatic routing is not this one, and a thread bound to `auto` that displays
 * "follow the workspace" reads as a different choice than the one on disk.
 */
export function boundAccount(bindings: Record<string, string> | undefined, scope: string): string | null {
  return bindings?.[scope] ?? null;
}

/**
 * Whether a picker at this scope has anything to offer. Two accounts always means a choice; with one there
 * is only something to do if *this* scope already holds a choice, which the user may want to clear.
 *
 * It is deliberately not "does any binding exist": one thread's binding would then put a picker on every
 * message and every workspace, where it can neither change nor clear anything.
 */
export function pickerHasChoices(accounts: readonly AccountView[], current: string | null): boolean {
  return accounts.length > 1 || current !== null;
}
