import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { AttachmentCapabilitiesSchema, type AttachmentRef } from "@nema/shared";
import { attachmentCapabilities, DAEMON_FEATURES, refusal } from "../../src/attachments/capabilities.js";
import { registerAttachmentHandlers } from "../../src/attachments/handlers.js";
import { DEFAULT_BYOK_BASE_URL, type NemaConfig } from "../../src/config.js";
import { RpcRouter } from "../../src/daemon/rpc.js";

const base = { reasoningEffort: "medium" } as const;
const cfg = (c: Partial<NemaConfig>): NemaConfig => ({ ...base, adapter: "codex-direct", authMode: "siwc", ...c }) as NemaConfig;

const ref = (over: Partial<AttachmentRef>): AttachmentRef => ({
  id: "att_1", kind: "image", mime: "image/png", name: "shot.png", size: 10, sha256: "a".repeat(64), messageId: "m1", ...over,
});

describe("attachmentCapabilities", () => {
  test.each([
    ["claude-code", cfg({ adapter: "claude-code" }), { image: "native", pdf: "unknown", text: "text" }],
    ["claude-code ignores the codex auth mode", cfg({ adapter: "claude-code", authMode: "compat" }), { image: "native", pdf: "unknown", text: "text" }],
    ["codex-direct + siwc", cfg({ authMode: "siwc" }), { image: "native", pdf: "native", text: "text" }],
    ["codex-direct + byok without a base URL", cfg({ authMode: "byok" }), { image: "native", pdf: "native", text: "text" }],
    ["codex-direct + byok on the default base URL", cfg({ authMode: "byok", byokBaseUrl: DEFAULT_BYOK_BASE_URL }), { image: "native", pdf: "native", text: "text" }],
    // Every codex-direct login sends images and PDFs in the provider's native form; a provider that cannot read
    // them says so, and the run reports that (direct/attachmentErrors.ts). No endpoint is singled out.
    ["codex-direct + byok elsewhere", cfg({ authMode: "byok", byokBaseUrl: "https://llm.example.com/v1" }), { image: "native", pdf: "native", text: "text" }],
    ["codex-direct + byok on OpenRouter", cfg({ authMode: "byok", byokBaseUrl: "https://openrouter.ai/api/v1" }), { image: "native", pdf: "native", text: "text" }],
    ["codex-direct + byok on localhost", cfg({ authMode: "byok", byokBaseUrl: "http://127.0.0.1:8080/v1" }), { image: "native", pdf: "native", text: "text" }],
    ["codex-direct + compat", cfg({ authMode: "compat" }), { image: "native", pdf: "native", text: "text" }],
  ])("%s", (_name, config, expected) => {
    const caps = attachmentCapabilities(config);
    expect(caps).toMatchObject(expected);
    expect(AttachmentCapabilitiesSchema.parse(caps)).toEqual(caps);
  });

  test("names the adapter, with the auth mode for codex-direct", () => {
    expect(attachmentCapabilities(cfg({ adapter: "claude-code" })).adapter).toBe("claude-code");
    expect(attachmentCapabilities(cfg({ authMode: "compat" })).adapter).toBe("codex-direct (compat)");
  });

  test("the daemon advertises attachments now that both adapters deliver them", () => {
    expect(DAEMON_FEATURES).toEqual(["attachments"]);
  });
});

describe("refusal", () => {
  test("null when every attachment can be delivered", () => {
    const caps = attachmentCapabilities(cfg({ authMode: "siwc" }));
    expect(refusal(caps, [ref({}), ref({ id: "p", kind: "pdf", mime: "application/pdf", name: "spec.pdf" }), ref({ id: "t", kind: "text", mime: "text/plain", name: "a.log" })])).toBeNull();
    expect(refusal(caps, [])).toBeNull();
  });

  test("an unknown PDF on claude-code names the adapter, the file and a way out, without claiming it cannot be read", () => {
    const caps = attachmentCapabilities(cfg({ adapter: "claude-code" }));
    const text = refusal(caps, [ref({}), ref({ id: "p", kind: "pdf", mime: "application/pdf", name: "spec.pdf" })])!;
    expect(text).toContain("claude-code");
    expect(text).toContain("spec.pdf");
    expect(text).toContain("PDF");
    expect(text).toContain("尚未确认");
    expect(text).not.toContain("不能读取");
    expect(text).not.toContain("shot.png");
    expect(text).toContain("codex-direct");
  });

  test("compat and any BYOK endpoint refuse nothing before the run", () => {
    const refs = [ref({ name: "a.png" }), ref({ id: "p", kind: "pdf", mime: "application/pdf", name: "spec.pdf" })];
    expect(refusal(attachmentCapabilities(cfg({ authMode: "compat" })), refs)).toBeNull();
    expect(refusal(attachmentCapabilities(cfg({ authMode: "byok", byokBaseUrl: "https://llm.example.com/v1" })), refs)).toBeNull();
  });

  test("unsupported is refused too, not only unknown", () => {
    const text = refusal({ adapter: "x", image: "unsupported", pdf: "native", text: "text" }, [ref({})]);
    expect(text).toContain("x");
    expect(text).toContain("shot.png");
  });
});

describe("attachments.capabilities RPC", () => {
  test("answers from the current config on every call", async () => {
    const rpc = new RpcRouter();
    let config = cfg({ adapter: "claude-code" });
    registerAttachmentHandlers(rpc, "/nonexistent", () => config);
    const first = await rpc.handle({ type: "rpc.request", id: "1", method: "attachments.capabilities", params: {} });
    expect(first).toEqual({ type: "rpc.response", id: "1", ok: true, result: { adapter: "claude-code", image: "native", pdf: "unknown", text: "text" } });
    config = cfg({ authMode: "siwc" });
    const second = await rpc.handle({ type: "rpc.request", id: "2", method: "attachments.capabilities", params: {} });
    expect(second).toMatchObject({ ok: true, result: { image: "native", pdf: "native" } });
  });

  test("reads <nemaHome>/config.json when no getter is given", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "nema-att-caps-"));
    writeFileSync(path.join(home, "config.json"), JSON.stringify({ adapter: "codex-direct", authMode: "compat" }));
    const rpc = new RpcRouter();
    registerAttachmentHandlers(rpc, home);
    const res = await rpc.handle({ type: "rpc.request", id: "1", method: "attachments.capabilities", params: {} });
    expect(res).toMatchObject({ ok: true, result: { adapter: "codex-direct (compat)", image: "native", pdf: "native", text: "text" } });
  });

  test("an unreadable config is an RPC error, not a guess", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "nema-att-caps-"));
    writeFileSync(path.join(home, "config.json"), "{not json");
    const rpc = new RpcRouter();
    registerAttachmentHandlers(rpc, home);
    expect(await rpc.handle({ type: "rpc.request", id: "1", method: "attachments.capabilities", params: {} })).toMatchObject({ ok: false });
  });
});
