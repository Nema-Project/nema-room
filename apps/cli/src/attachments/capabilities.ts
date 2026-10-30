import type { AttachmentCapabilities, AttachmentKind, AttachmentRef, AttachmentSupport } from "@nema/shared";
import { DEFAULT_BYOK_BASE_URL, type NemaConfig } from "../config.js";

/** Abilities this daemon advertises in `hello.features`: both adapters deliver attachments (plan B4). */
export const DAEMON_FEATURES: readonly string[] = ["attachments"];

type Table = Pick<AttachmentCapabilities, "image" | "pdf" | "text">;

// Only "native" combinations get native blocks (D-2 A). "unknown" stays refused until a real-model check (plan B8).
const CLAUDE: Table = { image: "native", pdf: "unknown", text: "text" };
const OPENAI: Table = { image: "native", pdf: "native", text: "text" };
const UNVERIFIED: Table = { image: "unknown", pdf: "unknown", text: "text" };
// OpenRouter (BYOK): images were read in a real-model run on 2026-10-30
// (docs/reviews/2026-10-30-attachments-model-acceptance.md). PDFs are not reclassified here.
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER: Table = { image: "native", pdf: "unknown", text: "text" };

// Compared after normalization (host case, default port, trailing slashes), not as typed.
const sameEndpoint = (a: string, b: string): boolean => {
  const key = (u: URL) => `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  return key(new URL(a)) === key(new URL(b));
};

/** What the configured adapter can take, per attachment kind. Read fresh from config for every call. */
export function attachmentCapabilities(config: NemaConfig): AttachmentCapabilities {
  if (config.adapter === "claude-code") return { adapter: "claude-code", ...CLAUDE };
  const adapter = `codex-direct (${config.authMode})`;
  if (config.authMode === "siwc") return { adapter, ...OPENAI };
  // Same base URL resolution as direct/adapter.ts: only OpenAI's own endpoint is known to take files.
  if (config.authMode === "byok") {
    const baseUrl = config.byokBaseUrl ?? DEFAULT_BYOK_BASE_URL;
    if (sameEndpoint(baseUrl, DEFAULT_BYOK_BASE_URL)) return { adapter, ...OPENAI };
    if (sameEndpoint(baseUrl, OPENROUTER_BASE_URL)) return { adapter, ...OPENROUTER };
  }
  return { adapter, ...UNVERIFIED };
}

const KIND_LABEL: Record<AttachmentKind, string> = { image: "图片", pdf: "PDF", text: "文本文件" };
const SUPPORT_LABEL: Record<AttachmentSupport, string> = {
  native: "",
  text: "",
  unsupported: "不支持",
  unknown: "未经验证，按不支持处理",
};
// Combinations whose support is "native" today, offered as the way out.
const ALTERNATIVES: Record<AttachmentKind, string> = {
  image: "请切换到 claude-code 或 codex-direct（siwc 登录），或把内容转成文本后再发",
  pdf: "请切换到 codex-direct（siwc 登录），或把内容转成图片或文本后再发",
  text: "请把内容直接贴进消息后再发",
};

const deliverable = (support: AttachmentSupport) => support === "native" || support === "text";

/** A specific Chinese reason when some attachment cannot be delivered as-is; null when all can. */
export function refusal(caps: AttachmentCapabilities, refs: readonly AttachmentRef[]): string | null {
  const reasons: string[] = [];
  for (const kind of ["image", "pdf", "text"] as const) {
    if (deliverable(caps[kind])) continue;
    const names = refs.filter((r) => r.kind === kind).map((r) => `「${r.name}」`);
    if (names.length === 0) continue;
    reasons.push(`当前适配器 ${caps.adapter} 不能读取${KIND_LABEL[kind]}（${SUPPORT_LABEL[caps[kind]]}）：${names.join("、")}。${ALTERNATIVES[kind]}。`);
  }
  return reasons.length === 0 ? null : reasons.join("\n");
}
