import { z } from "zod";
import { normalizeByokBaseUrl } from "../config.js";

/**
 * Accounts are the unit the user manages: one credential + one endpoint + one default model
 * (spec 2026-10-31 §2.1). They live on the daemon's machine only; nothing here is stored in the
 * hub database, and nothing here holds a credential value.
 */

/**
 * The account synthesized from `config.json` and the old single-key files when `accounts.json` does
 * not exist (D-6). All zeros is reserved: `newAccountId()` refuses to produce it, so a stored account
 * can never be mistaken for the implicit one.
 */
export const IMPLICIT_ACCOUNT_ID = "acct_0000000000";

export const COST_TIERS = ["low", "standard", "high"] as const;
export type CostTier = (typeof COST_TIERS)[number];

const ID_PATTERN = /^acct_[a-z0-9]{10}$/;
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A stored account id. The reserved implicit id is refused here: it only ever names the account synthesized
 * from `config.json` (D-6), whose files stay at the legacy paths, so a stored row carrying it would be read
 * as that account and point at the wrong credential.
 */
export const AccountIdSchema = z
  .string()
  .regex(ID_PATTERN, "账户 id 必须是 acct_ 加 10 位小写字母或数字")
  .refine((id) => id !== IMPLICIT_ACCOUNT_ID, "不能使用保留的账户 id");

const CapabilitiesSchema = z
  .object({
    image: z.boolean().optional(),
    pdf: z.boolean().optional(),
    contextTokens: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Account endpoints go through the same rule as `config.json`: nothing is copied from that validation, the
 * function itself is called. A looser rule here would be a second way for a BYOK key to leave the machine.
 *
 * The *normalized* value is what gets stored (`normalizeByokBaseUrl` drops a trailing slash), because
 * consumers build request paths by appending to it: `https://host/v1/` + `/responses` would be a
 * double-slash path. Config already stores the normalized form, so the two stay byte-identical.
 */
function normalizedBaseUrl(raw: string): string | null {
  try {
    return normalizeByokBaseUrl(raw);
  } catch {
    return null;
  }
}

/** The shared rule's own message, for the validation report. */
function baseUrlProblem(raw: string): string | null {
  try {
    normalizeByokBaseUrl(raw);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export const AccountSchema = z
  .object({
    id: AccountIdSchema,
    name: z.string().min(1).max(40),
    enabled: z.boolean(),
    adapter: z.enum(["codex-direct", "claude-code"]),
    authMode: z.enum(["siwc", "compat", "byok"]).optional(),
    // A stored endpoint is normalized, so a trailing slash never survives into request path building.
    baseUrl: z
      .string()
      .min(1)
      .transform((raw) => normalizedBaseUrl(raw) ?? raw)
      .optional(),
    model: z.string().min(1).optional(),
    /** Per-model overrides of the account's declared capabilities (layer 1 of spec §4.2). */
    modelCapabilities: z.record(z.string(), CapabilitiesSchema).optional(),
    capabilities: CapabilitiesSchema.optional(),
    costTier: z.enum(COST_TIERS),
    /** Lower is tried first. Not a preference over costTier: it is the user's own ordering. */
    order: z.number().int().min(0),
    createdAt: z.string().min(1),
  })
  .strict()
  .superRefine((account, ctx) => {
    if (account.baseUrl === undefined) return;
    const problem = baseUrlProblem(account.baseUrl);
    if (problem !== null) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: problem });
  });

export type Account = z.infer<typeof AccountSchema>;

export const AccountsFileSchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(AccountSchema),
    /** `ws:<id>` or `thread:<id>` -> account id or "auto". A missing key means "not chosen". */
    bindings: z.record(z.string(), z.string()),
  })
  .strict();

export type AccountsFile = z.infer<typeof AccountsFileSchema>;

const SCOPE_PATTERN = /^(?:ws|thread):[^\s]+$/;

/**
 * A random, permanent id. Account names are display only, so renaming never touches a binding, a
 * `meta.route` record or a log line. `random` is injectable for tests.
 *
 * `taken` is the set of ids already stored (or the account whose id must not be reused): an id names a
 * credential directory, so a collision would copy one account's credential over another's. A draw that
 * is already taken is retried, and a generator that cannot produce a free id fails instead of returning
 * one.
 */
export function newAccountId(
  random: () => string = () =>
    Array.from({ length: 10 }, () => ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]!).join(""),
  taken: (id: string) => boolean = () => false,
): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = `acct_${random()}`;
    if (ID_PATTERN.test(id) && id !== IMPLICIT_ACCOUNT_ID && !taken(id)) return id;
  }
  throw new Error("无法生成账户 id");
}

const SECRET_LIKE = /^[A-Za-z0-9_\-+/=]{20,}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Why this display name cannot be used, or null. Names are user text; they are never a credential. */
export function accountNameProblem(raw: string): string | null {
  if (raw.trim() === "") return "名字不能为空";
  if (Array.from(raw).length > 40) return "名字最多 40 个字符";
  if (CONTROL.test(raw)) return "名字不能包含控制字符";
  if (SECRET_LIKE.test(raw.trim())) return "这个名字看起来像密钥，换一个普通名字";
  return null;
}

/**
 * How to name a row in an error without echoing it. The id is the only part of a row we trust to print:
 * a name is free text, and a credential pasted into it need not match `SECRET_LIKE` to be one (a short
 * key, a fragment). Messages are shown in the settings page and can reach a log.
 */
function rowLabel(account: { id: string }): string {
  // The reserved id is a literal we own, so naming it is safe and clearer than "an account".
  if (account.id === IMPLICIT_ACCOUNT_ID) return `账户 ${IMPLICIT_ACCOUNT_ID}`;
  // Any other id is printed only when it has the right shape: a file can carry free text in that field
  // (a pasted key, a fragment), and a message must not repeat it.
  return ID_PATTERN.test(account.id) ? `账户 ${account.id}` : "账户（id 不合法，未显示）";
}

/**
 * Every problem with a whole file, as user-facing Chinese sentences. An empty list means it is usable.
 * This is what `readAccounts` reports as `unusable/invalid`, so each message names the offending row.
 */
export function validateAccountsFile(file: AccountsFile): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Map<string, string>();
  const seenIdsOf = new Map<string, string>();
  // An id is printable only when it is one this file format allows; anything else may be pasted text.
  const printableId = (id: string | undefined): string =>
    id !== undefined && ID_PATTERN.test(id) && id !== IMPLICIT_ACCOUNT_ID ? `账户 ${id}` : "另一个账户";

  for (const account of file.accounts) {
    const label = rowLabel(account);
    if (account.id === IMPLICIT_ACCOUNT_ID) problems.push(`${label}：不能使用保留的账户 id`);
    else if (!ID_PATTERN.test(account.id)) problems.push(`${label}：id 不合法`);
    if (seenIds.has(account.id)) problems.push(`${label}：账户 id 重复`);
    seenIds.add(account.id);

    const name = account.name.toLowerCase();
    const first = seenNames.get(name);
    if (first !== undefined) {
      // Names are never quoted: a pasted credential can be a name. Both rows are named by id instead.
      problems.push(`账户重名（不分大小写）：${printableId(seenIdsOf.get(name))} 与 ${printableId(account.id)}`);
    } else {
      seenNames.set(name, account.name);
      seenIdsOf.set(name, account.id);
    }

    const nameProblem = accountNameProblem(account.name);
    if (nameProblem !== null) problems.push(`${label}：${nameProblem}`);

    if (account.adapter === "claude-code") {
      if (account.authMode !== undefined) problems.push(`${label}：claude-code 账户不应带 authMode`);
      if (account.baseUrl !== undefined) problems.push(`${label}：claude-code 账户不应带 baseUrl`);
    } else if (account.authMode === undefined) {
      problems.push(`${label}：codex-direct 账户必须有 authMode`);
    } else if (account.authMode === "byok" && account.baseUrl === undefined) {
      problems.push(`${label}：byok 账户必须有 baseUrl`);
    } else if (account.authMode === "byok" && account.baseUrl !== undefined) {
      const problem = baseUrlProblem(account.baseUrl);
      if (problem !== null) problems.push(`${label}：${problem}`);
    } else if (account.authMode !== "byok" && account.baseUrl !== undefined) {
      problems.push(`${label}：${account.authMode} 账户不应带 baseUrl`);
    }
  }

  // A scope and a binding value are both free text a user may have pasted a key into; neither is ever
  // echoed. The binding is identified by its position instead, which the settings page can map back.
  let index = 0;
  for (const [scope, value] of Object.entries(file.bindings)) {
    index += 1;
    const where = `第 ${index} 个绑定`;
    if (!SCOPE_PATTERN.test(scope)) problems.push(`${where}的 scope 不合法（只接受 ws: 或 thread: 前缀）`);
    // "auto" and a known id are the only values a binding may hold; anything else names no account.
    if (value !== "auto" && (value === IMPLICIT_ACCOUNT_ID || !seenIds.has(value))) {
      problems.push(`${where}指向一个不存在的账户`);
    }
  }

  return problems;
}
