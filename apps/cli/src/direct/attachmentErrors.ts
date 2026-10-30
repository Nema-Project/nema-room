import type { AttachmentRef } from "@nema/shared";
import { ModelApiError } from "./transport.js";

// 4xx a provider sends when it will not read a content block. 401 (key), 408 and 429 (limits) are never about it.
const IGNORED_STATUS = new Set([401, 408, 429]);
// A param pointing into the message content, or wording about files, documents, images or input modalities.
const ABOUT_CONTENT = /param=input\[\d+\]\.content|\bfiles?\b|\bpdfs?\b|\bdocuments?\b|input_file|input_image|\bimages?\b|attachments?|modalit|multimodal|vision|media.?type|mime/i;

const KIND_PHRASE = { pdf: "这份 PDF", image: "这张图片" } as const;

/**
 * When a run that carried images or PDFs fails with a provider 4xx about them, the provider or model rejected
 * them: say so, name the files, and quote the provider. Null for anything else, which is shown as it came.
 * Nema sent the provider's own native form and does not convert, fall back or retry.
 */
export function attachmentRejection(e: unknown, refs: readonly AttachmentRef[]): string | null {
  if (!(e instanceof ModelApiError) || e.status === undefined || e.status < 400 || e.status >= 500 || IGNORED_STATUS.has(e.status)) return null;
  const native = refs.filter((r) => r.kind === "image" || r.kind === "pdf");
  if (native.length === 0 || !ABOUT_CONTENT.test(e.message)) return null;
  const kinds = new Set(native.map((r) => r.kind));
  const what = kinds.size === 1 ? KIND_PHRASE[native[0]!.kind as "pdf" | "image"] : "附件";
  const names = native.map((r) => `「${r.name}」`).join("、");
  return `你的提供商或模型拒绝了${what}（${names}）。提供商原文：${e.message}。Nema 按提供商的原生格式发送，没有转换，也没有重试。`;
}
