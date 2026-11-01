import {
  AccountSchema,
  IMPLICIT_ACCOUNT_ID,
  validateAccountsFile,
  accountCredentialState,
  accountNameProblem,
  loadAccounts,
  materializeImplicit,
  newAccountId,
  readAccounts,
  removeAccountSecrets,
  saveAccountSecret,
  updateAccounts,
  type Account,
  type AccountsFile,
  type AccountSecretKind,
  type CredentialState,
} from "@nema/cli/localSettings";
import { loadConfig, type NemaConfig } from "@nema/cli/config";

/**
 * `/_nema/accounts*`: the settings API for the accounts a machine has (spec 2026-10-31 §5.3).
 *
 * It is mounted inside the existing settings dispatch, so it inherits that service's session check, its
 * `no-store` header, its JSON content-type rule and its habit of answering with a code and no detail.
 * Nothing here returns a credential value, and no message repeats one: a name is user text and an id may
 * have been written by hand, so rows are named by an id that passes the format check.
 *
 * This batch only manages settings. Routing arrives in S3; a stored choice is written here and read there.
 */

export type AccountView = {
  id: string;
  name: string;
  enabled: boolean;
  adapter: Account["adapter"];
  authMode?: Account["authMode"];
  baseUrl?: string;
  model?: string;
  capabilities?: Account["capabilities"];
  costTier: Account["costTier"];
  order: number;
  credential: CredentialState;
  implicit: boolean;
};

export type AccountsReply = { status: number; body: Record<string, unknown> };

/**
 * The pieces of the outside world this module touches. Every one is injected so a test never opens a
 * browser, sends a request, or writes to a real home directory.
 */
export type AccountsDeps = {
  home: string;
  codexHome: string;
  /** Runs the browser login for one account. Resolves with the outcome; it never returns a token. */
  login: (account: Account, signal: AbortSignal) => Promise<{ ok: boolean }>;
  /** Injectable for tests: the store reads. */
  readAccounts?: typeof readAccounts;
  /** Injectable for tests: the credential state. */
  credentialState?: typeof accountCredentialState;
  /** Injectable for tests: removing an account's credential directory. */
  removeAccountSecrets?: typeof removeAccountSecrets;
  /**
   * Aborted when the owning service stops accepting work. Combined with the login's own timeout, so a
   * browser login the user abandoned cannot hold `close()` open for its full five minutes.
   */
  signal?: AbortSignal;
};

const ID_SHAPE = /^acct_[a-z0-9]{10}$/;
const SCOPE_SHAPE = /^(?:ws|thread):[^\s]+$/;
const NOT_FOUND: AccountsReply = { status: 404, body: { error: "not_found" } };
const INVALID: AccountsReply = { status: 400, body: { error: "invalid_request" } };
const INTERNAL: AccountsReply = { status: 500, body: { error: "internal_error" } };

/**
 * One running login or probe at a time, the same rule the existing settings routes keep for their own two
 * jobs. A browser login waits for a person, so a second one would race it for the same account's file.
 */
let job: { promise: Promise<void>; done: boolean } | undefined;

function jobRunning(): boolean {
  return job !== undefined && !job.done;
}

/** Only for tests: forget a job left behind by a previous case. */
export function resetAccountsJobs(): void {
  job = undefined;
}

function startJob(run: () => Promise<unknown>): boolean {
  if (jobRunning()) return false;
  const current: { promise: Promise<void>; done: boolean } = {
    promise: Promise.resolve(),
    done: false,
  };
  job = current;
  current.promise = run().then(
    () => { current.done = true; },
    () => { current.done = true; },
  );
  return true;
}

/** Awaited by the settings service before it closes, so a login cannot outlive the process that owns it. */
export async function accountsJobsSettled(): Promise<void> {
  if (job) await job.promise;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function keysAre(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** An account id a request may name: the shape only. The reserved synthesized id is not addressable. */
function requestId(value: unknown): string | null {
  return typeof value === "string" && ID_SHAPE.test(value) && value !== IMPLICIT_ACCOUNT_ID ? value : null;
}

function view(account: Account, deps: AccountsDeps, implicit: boolean): AccountView {
  let credential: CredentialState = "missing";
  try {
    credential = (deps.credentialState ?? accountCredentialState)(deps.home, account, deps.codexHome).state;
  } catch {
    // The directory could not be inspected: an unverified credential is not a connected one.
    credential = "unusable";
  }
  return {
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    adapter: account.adapter,
    ...(account.authMode !== undefined ? { authMode: account.authMode } : {}),
    ...(account.baseUrl !== undefined ? { baseUrl: account.baseUrl } : {}),
    ...(account.model !== undefined ? { model: account.model } : {}),
    ...(account.capabilities !== undefined ? { capabilities: account.capabilities } : {}),
    costTier: account.costTier,
    order: account.order,
    credential,
    implicit,
  };
}

function config(home: string): NemaConfig {
  return loadConfig(home);
}

/** The stored file, or null when there is none. An unusable file is not silently replaced. */
function currentFile(deps: AccountsDeps): AccountsFile | null {
  const read = (deps.readAccounts ?? readAccounts)(deps.home);
  if (read.status === "unusable") throw new AccountsUnusable(read.reason);
  return read.status === "ok" ? read.file : null;
}

class AccountsUnusable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AccountsUnusable";
  }
}

/**
 * The list this machine presents, plus the file it came from.
 *
 * A missing or unusable file yields the synthesized account (D-6) and says the list is implicit. An
 * unusable file also reports why, and the caller must not offer to edit what it cannot read.
 */
function snapshot(deps: AccountsDeps): { accounts: Account[]; implicit: boolean; unusableReason?: string; bindings: Record<string, string> } {
  const loaded = loadAccounts(deps.home, config(deps.home), deps.codexHome);
  const read = (deps.readAccounts ?? readAccounts)(deps.home);
  const bindings = read.status === "ok" ? read.file.bindings : {};
  return {
    accounts: loaded.accounts,
    implicit: loaded.implicit,
    ...(loaded.unusableReason !== undefined ? { unusableReason: loaded.unusableReason } : {}),
    bindings,
  };
}

function listReply(deps: AccountsDeps): AccountsReply {
  const state = snapshot(deps);
  return {
    status: 200,
    body: {
      ...(state.unusableReason !== undefined ? { unusableReason: state.unusableReason } : {}),
      ...(state.unusableReason === undefined
        ? {
            accounts: state.accounts.map((a) => view(a, deps, state.implicit)),
            defaultAccountId: defaultAccountId(state.accounts),
          }
        : {}),
      bindings: state.bindings,
    },
  };
}

/** The global default: the enabled account the user ordered first (spec §1.2). */
export function defaultAccountId(accounts: Account[]): string {
  const enabled = accounts.filter((a) => a.enabled).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return enabled[0]?.id ?? "";
}

/**
 * The account a request names, read from the current file rather than trusted as a field on the body.
 * `null` means "not here", which a caller answers with 404.
 */
function findAccount(deps: AccountsDeps, id: string): Account | null {
  return snapshot(deps).accounts.find((a) => a.id === id) ?? null;
}

/** A name that is free among accounts other than `exceptId`, compared without case as the schema does. */
function nameTaken(accounts: Account[], name: string, exceptId?: string): boolean {
  const lowered = name.trim().toLowerCase();
  return accounts.some((a) => a.id !== exceptId && a.name.toLowerCase() === lowered);
}

type CreateBody = {
  name: string;
  enabled?: boolean;
  adapter: Account["adapter"];
  authMode?: Account["authMode"];
  baseUrl?: string;
  model?: string;
  capabilities?: Account["capabilities"];
  costTier?: Account["costTier"];
  order?: number;
};
const CREATE_KEYS = ["name", "enabled", "adapter", "authMode", "baseUrl", "model", "capabilities", "costTier", "order"] as const;

/**
 * Builds the row a create request asks for and validates it with the store's own schema, so what is
 * written is exactly what `readAccounts` accepts. The reserved id and `createdAt` are set here.
 */
function buildAccount(body: CreateBody, taken: (id: string) => boolean): Account {
  const candidate: Record<string, unknown> = {
    id: newAccountId(undefined, taken),
    name: body.name,
    enabled: body.enabled ?? true,
    adapter: body.adapter,
    costTier: body.costTier ?? "standard",
    order: body.order ?? 0,
    createdAt: new Date().toISOString(),
  };
  for (const key of ["authMode", "baseUrl", "model", "capabilities"] as const) {
    if (body[key] !== undefined) candidate[key] = body[key];
  }
  return AccountSchema.parse(candidate);
}

/**
 * Applies a patch to one row, dropping the keys it clears. The merged row goes through the schema, which is
 * what stops an edit from leaving a combination the store would refuse on the next read (a byok account
 * with no endpoint, an auth mode on a Claude account).
 */
function applyPatch(account: Account, patch: Record<string, unknown>): Account {
  const merged: Record<string, unknown> = { ...account };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "id") continue;
    if (value === null || value === undefined) delete merged[key];
    else merged[key] = value;
  }
  // Changing an account's kind has to take the old kind's fields with it, or the edit cannot be made at
  // all: a `claude-code` row carrying `authMode` (or `baseUrl`) is refused by `validateAccountsFile`, so
  // switching a keyed account to Claude would answer 400 and leave the row as it was. The same rule the
  // config projection applies when a rollback switches adapter.
  if (merged.adapter === "claude-code") {
    delete merged.authMode;
    delete merged.baseUrl;
  }
  return AccountSchema.parse(merged);
}

const PATCH_KEYS = ["id", "name", "enabled", "adapter", "authMode", "baseUrl", "model", "capabilities", "costTier", "order"] as const;

/** Which scopes hold this account, in a stable order, for the "still in use" answer. */
export function scopesBoundTo(bindings: Record<string, string>, accountId: string): string[] {
  return Object.entries(bindings)
    .filter(([, value]) => value === accountId)
    .map(([scope]) => scope)
    .sort();
}

/**
 * Every account route. `null` means "not mine": the settings dispatch then runs its own branches and ends
 * at the same 404 an unknown path has always produced, so an older web sees no change.
 */
export function handleAccounts(method: string, pathname: string, body: unknown, deps: AccountsDeps): AccountsReply | null {
  if (!pathname.startsWith("/_nema/accounts")) return null;
  const route = pathname === "/_nema/accounts" ? "collection" : pathname.slice("/_nema/accounts".length);
  try {
    if (route === "collection") {
      if (method === "GET") return listReply(deps);
      if (method === "POST") return create(body, deps);
      if (method === "PATCH") return patch(body, deps);
      if (method === "DELETE") return remove(body, deps);
      return null;
    }
    if (route === "/secret" && method === "POST") return saveSecret(body, deps);
    if (route === "/bind" && method === "POST") return bind(body, deps);
    if (route === "/login" && method === "POST") return login(body, deps);
    if (route === "/probe" && method === "POST") return probe(body, deps);
    return null;
  } catch (e) {
    if (e instanceof AccountsUnusable) return { status: 409, body: { error: "accounts_unusable", reason: e.reason } };
    // `AccountsFileSchema` and `AccountSchema` refuse what the store would refuse.
    if (e instanceof SyntaxError || (e && typeof e === "object" && "issues" in e)) return INVALID;
    return INTERNAL;
  }
}

/** What a mutation decided, so a refusal can be answered with the code that names it. */
type Refusal = "exists" | "invalid" | "missing" | null;

/**
 * Validates the whole file a mutation would leave behind, with the same rules `readAccounts` applies.
 * `AccountSchema` alone does not cover the combinations that span fields (a byok account without an
 * endpoint, a Claude account carrying an auth mode), so a write that only passed the schema would make
 * the file read back as `invalid` and every account disappear from the app.
 */
function refusesFile(accounts: Account[], bindings: Record<string, string>): boolean {
  return validateAccountsFile({ version: 1, accounts, bindings }).length > 0;
}

function create(body: unknown, deps: AccountsDeps): AccountsReply {
  const raw = record(body);
  if (!raw || !keysAre(raw, CREATE_KEYS)) return INVALID;
  if (typeof raw.name !== "string" || accountNameProblem(raw.name) !== null) return INVALID;
  if (!["codex-direct", "claude-code"].includes(String(raw.adapter))) return INVALID;
  const state = snapshot(deps);
  // An unusable file must not be replaced by a fresh snapshot: its rows may still be recoverable.
  if (state.unusableReason !== undefined) return { status: 409, body: { error: "accounts_unusable", reason: state.unusableReason } };
  if (nameTaken(state.accounts, raw.name)) return { status: 409, body: { error: "account_exists" } };

  // The user's first edit is what turns the in-memory synthesized account into a stored row (D-6).
  if (currentFile(deps) === null) {
    materializeImplicit({ nemaHome: deps.home, config: config(deps.home), codexHome: deps.codexHome, name: "默认账户" });
  }
  let created: Account | null = null;
  let refusal: Refusal = null;
  const next = updateAccounts(deps.home, (current) => {
    const accounts = current?.accounts ?? [];
    const bindings = current?.bindings ?? {};
    if (nameTaken(accounts, raw.name as string)) {
      refusal = "exists";
      return null;
    }
    let row: Account;
    try {
      row = buildAccount(
        raw as CreateBody,
        (id) => accounts.some((a) => a.id === id) || id === IMPLICIT_ACCOUNT_ID,
      );
    } catch {
      refusal = "invalid";
      return null;
    }
    // A new row sorts after the ones already there unless the request says otherwise.
    const ordered = raw.order === undefined
      ? { ...row, order: accounts.reduce((max, a) => Math.max(max, a.order + 1), 0) }
      : row;
    if (refusesFile([...accounts, ordered], bindings)) {
      refusal = "invalid";
      return null;
    }
    created = ordered;
    return { version: 1, accounts: [...accounts, ordered], bindings };
  });
  if (refusal === "exists") return { status: 409, body: { error: "account_exists" } };
  if (refusal === "invalid") return INVALID;
  if (next === null || created === null) return NOT_FOUND;
  return { status: 201, body: { account: view(created, deps, false) } };
}

function patch(body: unknown, deps: AccountsDeps): AccountsReply {
  const raw = record(body);
  if (!raw || !keysAre(raw, PATCH_KEYS)) return INVALID;
  const id = requestId(raw.id);
  if (id === null) return NOT_FOUND;
  if ("name" in raw && (typeof raw.name !== "string" || accountNameProblem(raw.name) !== null)) return INVALID;
  const patchKeys = Object.keys(raw).filter((key) => key !== "id");
  if (patchKeys.length === 0) return INVALID;

  let updated: Account | null = null;
  let refusal: Refusal = null;
  const next = updateAccounts(deps.home, (current) => {
    if (current === null) {
      refusal = "missing";
      return null;
    }
    const index = current.accounts.findIndex((a) => a.id === id);
    if (index < 0) {
      refusal = "missing";
      return null;
    }
    if (typeof raw.name === "string" && nameTaken(current.accounts, raw.name, id)) {
      refusal = "exists";
      return null;
    }
    let row: Account;
    try {
      row = applyPatch(current.accounts[index]!, raw);
    } catch {
      refusal = "invalid";
      return null;
    }
    const accounts = current.accounts.map((a, i) => (i === index ? row : a));
    // `remove` refuses to take the last enabled account away, because the global default is "the first
    // enabled account" and without one there is nothing to fall back to. Disabling it through an edit
    // reaches the same state, so it is refused the same way rather than leaving `defaultAccountId` empty.
    const disablingLastEnabled = current.accounts[index]!.enabled && !row.enabled && !accounts.some((a) => a.enabled);
    if (disablingLastEnabled || refusesFile(accounts, current.bindings)) {
      refusal = "invalid";
      return null;
    }
    updated = row;
    return { version: 1, accounts, bindings: current.bindings };
  });
  if (refusal === "exists") return { status: 409, body: { error: "account_exists" } };
  if (refusal === "invalid") return INVALID;
  if (refusal === "missing" || next === null || updated === null) return NOT_FOUND;
  return { status: 200, body: { account: view(updated, deps, false) } };
}

function remove(body: unknown, deps: AccountsDeps): AccountsReply {
  const raw = record(body);
  if (!raw || !keysAre(raw, ["id"])) return INVALID;
  const id = requestId(raw.id);
  if (id === null) return NOT_FOUND;
  const state = snapshot(deps);
  const target = state.accounts.find((a) => a.id === id);
  if (!target) return NOT_FOUND;
  if (state.unusableReason !== undefined) return { status: 409, body: { error: "accounts_unusable", reason: state.unusableReason } };

  // A scope that still points here would be left naming nothing, so nothing is deleted until it is cleared.
  const bound = scopesBoundTo(state.bindings, id);
  if (bound.length > 0) return { status: 409, body: { error: "account_in_use", bindings: bound } };

  // The last enabled account is what the global default resolves to; without it no task has a default.
  const enabledLeft = state.accounts.filter((a) => a.enabled && a.id !== id).length;
  if (target.enabled && enabledLeft === 0) return INVALID;

  // The credential goes first, inside the same lock as the record, and the record is written only after the
  // directory is actually gone.
  //
  // That order is what makes a failed cleanup retryable. Removing the record first and the directory second
  // meant a failure (a busy file, a read-only parent, an I/O error) answered 500 while the record was
  // already gone: the next DELETE found nothing to delete, answered 404, and the credential stayed on disk
  // for good. Here a failure changes nothing at all — the account keeps its record and its credential, and
  // the same DELETE simply works when the filesystem stops refusing.
  //
  // The other order is also the one that cannot produce the state the old comment ruled out. A crash between
  // the two steps leaves a record whose credential directory is missing, which is reported honestly as
  // `missing` and can be filled in again; it never leaves a row pointing at somebody else's credential,
  // because the id is never reused (see `create`) and `accountDir` still refuses the reserved id and any
  // symlinked component.
  let failure: unknown = null;
  const next = updateAccounts(deps.home, (current) => {
    if (current === null) return null;
    if (!current.accounts.some((a) => a.id === id)) return null;
    try {
      (deps.removeAccountSecrets ?? removeAccountSecrets)(deps.home, id);
    } catch (e) {
      // Out of the lock and out of the file: the record stays exactly as it was.
      failure = e;
      return null;
    }
    return { version: 1, accounts: current.accounts.filter((a) => a.id !== id), bindings: current.bindings };
  });
  // A cleanup that failed after the removal must not look like "this account is not here": that is the
  // answer that made retrying pointless.
  if (failure !== null) return INTERNAL;
  if (next === null) return NOT_FOUND;
  return { status: 200, body: { deleted: id } };
}

const SECRET_KINDS: Record<"byok" | "claude", AccountSecretKind> = { byok: "key", claude: "token" };

function saveSecret(body: unknown, deps: AccountsDeps): AccountsReply {
  const raw = record(body);
  if (!raw || !keysAre(raw, ["id", "kind", "value"])) return INVALID;
  const id = requestId(raw.id);
  if (id === null) return NOT_FOUND;
  const kind = raw.kind === "byok" || raw.kind === "claude" ? raw.kind : null;
  if (kind === null) return INVALID;
  // One line, non-empty, no line breaks: the same rule the single-key route applies to its own writes.
  if (typeof raw.value !== "string" || raw.value.length === 0 || /[\r\n]/.test(raw.value)) return INVALID;
  const account = findAccount(deps, id);
  if (account === null) return NOT_FOUND;
  // A credential kind the account cannot hold would sit beside the one it does and make both ambiguous.
  const expected = account.adapter === "claude-code" ? "claude" : account.authMode === "byok" ? "byok" : null;
  if (expected === null || expected !== kind) return INVALID;
  saveAccountSecret(deps.home, id, SECRET_KINDS[kind], raw.value);
  return { status: 200, body: { saved: true } };
}

function bind(body: unknown, deps: AccountsDeps): AccountsReply {
  const raw = record(body);
  if (!raw || !keysAre(raw, ["scope", "accountId"])) return INVALID;
  if (typeof raw.scope !== "string" || !SCOPE_SHAPE.test(raw.scope)) return INVALID;
  const scope = raw.scope;
  const rawValue: unknown = raw.accountId;
  if (rawValue !== null && rawValue !== "auto" && requestId(rawValue) === null) return INVALID;
  const value = rawValue === null || rawValue === "auto" ? rawValue : (rawValue as string);
  const state = snapshot(deps);
  if (state.unusableReason !== undefined) return { status: 409, body: { error: "accounts_unusable", reason: state.unusableReason } };
  if (value !== null && value !== "auto" && !state.accounts.some((a) => a.id === value)) return INVALID;

  const next = updateAccounts(deps.home, (current) => {
    if (current === null) return null;
    const bindings = { ...current.bindings };
    if (value === null) delete bindings[scope];
    else bindings[scope] = value;
    return { version: 1, accounts: current.accounts, bindings };
  });
  if (next === null) return NOT_FOUND;
  return { status: 200, body: { scope, accountId: value } };
}

const LOGIN_KEYS = ["id"] as const;

/**
 * Browser login for one account. Only a `siwc` account has one: `compat` uses the Codex CLI's own login,
 * and a key or token account is authenticated by the credential the user pasted.
 */
function login(body: unknown, deps: AccountsDeps): AccountsReply {
  const raw = record(body);
  if (!raw || !keysAre(raw, LOGIN_KEYS)) return INVALID;
  const id = requestId(raw.id);
  if (id === null) return NOT_FOUND;
  const account = findAccount(deps, id);
  if (account === null) return NOT_FOUND;
  if (account.adapter !== "codex-direct" || account.authMode !== "siwc") return { status: 409, body: { error: "login_not_applicable" } };
  // The timeout is this route's own bound; the shutdown signal is the service's. Both apply: a login is
  // abandoned either when it has run too long or when the process that owns it is going away.
  const timeout = AbortSignal.timeout(300_000);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  if (!startJob(() => deps.login(account, signal))) return { status: 409, body: { error: "job_conflict" } };
  return { status: 202, body: { state: "running" } };
}

const PROBE_KEYS = ["id", "confirmQuotaUse"] as const;

/**
 * The probe sends a real model request, so it keeps the existing route's confirmation gate. Per-account
 * transport belongs to the routing batch; until then this answers `probe_not_supported` rather than
 * probing the *default* account while the page says it probed this one.
 */
function probe(body: unknown, deps: AccountsDeps): AccountsReply {
  const raw = record(body);
  if (!raw || !keysAre(raw, PROBE_KEYS) || raw.confirmQuotaUse !== true) return INVALID;
  const id = requestId(raw.id);
  if (id === null) return NOT_FOUND;
  if (findAccount(deps, id) === null) return NOT_FOUND;
  return { status: 409, body: { error: "probe_not_supported" } };
}
