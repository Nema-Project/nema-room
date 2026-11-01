import { mkdtempSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createSettingsService } from "../src/settings.js";
import { saveConfig } from "@nema/cli/config";

/**
 * The two S2 acceptance points that can be measured on this service — the third (a 0.2.0 web against this
 * daemon) is covered where the web reads the response, and the pickers are covered by their own tests.
 *
 * These run the whole settings service, not `handleAccounts` alone: what they assert is what a user's
 * request actually does to the disk.
 */

test("a single-account user opening settings and saving normally creates no accounts.json", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "acc-"));
  try {
    saveConfig(home, { adapter: "codex-direct", authMode: "byok", byokBaseUrl: "https://a.example.com/v1" });
    const before = readdirSync(home).sort();
    const service = createSettingsService({ home, codexHome: path.join(home, "no-codex") });
    // What a single-account user actually does: open the page (GET settings, GET accounts), then switch a
    // provider with the four dropdowns.
    await service.dispatch("GET", "/_nema/settings", undefined);
    await service.dispatch("GET", "/_nema/accounts", undefined);
    await service.dispatch("PATCH", "/_nema/settings", { authMode: "siwc" });
    await service.dispatch("GET", "/_nema/settings", undefined);
    const after = readdirSync(home).sort();
    expect(after).toEqual(before);
    expect(existsSync(path.join(home, "accounts.json"))).toBe(false);
    expect(existsSync(path.join(home, "secrets"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("deleting an account leaves no credential directory behind", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "acc-"));
  try {
    const service = createSettingsService({ home, codexHome: path.join(home, "no-codex") });
    saveConfig(home, { adapter: "codex-direct", authMode: "byok", byokBaseUrl: "https://a.example.com/v1" });
    const created = await service.dispatch("POST", "/_nema/accounts", { name: "B", adapter: "codex-direct", authMode: "byok", baseUrl: "https://b.example.com/v1" });
    const id = (created.body as { account: { id: string } }).account.id;
    await service.dispatch("POST", "/_nema/accounts/secret", { id, kind: "byok", value: "sk-x-0123456789abcdef" });
    const dir = path.join(home, "secrets", "accounts", id);
    expect(statSync(dir).isDirectory()).toBe(true);
    const deleted = await service.dispatch("DELETE", "/_nema/accounts", { id });
    expect(deleted.status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    // The materialized default account is still there, so nothing else was removed with it.
    const list = await service.dispatch("GET", "/_nema/accounts", undefined);
    expect((list.body as { accounts: unknown[] }).accounts).toHaveLength(1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
