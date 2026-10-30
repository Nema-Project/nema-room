import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HubError,
  attachmentCapabilities,
  createThread,
  deleteAttachment,
  fetchAttachmentBlob,
  postMessage,
  postThreadMessage,
  uploadAttachment,
} from "@/lib/hub";
import { formatBytes, isDeliverable, newUploadKey, precheckFile } from "@/lib/attachments";

const view = {
  id: "att1", kind: "image", mime: "image/png", name: "shot.png", size: 10, sha256: "a".repeat(64),
  messageId: null, status: "staged", deletedAt: null,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stubFetch = (res: () => Response) => {
  const fetchMock = vi.fn<typeof fetch>(async () => res());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};
const png = () => new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])], "截图 1.png", { type: "image/png" });

afterEach(() => vi.unstubAllGlobals());

describe("attachment hub client", () => {
  it("uploads raw bytes with the filename and upload key headers", async () => {
    const fetchMock = stubFetch(() => json(view));
    const file = png();
    await expect(uploadAttachment("w/1", file, "0d6f7a7e-6c3a-4c1e-9f55-2a1b3c4d5e6f")).resolves.toEqual(view);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4400/api/workspaces/w%2F1/attachments");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(file);
    expect(new Headers(init?.headers).get("content-type")).toBe("application/octet-stream");
    expect(new Headers(init?.headers).get("x-nema-filename")).toBe(encodeURIComponent("截图 1.png"));
    expect(new Headers(init?.headers).get("x-nema-upload-key")).toBe("0d6f7a7e-6c3a-4c1e-9f55-2a1b3c4d5e6f");
  });

  it("turns an upload error body into a HubError", async () => {
    stubFetch(() => json({ error: "attachment storage is full" }, 507));
    await expect(uploadAttachment("w1", png(), "k")).rejects.toMatchObject({ status: 507, message: "attachment storage is full" });
  });

  it("returns null capabilities when the hub has no attachment route", async () => {
    stubFetch(() => json({ error: "not found" }, 404));
    await expect(attachmentCapabilities()).resolves.toBeNull();
  });

  it("returns null capabilities when the connected daemon predates attachments", async () => {
    stubFetch(() => json({ error: "the connected daemon does not support attachments" }, 501));
    await expect(attachmentCapabilities()).resolves.toBeNull();
  });

  it("returns the daemon's capabilities and fails when the daemon is offline", async () => {
    const caps = { adapter: "claude-code", image: "native", pdf: "unknown", text: "text" };
    const fetchMock = stubFetch(() => json(caps));
    await expect(attachmentCapabilities()).resolves.toEqual(caps);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:4400/api/daemon/attachment-capabilities");
    stubFetch(() => json({ error: "daemon offline" }, 503));
    await expect(attachmentCapabilities()).rejects.toBeInstanceOf(HubError);
  });

  it("rejects a capabilities answer of the wrong shape", async () => {
    stubFetch(() => json({ adapter: "claude-code", image: "yes" }));
    await expect(attachmentCapabilities()).rejects.toBeInstanceOf(HubError);
  });

  it("fetches attachment bytes as a blob and deletes an attachment", async () => {
    const fetchMock = stubFetch(() => new Response("hello", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }));
    const blob = await fetchAttachmentBlob("w1", "a/1");
    expect(await blob.text()).toBe("hello");
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:4400/api/workspaces/w1/attachments/a%2F1/content");
    const deleted = { ...view, messageId: "m1", status: "deleted", deletedAt: "2026-10-30T00:00:00.000Z" };
    const del = stubFetch(() => json(deleted));
    await expect(deleteAttachment("w1", "att1")).resolves.toEqual(deleted);
    expect(del.mock.calls[0]![0]).toBe("http://127.0.0.1:4400/api/workspaces/w1/attachments/att1");
    expect(del.mock.calls[0]![1]?.method).toBe("DELETE");
    stubFetch(() => json({ error: "attachment deleted" }, 410));
    await expect(fetchAttachmentBlob("w1", "att1")).rejects.toMatchObject({ status: 410 });
  });

  it("sends attachmentIds only when there are some", async () => {
    const ok = { message: {}, task: {} };
    const fetchMock = stubFetch(() => json(ok));
    await postMessage("w1", "", undefined, ["a1", "a2"]);
    await postMessage("w1", "text", "q1", []);
    await postThreadMessage("w1", "t1", "", undefined, ["a3"]);
    await createThread("w1", "topic", "q2", ["a4"]);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      { content: "", attachmentIds: ["a1", "a2"] },
      { content: "text", quoteMessageId: "q1" },
      { content: "", attachmentIds: ["a3"] },
      { content: "topic", quoteMessageId: "q2", attachmentIds: ["a4"] },
    ]);
  });
});

describe("attachment helpers", () => {
  it("checks a file's type and size before uploading", async () => {
    await expect(precheckFile(png())).resolves.toEqual({ ok: true, kind: "image", mime: "image/png" });
    await expect(precheckFile(new File(["%PDF-1.7"], "a.png"))).resolves.toEqual({ ok: false, reason: "extension_mismatch" });
    await expect(precheckFile(new File(["x"], "a.docx"))).resolves.toEqual({ ok: false, reason: "unsupported_type" });
    await expect(precheckFile(new File([], "a.txt"))).resolves.toEqual({ ok: false, reason: "empty" });
  });

  it("refuses an oversize file without reading it", async () => {
    const big = new File(["x"], "huge.pdf");
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    const read = vi.spyOn(big, "arrayBuffer");
    await expect(precheckFile(big)).resolves.toEqual({ ok: false, reason: "too_large" });
    expect(read).not.toHaveBeenCalled();
  });

  it("only native or text support is deliverable", () => {
    const caps = { adapter: "claude-code", image: "native", pdf: "unknown", text: "text" } as const;
    expect(isDeliverable(caps, "image")).toBe(true);
    expect(isDeliverable(caps, "text")).toBe(true);
    expect(isDeliverable(caps, "pdf")).toBe(false);
    expect(isDeliverable({ ...caps, image: "unsupported" }, "image")).toBe(false);
  });

  it("makes v4 upload keys without randomUUID", () => {
    const original = crypto.randomUUID;
    try {
      Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
      expect(newUploadKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(245 * 1024)).toBe("245 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});
