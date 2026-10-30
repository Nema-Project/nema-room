import type { AttachmentRef } from "@nema/shared";
import { ModelApiError } from "./transport.js";

// 4xx a provider sends when it will not read a content block. 401 (key), 408 and 429 (limits) are never about it.
const IGNORED_STATUS = new Set([401, 408, 429]);
// Wording about files, documents, images or input modalities. A bare "vision" is left out: it is mostly a model name.
const ABOUT_CONTENT = /\bfiles?\b|\bpdfs?\b|\bdocuments?\b|input_file|input_image|\bimages?\b|attachments?|modalit|multimodal|media.?type|mime/i;
// The param of a block in the first user message, e.g. `param=input[0].content[3]`.
const CONTENT_PARAM = /param=input\[0\]\.content\[(\d+)\]/;
// Quoted or backticked spans usually name a model (`llama-3.2-vision`, 'gpt-image-1'); they say nothing about the file.
const QUOTED = /`[^`]*`|'[^']*'|"[^"]*"/g;

const KIND_PHRASE = { pdf: "这份 PDF", image: "这张图片" } as const;

/** What each block of the first user message's content carries: an attachment, or null for Nema's own text. */
export type ContentBlockOwner = { kind: AttachmentRef["kind"]; name: string } | null;

/**
 * When a run that carried images or PDFs fails with a provider 4xx about them, the provider or model rejected
 * them: say so, name the files, and quote the provider. Null for anything else, which is shown as it came.
 * `blocks` maps the first user message's content index to its attachment, so a provider that points at one
 * block names only that file. Nema sent the provider's own native form and does not convert, fall back or retry.
 */
export function attachmentRejection(e: unknown, refs: readonly AttachmentRef[], blocks?: readonly ContentBlockOwner[]): string | null {
  if (!(e instanceof ModelApiError)) return null;
  if (e.status === undefined) {
    // A response.failed / error event always carries a code; a connection error carries neither.
    if (e.code === undefined) return null;
  } else if (e.status < 400 || e.status >= 500 || IGNORED_STATUS.has(e.status)) return null;
  const native = refs.filter((r) => r.kind === "image" || r.kind === "pdf");
  if (native.length === 0) return null;
  const index = CONTENT_PARAM.exec(e.message)?.[1];
  if (index !== undefined && blocks) {
    const owner = blocks[Number(index)];
    if (owner === null) return null;
    if (owner && (owner.kind === "image" || owner.kind === "pdf")) return sentence(KIND_PHRASE[owner.kind], `「${owner.name}」`, e.message);
  }
  if (index === undefined && !ABOUT_CONTENT.test(e.message.replace(QUOTED, " "))) return null;
  const names = native.map((r) => `「${r.name}」`).join("、");
  if (native.length === 1) return sentence(KIND_PHRASE[native[0]!.kind as "pdf" | "image"], names, e.message);
  return sentence("这次附带的附件", `${names}；提供商没有指出是哪一个`, e.message);
}

const sentence = (what: string, names: string, original: string) =>
  `你的提供商或模型拒绝了${what}（${names}）。提供商原文：${original}。Nema 按提供商的原生格式发送，没有转换，也没有重试。`;
