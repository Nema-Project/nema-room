import type { AttachmentCapabilities, AttachmentKind, AttachmentRef, AttachmentSupport } from "@nema/shared";
import type { NemaConfig } from "../config.js";

/**
 * Abilities this daemon advertises in `hello.features`: both adapters deliver attachments (plan B4), and
 * both route a task to a named account (spec 2026-10-31 §5.4).
 *
 * `accounts` exists so a hub can refuse to send an account-bound task to a daemon that would drop the field
 * and run it on its default credentials instead — the same silent substitution `attachments` guards against.
 * An older daemon simply does not list it.
 */
export const DAEMON_FEATURES: readonly string[] = ["attachments", "accounts"];

type Table = Pick<AttachmentCapabilities, "image" | "pdf" | "text">;

// D-2 (revised 2026-10-30 22:59 JST): images and PDFs go to the provider in its own native form. Whether the
// provider or model reads them is its call; when it rejects one, the run says so with the provider's own text
// (direct/attachmentErrors.ts). Nothing is converted or retried. "unknown" is left only where Nema cannot tell
// that a native block reaches the model at all: Claude Code's stream-json has no documented `document` block.
const CLAUDE: Table = { image: "native", pdf: "unknown", text: "text" };
const CODEX_DIRECT: Table = { image: "native", pdf: "native", text: "text" };

/** What the configured adapter can take, per attachment kind. Read fresh from config for every call. */
export function attachmentCapabilities(config: NemaConfig): AttachmentCapabilities {
  if (config.adapter === "claude-code") return { adapter: "claude-code", ...CLAUDE };
  return { adapter: `codex-direct (${config.authMode})`, ...CODEX_DIRECT };
}

const KIND_LABEL: Record<AttachmentKind, string> = { image: "图片", pdf: "PDF", text: "文本文件" };
// Ways out that exist today. Converting a file is the user's own step; Nema does not convert.
const ALTERNATIVES: Record<AttachmentKind, string> = {
  image: "请切换到 claude-code 或 codex-direct，或把内容转成文本后再发",
  pdf: "请切换到 codex-direct，或把内容转成图片或文本后再发",
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
    const what = caps[kind] === "unknown"
      ? `尚未确认当前适配器 ${caps.adapter} 会把${KIND_LABEL[kind]}交给模型`
      : `当前适配器 ${caps.adapter} 不支持${KIND_LABEL[kind]}`;
    reasons.push(`${what}：${names.join("、")}。${ALTERNATIVES[kind]}。`);
  }
  return reasons.length === 0 ? null : reasons.join("\n");
}
