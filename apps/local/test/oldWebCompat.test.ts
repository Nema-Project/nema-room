import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createSettingsService } from "../src/settings.js";
import { saveConfig } from "@nema/cli/config";

/**
 * A 0.2.0 web against this daemon (spec 2026-10-31 §5.1). The old page reads `ModelSettingsDto`, paints four
 * dropdowns from `config`, and switches them with `PATCH /_nema/settings`. It never calls
 * `/_nema/accounts`; this test sends exactly that sequence, with the request bodies the old bundle sends,
 * and asserts every answer still has the shape it had.
 */

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function service() {
  const home = mkdtempSync(path.join(tmpdir(), "nema-oldweb-"));
  homes.push(home);
  saveConfig(home, { adapter: "codex-direct", authMode: "siwc", reasoningEffort: "medium" });
  return { home, svc: createSettingsService({ home, codexHome: path.join(home, "no-codex") }) };
}

/** The fields a 0.2.0 bundle destructures. Anything missing is a page that renders blanks. */
function expectOldShape(body: Record<string, unknown>) {
  expect(body.config).toBeTruthy();
  const config = body.config as Record<string, unknown>;
  expect(["codex-direct", "claude-code"]).toContain(config.adapter);
  expect(["siwc", "compat", "byok"]).toContain(config.authMode);
  expect(["low", "medium", "high"]).toContain(config.reasoningEffort);
  const auth = body.auth as Record<string, unknown>;
  for (const key of ["mode", "credential", "state", "adapter"]) expect(key in auth).toBe(true);
  const tools = body.tools as Record<string, Record<string, unknown>>;
  for (const tool of ["claude", "github"]) expect(tool in tools).toBe(true);
  for (const state of Object.values(body.credentials as Record<string, string>)) {
    expect(["connected", "missing", "unusable"]).toContain(state);
  }
}

describe("a 0.2.0 web against this daemon", () => {
  test("reads settings and switches all four provider combinations", async () => {
    const { svc, home } = service();
    const first = await svc.dispatch("GET", "/_nema/settings", undefined);
    expect(first.status).toBe(200);
    expectOldShape(first.body);

    // The four combinations, in the bodies the old page sends (`byokBaseUrl` only with byok).
    const patches = [
      { adapter: "codex-direct", authMode: "siwc", reasoningEffort: "medium", byokBaseUrl: null },
      { adapter: "codex-direct", authMode: "compat", reasoningEffort: "medium", byokBaseUrl: null },
      { adapter: "codex-direct", authMode: "byok", reasoningEffort: "medium", byokBaseUrl: "https://a.example.com/v1" },
      { adapter: "claude-code", authMode: "byok", reasoningEffort: "medium", byokBaseUrl: "https://a.example.com/v1" },
    ] as const;
    for (const patch of patches) {
      const reply = await svc.dispatch("PATCH", "/_nema/settings", { ...patch });
      expect(reply.status).toBe(200);
      expect(reply.body.config).toMatchObject({ adapter: patch.adapter, authMode: patch.authMode });
      const after = await svc.dispatch("GET", "/_nema/settings", undefined);
      expect(after.status).toBe(200);
      expectOldShape(after.body);
      expect((after.body.config as Record<string, unknown>).adapter).toBe(patch.adapter);
    }

  });

  test("an unknown field in a PATCH is still refused, and the account keys are not a back door", async () => {
    const { svc } = service();
    // The old page never sends these; a caller that does must not be able to change accounts through the
    // settings whitelist, which is why §5.1 says the whitelist does not grow.
    expect((await svc.dispatch("PATCH", "/_nema/settings", { accounts: [] })).status).toBe(400);
    expect((await svc.dispatch("PATCH", "/_nema/settings", { defaultAccountId: "acct_abc1234567" })).status).toBe(400);
  });

  test("a daemon with accounts configured still answers the old shape", async () => {
    const { svc, home } = service();
    const created = await svc.dispatch("POST", "/_nema/accounts", { name: "Second", adapter: "claude-code" });
    expect(created.status).toBe(201);
    expect(existsSync(path.join(home, "accounts.json"))).toBe(true);
    const reply = await svc.dispatch("GET", "/_nema/settings", undefined);
    expect(reply.status).toBe(200);
    expectOldShape(reply.body);
  });
});
