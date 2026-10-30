import { z } from "zod";

// Chat attachments contract (spec: docs/superpowers/specs/2026-10-30-chat-attachments-design.md).
// Shared by the hub (upload checks, task.assign), the daemon (delivery) and the web composer.

export type AttachmentKind = "image" | "pdf" | "text";
export type AttachmentStatus = "staged" | "attached" | "deleted" | "missing" | "expired";

export const ATTACHMENT_LIMITS = {
  imageBytes: 10 * 1024 * 1024,
  pdfBytes: 20 * 1024 * 1024,
  textBytes: 512 * 1024,
  perTaskCount: 8,
  perTaskBytes: 32 * 1024 * 1024,
  stagedTtlMs: 24 * 3600 * 1000,
  minFreeBytes: 1024 * 1024 * 1024,
  defaultGlobalBytes: 2 * 1024 * 1024 * 1024,
} as const;

export type SniffResult =
  | { ok: true; kind: AttachmentKind; mime: string }
  | { ok: false; reason: "unsupported_type" | "extension_mismatch" | "not_utf8" | "empty" | "too_large" };

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const PDF_EXTENSIONS = new Set(["pdf"]);
// "" is a name without an extension, such as Makefile.
const TEXT_EXTENSIONS = new Set([
  "", "txt", "md", "markdown", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml", "html", "css",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp",
  "cs", "php", "sh", "bash", "zsh", "sql", "diff", "patch",
]);
const SIZE_LIMIT: Record<AttachmentKind, number> = {
  image: ATTACHMENT_LIMITS.imageBytes,
  pdf: ATTACHMENT_LIMITS.pdfBytes,
  text: ATTACHMENT_LIMITS.textBytes,
};
const SVG_TAG = /<svg[\s>/]/i;

function startsWith(bytes: Uint8Array, prefix: readonly number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((b, i) => bytes[at + i] === b);
}
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function sniffBinary(bytes: Uint8Array): { kind: "image" | "pdf"; mime: string } | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return { kind: "image", mime: "image/gif" };
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return { kind: "image", mime: "image/webp" };
  if (startsWith(bytes, ascii("%PDF-"))) return { kind: "pdf", mime: "application/pdf" };
  return null;
}

function extensionOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * Decide an attachment's kind from its bytes, never from the name alone. The name's extension must
 * agree with the bytes; SVG is refused whatever it is called, because it is active content.
 */
export function sniffAttachment(bytes: Uint8Array, name: string): SniffResult {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  const ext = extensionOf(name);
  const binary = sniffBinary(bytes);
  if (binary) {
    const allowed = binary.kind === "image" ? IMAGE_EXTENSIONS : PDF_EXTENSIONS;
    if (!allowed.has(ext)) return { ok: false, reason: TEXT_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext) || PDF_EXTENSIONS.has(ext) ? "extension_mismatch" : "unsupported_type" };
    // A JPEG named .png is still a mismatch: the extension must name the sniffed format.
    if (binary.kind === "image" && !binary.mime.endsWith(ext === "jpg" ? "jpeg" : ext)) return { ok: false, reason: "extension_mismatch" };
    if (bytes.length > SIZE_LIMIT[binary.kind]) return { ok: false, reason: "too_large" };
    return { ok: true, ...binary };
  }
  if (IMAGE_EXTENSIONS.has(ext) || PDF_EXTENSIONS.has(ext)) return { ok: false, reason: "extension_mismatch" };
  if (!TEXT_EXTENSIONS.has(ext)) return { ok: false, reason: "unsupported_type" };
  if (bytes.length > ATTACHMENT_LIMITS.textBytes) return { ok: false, reason: "too_large" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not_utf8" };
  }
  if (text.includes("\u0000")) return { ok: false, reason: "not_utf8" };
  if (SVG_TAG.test(text)) return { ok: false, reason: "unsupported_type" };
  return { ok: true, kind: "text", mime: "text/plain" };
}

// C0/C1 controls, plus the bidi and zero-width marks that can make "x\u202Egnp.exe" read as "xexe.png".
const UNSAFE_NAME_CHARS = /[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
const MAX_NAME_CHARS = 200;

/**
 * The display name of an upload: the last path segment, without control or bidi characters,
 * trimmed and capped at 200 characters. Null when nothing usable is left. Never used as a path.
 */
export function sanitizeAttachmentName(raw: string): string | null {
  const segments = raw.split(/[/\\]/);
  const cleaned = (segments[segments.length - 1] ?? "").replace(UNSAFE_NAME_CHARS, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return null;
  return Array.from(cleaned).slice(0, MAX_NAME_CHARS).join("");
}

export const AttachmentKindSchema = z.enum(["image", "pdf", "text"]);
export const AttachmentStatusSchema = z.enum(["staged", "attached", "deleted", "missing", "expired"]);

/** An attachment bound to a message, as sent to the daemon in task.assign. */
export const AttachmentRefSchema = z.object({
  id: z.string().min(1),
  kind: AttachmentKindSchema,
  mime: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  messageId: z.string().min(1),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

/** What the UI sees. `messageId` is null while the upload is staged or after it expired. */
export type AttachmentView = Omit<AttachmentRef, "messageId"> & {
  messageId: string | null;
  status: AttachmentStatus;
  deletedAt: string | null;
};

export const AttachmentSupportSchema = z.enum(["native", "text", "unsupported", "unknown"]);
export type AttachmentSupport = z.infer<typeof AttachmentSupportSchema>;

export const AttachmentCapabilitiesSchema = z.object({
  adapter: z.string().min(1),
  image: AttachmentSupportSchema,
  pdf: AttachmentSupportSchema,
  text: AttachmentSupportSchema,
});
export type AttachmentCapabilities = z.infer<typeof AttachmentCapabilitiesSchema>;

/** A message may be attachment-only, but never fully empty. */
export function messageHasBody(content: string, attachmentIds: readonly string[]): boolean {
  return content.trim() !== "" || attachmentIds.length > 0;
}
