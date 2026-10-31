import { z } from "zod";

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

export const AccountIdSchema = z.string().regex(ID_PATTERN, "账户 id 必须是 acct_ 加 10 位小写字母或数字");

const CapabilitiesSchema = z
  .object({
    image: z.boolean().optional(),
    pdf: z.boolean().optional(),
    contextTokens: z.number().int().positive().optional(),
  })
  .strict();

export const AccountSchema = z
  .object({
    id: AccountIdSchema,
    name: z.string().min(1).max(40),
    enabled: z.boolean(),
    adapter: z.enum(["codex-direct", "claude-code"]),
    authMode: z.enum(["siwc", "compat", "byok"]).optional(),
    baseUrl: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    /** Per-model overrides of the account's declared capabilities (layer 1 of spec §4.2). */
    modelCapabilities: z.record(z.string(), CapabilitiesSchema).optional(),
    capabilities: CapabilitiesSchema.optional(),
    costTier: z.enum(COST_TIERS),
    /** Lower is tried first. Not a preference over costTier: it is the user's own ordering. */
    order: z.number().int().min(0),
    createdAt: z.string().min(1),
  })
  .strict();

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
 */
export function newAccountId(random: () => string = () =>
  Array.from({ length: 10 }, () => ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]!).join(""),
): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = `acct_${random()}`;
    if (ID_PATTERN.test(id) && id !== IMPLICIT_ACCOUNT_ID) return id;
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
 * Every problem with a whole file, as user-facing Chinese sentences. An empty list means it is usable.
 * This is what `readAccounts` reports as `unusable/invalid`, so each message names the offending row.
 */
export function validateAccountsFile(file: AccountsFile): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Map<string, string>();

  for (const account of file.accounts) {
    if (seenIds.has(account.id)) problems.push(`账户 id 重复：${account.id}`);
    seenIds.add(account.id);

    const name = account.name.toLowerCase();
    const first = seenNames.get(name);
    if (first !== undefined) problems.push(`账户重名（不分大小写）：「${account.name}」与「${first}」`);
    else seenNames.set(name, account.name);

    const nameProblem = accountNameProblem(account.name);
    if (nameProblem !== null) problems.push(`账户「${account.name}」：${nameProblem}`);

    if (account.adapter === "claude-code") {
      if (account.authMode !== undefined) problems.push(`账户「${account.name}」：claude-code 账户不应带 authMode`);
      if (account.baseUrl !== undefined) problems.push(`账户「${account.name}」：claude-code 账户不应带 baseUrl`);
    } else if (account.authMode === undefined) {
      problems.push(`账户「${account.name}」：codex-direct 账户必须有 authMode`);
    } else if (account.authMode === "byok" && account.baseUrl === undefined) {
      problems.push(`账户「${account.name}」：byok 账户必须有 baseUrl`);
    } else if (account.authMode !== "byok" && account.baseUrl !== undefined) {
      problems.push(`账户「${account.name}」：${account.authMode} 账户不应带 baseUrl`);
    }
  }

  for (const [scope, value] of Object.entries(file.bindings)) {
    if (!SCOPE_PATTERN.test(scope)) problems.push(`绑定的 scope 不合法：${scope}（只接受 ws: 或 thread: 前缀）`);
    if (value !== "auto" && !seenIds.has(value)) problems.push(`绑定 ${scope} 指向一个不存在的账户：${value}`);
  }

  return problems;
}
