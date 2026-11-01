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
