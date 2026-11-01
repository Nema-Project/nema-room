import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Which flow a login for one account runs, and where it writes.
 *
 * `authLogin` reads `config.json` first and switches to the Codex-login confirmation when the *default*
 * account is `compat`. That is the default account's mode deciding what a login for a *different* account
 * does, so the accounts route calls `siwcLogin` directly. This test pins that down by watching the two.
 */

const calls: Array<{ fn: string; opts: Record<string, unknown> }> = [];
/** When set, `siwcLogin` behaves like a browser login waiting for a person: it settles only on abort. */
let waitForAbort: { signal?: AbortSignal } | null = null;

vi.mock("@nema/cli/localSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@nema/cli/localSettings")>();
  return {
    ...actual,
    siwcLogin: async (opts: Record<string, unknown>) => {
      calls.push({ fn: "siwcLogin", opts });
      if (waitForAbort !== null) {
        waitForAbort.signal = opts.signal as AbortSignal | undefined;
        await new Promise<void>((done) => {
          const signal = opts.signal as AbortSignal | undefined;
          if (!signal) throw new Error("login must receive a signal");
          signal.addEventListener("abort", () => done(), { once: true });
        });
        throw new Error("aborted");
      }
      return { version: 1, mode: "siwc", clientId: "c", tokens: { access_token: "", refresh_token: "" }, lastRefresh: "" };
    },
    authLogin: async (opts: Record<string, unknown>) => {
      calls.push({ fn: "authLogin", opts });
      return 0;
    },
  };
});

const { createSettingsService } = await import("../src/settings.js");
const { saveConfig } = await import("@nema/cli/config");
// The same mocked module `settings.ts` imports, so `mockImplementationOnce` reaches the route.


const homes: string[] = [];
beforeEach(() => { calls.length = 0; waitForAbort = null; });
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function setup(globalAuthMode: "siwc" | "compat" | "byok") {
  const home = mkdtempSync(path.join(tmpdir(), "nema-account-login-"));
  homes.push(home);
  saveConfig(home, { adapter: "codex-direct", authMode: globalAuthMode });
  const service = createSettingsService({ home, codexHome: path.join(home, "no-codex") });
  const created = await service.dispatch("POST", "/_nema/accounts", { name: "Signer", adapter: "codex-direct", authMode: "siwc" });
  expect(created.status).toBe(201);
  const id = (created.body as { account: { id: string } }).account.id;
  return { service, id, home };
}

describe("an account's login targets that account", () => {
  test("runs the PKCE flow into the account's own directory, not the home", async () => {
    const { service, id, home } = await setup("siwc");
    expect((await service.dispatch("POST", "/_nema/accounts/login", { id })).status).toBe(202);
    await service.waitForJobs();
    const call = calls.find((c) => c.fn === "siwcLogin");
    expect(call).toBeTruthy();
    expect(call!.opts.baseDir).toBe(path.join(home, "secrets", "accounts", id));
    expect(call!.opts.nemaHome).toBe(home);
    expect(call!.opts.requireTrustedAuthorizeUrl).toBe(true);
    expect(call!.opts.redactCallbackErrors).toBe(true);
  });

  test("does not take the compat branch when the *default* account is compat", async () => {
    // The bug this pins: `authLogin` would read the global mode, see compat, and confirm the Codex login
    // instead of signing anybody in.
    const { service, id } = await setup("compat");
    expect((await service.dispatch("POST", "/_nema/accounts/login", { id })).status).toBe(202);
    await service.waitForJobs();
    expect(calls.map((c) => c.fn)).toEqual(["siwcLogin"]);
  });

  test("is refused for an account whose kind does not log in through a browser", async () => {
    const { service, home } = await setup("siwc");
    const created = await service.dispatch("POST", "/_nema/accounts", { name: "Keyed", adapter: "codex-direct", authMode: "byok", baseUrl: "https://b.example.com/v1" });
    const id = (created.body as { account: { id: string } }).account.id;
    expect((await service.dispatch("POST", "/_nema/accounts/login", { id })).status).toBe(409);
    await service.waitForJobs();
    expect(calls).toEqual([]);
    expect(home).toBeTruthy();
  });
});

describe("shutdown", () => {
  test("closing the service aborts a login that is still waiting for a browser", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "nema-account-abort-"));
    homes.push(home);
    saveConfig(home, { adapter: "codex-direct", authMode: "siwc" });
    const service = createSettingsService({ home, codexHome: path.join(home, "no-codex") });
    const created = await service.dispatch("POST", "/_nema/accounts", { name: "Waiter", adapter: "codex-direct", authMode: "siwc" });
    const id = (created.body as { account: { id: string } }).account.id;

    // Stand in for a login that waits for a person: it settles only when its signal fires.
    waitForAbort = {};
    expect((await service.dispatch("POST", "/_nema/accounts/login", { id })).status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const seen = waitForAbort as { signal?: AbortSignal };
    expect(seen.signal).toBeTruthy();
    expect(seen.signal!.aborted).toBe(false);
    // The whole point: `close()` must not wait out the five-minute login timeout.
    const started = Date.now();
    await service.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen.signal!.aborted).toBe(true);
    waitForAbort = null;
  });
});
