import { describe, expect, test } from "vitest";
import type { AttachmentRef } from "@nema/shared";
import { attachmentRejection } from "../../src/direct/attachmentErrors.js";
import { ModelApiError } from "../../src/direct/transport.js";

const ref = (over: Partial<AttachmentRef>): AttachmentRef => ({
  id: "a", kind: "pdf", mime: "application/pdf", name: "spec.pdf", size: 1, sha256: "a".repeat(64), messageId: "m1", ...over,
});
const err = (status: number | undefined, message: string, param?: string) =>
  Object.assign(new ModelApiError({ status, message: `HTTP ${status}：${message}${param ? `；param=${param}` : ""}` }), { param });

describe("attachmentRejection", () => {
  test.each([
    [400, "File input is not supported for this model."],
    [400, "Invalid content type: input_file"],
    [422, "PDF documents are not supported"],
    [400, "this model does not support image input"],
    [415, "unsupported media type application/pdf"],
    [400, "Model does not support the requested input modalities"],
    // OpenRouter's answer for an image sent to a text-only model (observed 2026-10-30).
    [404, "No endpoints found that support image input"],
  ])("%i %s is about the attachment", (status, message) => {
    expect(attachmentRejection(err(status, message), [ref({})])).toContain("你的提供商或模型拒绝了");
  });

  test.each([
    [400, "Unsupported parameter: reasoning.effort"],
    [404, "No such model"],
    [400, "max_output_tokens is too large"],
  ])("%i %s is not about the attachment", (status, message) => {
    expect(attachmentRejection(err(status, message), [ref({})])).toBeNull();
  });

  test("a param pointing into the message content counts", () => {
    expect(attachmentRejection(err(400, "Invalid value", "input[0].content[3]"), [ref({})])).toContain("拒绝了这份 PDF");
  });

  test("5xx, 401, 429 and errors without a status are left alone", () => {
    for (const status of [500, 401, 429, undefined]) expect(attachmentRejection(err(status, "file not supported"), [ref({})])).toBeNull();
  });

  test("only native kinds are named; text attachments are plain text and never the cause", () => {
    expect(attachmentRejection(err(400, "file not supported"), [ref({ kind: "text", name: "a.log", mime: "text/plain" })])).toBeNull();
    const both = attachmentRejection(err(400, "file not supported"), [ref({}), ref({ id: "i", kind: "image", mime: "image/png", name: "shot.png" })])!;
    expect(both).toContain("「spec.pdf」");
    expect(both).toContain("「shot.png」");
    expect(both).toContain("附件");
  });

  test("quotes the provider's text and says nothing was converted or retried", () => {
    const text = attachmentRejection(err(400, "File input is not supported for this model."), [ref({})])!;
    expect(text).toContain("HTTP 400：File input is not supported for this model.");
    expect(text).toContain("没有转换");
    expect(text).not.toContain("Nema 不支持");
  });
});
