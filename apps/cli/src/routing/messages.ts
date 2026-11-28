import { codedFields, TASK_ERROR, type CodeParams } from "@nema/shared";
import { ReloginRequiredError } from "../direct/authStore.js";

/**
 * The sentences that name a problem with the account the user chose, in one place.
 *
 * They live here rather than next to an adapter because both adapters need them and the routing module is the
 * one that decides which account is involved; importing them from an adapter would make the routing core
 * depend on the thing that calls it.
 */

/** A SIWC login that is not there. Same words 0.2.0 printed, and the same command still fixes it. */
export const NOT_LOGGED_IN = "未登录直连 Codex，请在终端运行 nema auth login";

/** A BYOK key that is not there. */
export const MISSING_BYOK_KEY = "没有 BYOK API key。请把钥匙从标准输入交给 nema auth byok。";

/** A Claude Code token that is not there. */
export const MISSING_CLAUDE_TOKEN = "没有 Claude Code token。请运行 claude setup-token，再把令牌从标准输入交给 nema auth claude。";

/** A compat account with no Codex CLI login to borrow. */
export const MISSING_CODEX_LOGIN = "没有可用的 Codex 登录。请先运行 codex login。";

/** A BYOK account with no model: the endpoint has no catalog to fall back to. */
export const BYOK_MODEL_REQUIRED = "BYOK 需要指定模型，请运行 nema config set model <名称>";

/*
 * The code each sentence above carries when it fails a task (#299 batch 3a). The sentence stays the fallback
 * text; the web shows `error.<code>` in the user's language and keeps the command it names verbatim.
 */
const CODE_OF: ReadonlyMap<string, string> = new Map([
  [NOT_LOGGED_IN, TASK_ERROR.authNotLoggedIn],
  [MISSING_BYOK_KEY, TASK_ERROR.byokKeyMissing],
  [MISSING_CLAUDE_TOKEN, TASK_ERROR.claudeTokenMissing],
  [MISSING_CODEX_LOGIN, TASK_ERROR.codexLoginMissing],
  [BYOK_MODEL_REQUIRED, TASK_ERROR.byokModelRequired],
]);

type AccountSentence = typeof NOT_LOGGED_IN | typeof MISSING_BYOK_KEY | typeof MISSING_CLAUDE_TOKEN | typeof MISSING_CODEX_LOGIN | typeof BYOK_MODEL_REQUIRED;

/** One of the sentences above with its code, for a refusal or a thrown error. */
export function accountCode(sentence: AccountSentence): string {
  return CODE_OF.get(sentence)!;
}

/**
 * The code and params a task failure carries for this error, or `{}`. A `CodedError` carries its own; a dead
 * direct login is a `ReloginRequiredError`, whose `code` is the OAuth reason it records in `auth.json` and so
 * cannot double as the UI code. Anything else (a provider error, a Node error) has none and is shown as text.
 */
export function failureFields(e: unknown): { code?: string; params?: CodeParams } {
  if (e instanceof ReloginRequiredError) return { code: TASK_ERROR.authReloginRequired };
  return codedFields(e);
}
