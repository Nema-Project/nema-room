import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, AttachmentCapabilitiesSchema, AttachmentRefSchema, messageHasBody, sanitizeAttachmentName, sniffAttachment } from "../src/attachments.js";
import * as shared from "../src/index.js";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const gif = new TextEncoder().encode("GIF89a....");
const webp = Uint8Array.from([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP")]);
const pdf = new TextEncoder().encode("%PDF-1.7\n...");

describe("sniffAttachment", () => {
  it.each([
    [png, "a.png", "image", "image/png"],
    [jpeg, "a.jpg", "image", "image/jpeg"],
    [gif, "a.gif", "image", "image/gif"],
    [webp, "a.webp", "image", "image/webp"],
    [pdf, "a.pdf", "pdf", "application/pdf"],
    [new TextEncoder().encode("hello\n"), "a.log", "text", "text/plain"],
    [new TextEncoder().encode("{\"a\":1}"), "a.json", "text", "text/plain"],
  ])("accepts %#", (bytes, name, kind, mime) => {
    expect(sniffAttachment(bytes, name)).toEqual({ ok: true, kind, mime });
  });
  it("rejects a PDF named .png", () => expect(sniffAttachment(pdf, "a.png")).toEqual({ ok: false, reason: "extension_mismatch" }));
  it("rejects SVG even though it is text", () => expect(sniffAttachment(new TextEncoder().encode("<svg/>"), "a.svg")).toEqual({ ok: false, reason: "unsupported_type" }));
  it.each(["a.xml", "a.html", "a.txt", "noext"])("rejects SVG content named %s", (name) =>
    expect(sniffAttachment(new TextEncoder().encode('<?xml version="1.0"?>\n<!-- c -->\n<SVG xmlns="http://www.w3.org/2000/svg"/>'), name)).toEqual({ ok: false, reason: "unsupported_type" }));
  it("rejects invalid UTF-8", () => expect(sniffAttachment(Uint8Array.from([0xc3, 0x28]), "a.txt")).toEqual({ ok: false, reason: "not_utf8" }));
  it("rejects NUL bytes", () => expect(sniffAttachment(Uint8Array.from([0x61, 0x00]), "a.txt")).toEqual({ ok: false, reason: "not_utf8" }));
  it("rejects empty", () => expect(sniffAttachment(new Uint8Array(), "a.txt")).toEqual({ ok: false, reason: "empty" }));
  it("rejects oversize text", () => expect(sniffAttachment(new Uint8Array(ATTACHMENT_LIMITS.textBytes + 1).fill(0x61), "a.txt")).toEqual({ ok: false, reason: "too_large" }));
});

describe("sanitizeAttachmentName", () => {
  it("drops directories and controls", () => expect(sanitizeAttachmentName("../../etc/pa\u0000ss\nwd.txt")).toBe("passwd.txt"));
  it("handles backslashes", () => expect(sanitizeAttachmentName("C:\\x\\y.png")).toBe("y.png"));
  it("caps length", () => expect(sanitizeAttachmentName("a".repeat(300) + ".txt")!.length).toBe(200));
  it("rejects blank", () => expect(sanitizeAttachmentName(" / ")).toBeNull());
});

describe("messageHasBody", () => {
  it("allows attachment-only", () => expect(messageHasBody("  ", ["a"])).toBe(true));
  it("rejects fully empty", () => expect(messageHasBody(" ", [])).toBe(false));
});

describe("sniffAttachment, beyond the plan's table", () => {
  const text = (s: string) => new TextEncoder().encode(s);
  it("accepts a text file without an extension", () => expect(sniffAttachment(text("x"), "Makefile")).toEqual({ ok: true, kind: "text", mime: "text/plain" }));
  it("matches extensions case-insensitively", () => expect(sniffAttachment(png, "A.PNG")).toEqual({ ok: true, kind: "image", mime: "image/png" }));
  it("accepts .jpeg and GIF87a", () => {
    expect(sniffAttachment(jpeg, "a.jpeg")).toEqual({ ok: true, kind: "image", mime: "image/jpeg" });
    expect(sniffAttachment(text("GIF87a...."), "a.gif")).toEqual({ ok: true, kind: "image", mime: "image/gif" });
  });
  it("rejects text under a non-text extension", () => expect(sniffAttachment(text("hello"), "a.exe")).toEqual({ ok: false, reason: "unsupported_type" }));
  it("rejects text named as an image or PDF", () => {
    expect(sniffAttachment(text("hello"), "a.png")).toEqual({ ok: false, reason: "extension_mismatch" });
    expect(sniffAttachment(text("hello"), "a.pdf")).toEqual({ ok: false, reason: "extension_mismatch" });
  });
  it("rejects an image named as text", () => expect(sniffAttachment(png, "a.txt")).toEqual({ ok: false, reason: "extension_mismatch" }));
  it("rejects a JPEG named .png", () => expect(sniffAttachment(jpeg, "a.png")).toEqual({ ok: false, reason: "extension_mismatch" }));
  it("rejects unknown binary under an unknown extension", () => expect(sniffAttachment(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00]), "a.zip")).toEqual({ ok: false, reason: "unsupported_type" }));
  it("rejects HEIC", () => expect(sniffAttachment(Uint8Array.from([0, 0, 0, 0x18, ...text("ftypheic")]), "a.heic")).toEqual({ ok: false, reason: "unsupported_type" }));
  it("applies the per-kind size limits", () => {
    const bigPng = new Uint8Array(ATTACHMENT_LIMITS.imageBytes + 1);
    bigPng.set(png);
    expect(sniffAttachment(bigPng, "a.png")).toEqual({ ok: false, reason: "too_large" });
    const okPng = new Uint8Array(ATTACHMENT_LIMITS.imageBytes);
    okPng.set(png);
    expect(sniffAttachment(okPng, "a.png")).toMatchObject({ ok: true });
    const bigPdf = new Uint8Array(ATTACHMENT_LIMITS.pdfBytes + 1);
    bigPdf.set(pdf);
    expect(sniffAttachment(bigPdf, "a.pdf")).toEqual({ ok: false, reason: "too_large" });
    expect(sniffAttachment(new Uint8Array(ATTACHMENT_LIMITS.textBytes).fill(0x61), "a.txt")).toMatchObject({ ok: true });
  });
  it("does not treat a tag that merely starts with svg as SVG", () => expect(sniffAttachment(text("<svgfoo/> and svg in prose"), "a.xml")).toMatchObject({ ok: true }));
});

describe("sanitizeAttachmentName, beyond the plan's table", () => {
  it("strips bidi controls that could disguise the extension", () => expect(sanitizeAttachmentName("evil\u202Egnp.exe")).toBe("evilgnp.exe"));
  it("rejects dot names", () => {
    expect(sanitizeAttachmentName(".")).toBeNull();
    expect(sanitizeAttachmentName("a/..")).toBeNull();
  });
  it("trims surrounding whitespace", () => expect(sanitizeAttachmentName("  a.txt  ")).toBe("a.txt"));
  it("does not split a surrogate pair when capping", () => {
    const name = sanitizeAttachmentName("\u{1F600}".repeat(250))!;
    expect(Array.from(name)).toHaveLength(200);
    expect(name.isWellFormed()).toBe(true);
  });
});

describe("limits and schemas", () => {
  it("has the spec's limits", () => {
    expect(ATTACHMENT_LIMITS).toEqual({
      imageBytes: 10 * 1024 * 1024, pdfBytes: 20 * 1024 * 1024, textBytes: 512 * 1024, perTaskCount: 8, perTaskBytes: 32 * 1024 * 1024,
      stagedTtlMs: 24 * 3600 * 1000, minFreeBytes: 1024 * 1024 * 1024, defaultGlobalBytes: 2 * 1024 * 1024 * 1024,
    });
  });
  const ref = { id: "att_1", kind: "image", mime: "image/png", name: "a.png", size: 10, sha256: "a".repeat(64), messageId: "m1" };
  it("AttachmentRefSchema requires a message id and a hex sha256", () => {
    expect(AttachmentRefSchema.parse(ref)).toEqual(ref);
    expect(() => AttachmentRefSchema.parse({ ...ref, messageId: undefined })).toThrow();
    expect(() => AttachmentRefSchema.parse({ ...ref, sha256: "A".repeat(64) })).toThrow();
    expect(() => AttachmentRefSchema.parse({ ...ref, kind: "video" })).toThrow();
    expect(() => AttachmentRefSchema.parse({ ...ref, size: 0 })).toThrow();
  });
  it("AttachmentCapabilitiesSchema checks every field", () => {
    const caps = { adapter: "codex-direct", image: "native", pdf: "native", text: "text" };
    expect(AttachmentCapabilitiesSchema.parse(caps)).toEqual(caps);
    expect(() => AttachmentCapabilitiesSchema.parse({ ...caps, pdf: "maybe" })).toThrow();
    expect(() => AttachmentCapabilitiesSchema.parse({ image: "native", pdf: "native", text: "text" })).toThrow();
  });
  it("is exported from the package index", () => {
    for (const name of ["ATTACHMENT_LIMITS", "AttachmentCapabilitiesSchema", "AttachmentRefSchema", "messageHasBody", "sanitizeAttachmentName", "sniffAttachment"]) {
      expect(shared).toHaveProperty(name);
    }
  });
});
