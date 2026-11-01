import { describe, expect, test } from "vitest";
import type { TaskAssign } from "@nema/shared";
import {
  accountCapability,
  accountForNeed,
  adapterCapability,
  resolveCapability,
  taskNeeds,
} from "../../src/routing/capabilities.js";
import type { Account } from "../../src/accounts/schema.js";

const account = (p: Partial<Account> = {}): Account => ({
  id: "acct_aaaaaaaaaa",
  name: "A",
  enabled: true,
  adapter: "codex-direct",
  authMode: "byok",
  baseUrl: "https://api.example.test/v1",
  costTier: "standard",
  order: 0,
  createdAt: "2026-10-31T00:00:00.000Z",
  ...p,
});

const task = (p: Partial<TaskAssign> = {}): TaskAssign => ({
  type: "task.assign",
  taskId: "t1",
  workspaceId: "w1",
  adapter: "auto",
  confidential: false,
  prompt: "p",
  runToken: "rt",
  hubUrl: "http://hub.test",
  pluginTools: [],
  ...p,
});

const attachment = (kind: "image" | "pdf" | "text") => ({
  id: `a_${kind}`,
  kind,
  mime: kind === "image" ? "image/png" : kind === "pdf" ? "application/pdf" : "text/plain",
  name: `f.${kind}`,
  size: 3,
  sha256: "a".repeat(64),
  messageId: "m1",
});

describe("capability layers", () => {
  test("a model-level declaration wins over the account-level one", () => {
    const a = account({ capabilities: { image: true }, modelCapabilities: { "text-only": { image: false } } });
    expect(accountCapability(a, "text-only", "image")).toBe("no");
    expect(accountCapability(a, "other", "image")).toBe("yes");
  });

  test("the account-level declaration wins over the adapter fallback", () => {
    const a = account({ capabilities: { pdf: false } });
    expect(accountCapability(a, "m", "pdf")).toBe("no");
    // The adapter would say yes for a PDF on codex-direct; the account says no, and the account is closer to
    // the truth: it is the endpoint the request goes to.
    expect(resolveCapability(a, "m", "pdf")).toBe("no");
  });

  test("an undeclared need falls back to the adapter", () => {
    expect(resolveCapability(account(), "m", "image")).toBe("yes");
    expect(resolveCapability(account({ adapter: "claude-code", authMode: undefined, baseUrl: undefined }), "m", "image")).toBe("yes");
  });

  test("claude-code leaves PDFs undeclared rather than guessing", () => {
    // The adapter's own table says "unknown" for a Claude PDF: Nema cannot tell whether a native document
    // block reaches the model, so it does not claim it can (attachments/capabilities.ts).
    const claude = account({ adapter: "claude-code", authMode: undefined, baseUrl: undefined });
    expect(adapterCapability("claude-code", "image")).toBe("yes");
    expect(adapterCapability("claude-code", "pdf")).toBe("undeclared");
    expect(resolveCapability(claude, "m", "pdf")).toBe("undeclared");
  });

  test("codex-direct declares both kinds", () => {
    expect(adapterCapability("codex-direct", "image")).toBe("yes");
    expect(adapterCapability("codex-direct", "pdf")).toBe("yes");
  });

  test("a declared false never becomes undeclared, and vice versa", () => {
    const no = account({ capabilities: { image: false } });
    expect(resolveCapability(no, "m", "image")).toBe("no");
    const none = account({ adapter: "claude-code", authMode: undefined, baseUrl: undefined, capabilities: {} });
    expect(resolveCapability(none, "m", "pdf")).toBe("undeclared");
  });
});

describe("taskNeeds", () => {
  test("an image attachment needs image support", () => {
    expect(taskNeeds(task({ attachments: [attachment("image")] }))).toEqual({ image: true });
  });
  test("a PDF attachment needs pdf support", () => {
    expect(taskNeeds(task({ attachments: [attachment("pdf")] }))).toEqual({ pdf: true });
  });
  test("text attachments need nothing declared", () => {
    expect(taskNeeds(task({ attachments: [attachment("text")] }))).toEqual({});
  });
  test("no attachments need nothing", () => {
    expect(taskNeeds(task())).toEqual({});
  });
});

describe("accountForNeed", () => {
  test("reports every missing capability, not just the first", () => {
    const claude = account({ adapter: "claude-code", authMode: undefined, baseUrl: undefined });
    expect(accountForNeed(claude, "m", { image: true, pdf: true })).toEqual({ ok: false, missing: ["pdf"] });
  });
  test("treats undeclared as not satisfied", () => {
    const claude = account({ adapter: "claude-code", authMode: undefined, baseUrl: undefined });
    expect(accountForNeed(claude, "m", { pdf: true })).toEqual({ ok: false, missing: ["pdf"] });
  });
  test("passes when everything needed is declared", () => {
    expect(accountForNeed(account(), "m", { image: true, pdf: true })).toEqual({ ok: true });
    expect(accountForNeed(account(), "m", {})).toEqual({ ok: true });
  });
});
