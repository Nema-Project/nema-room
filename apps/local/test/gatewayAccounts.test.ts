import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createGatewayCredential, startGateway } from "../src/gateway.js";
import { createSettingsService } from "../src/settings.js";
import { SessionManager } from "../src/session.js";
import { saveConfig } from "@nema/cli/config";

/**
 * The accounts routes reachable the way the page reaches them: over the gateway, with a session cookie and
 * a JSON body. The settings service alone is not enough evidence — the gateway decides which methods a
 * `/_nema/` path accepts, and `DELETE /_nema/accounts` is the one route that needs a verb no other settings
 * path has.
 */

const gateways: Array<{ close(): Promise<void> }> = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function gateway() {
  const home = mkdtempSync(path.join(tmpdir(), "nema-gw-accounts-"));
  homes.push(home);
  saveConfig(home, { adapter: "codex-direct", authMode: "byok", byokBaseUrl: "https://a.example.com/v1" });
  const session = new SessionManager();
  const settings = createSettingsService({ home, codexHome: path.join(home, "no-codex") });
  const running = await startGateway({
    webTarget: `http://127.0.0.1:9`,
    hubTarget: `http://127.0.0.1:9`,
    session,
    port: 0,
    privateGatewayCredential: createGatewayCredential(),
    settings,
  });
  gateways.push({ close: async () => { await running.close(); await settings.close(); session.close(); } });
  const launch = await fetch(`${running.origin}/_nema/launch?ticket=${session.issueTicket()}`, { redirect: "manual" });
  const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
  const call = (method: string, p: string, body?: unknown) =>
    fetch(`${running.origin}${p}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** The same request with an explicit content type, for the cases about the body rather than the verb. */
  const callRaw = (method: string, p: string, body: string, contentType: string) =>
    fetch(`${running.origin}${p}`, { method, headers: { cookie, "content-type": contentType }, body });
  return { call, callRaw, home, origin: running.origin };
}

describe("accounts routes through the gateway", () => {
  test("lists accounts, creates one, and deletes it with DELETE", async () => {
    const { call } = await gateway();

    const listed = await call("GET", "/_nema/accounts");
    expect(listed.status).toBe(200);
    expect((await listed.json() as { accounts: unknown[] }).accounts).toHaveLength(1);

    const created = await call("POST", "/_nema/accounts", { name: "B", adapter: "codex-direct", authMode: "byok", baseUrl: "https://b.example.com/v1" });
    expect(created.status).toBe(201);
    const id = (await created.json() as { account: { id: string } }).account.id;

    const deleted = await call("DELETE", "/_nema/accounts", { id });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: id });
  });

  test("refuses DELETE on the other settings paths, which never had it", async () => {
    const { call } = await gateway();
    // Same 404 an unknown method has always produced on `/_nema/`.
    expect((await call("DELETE", "/_nema/settings", { id: "x" })).status).toBe(404);
    expect((await call("DELETE", "/_nema/accounts/secret", { id: "x" })).status).toBe(404);
    expect((await call("DELETE", "/_nema/auth/secret", {})).status).toBe(404);
  });

  test("still requires a session and a JSON content type", async () => {
    const { call, callRaw, origin } = await gateway();
    // No cookie at all: the accounts routes are behind the same session check as every other settings path.
    expect((await fetch(`${origin}/_nema/accounts`)).status).toBe(401);
    // With a session, a body that is not JSON is still refused before the service sees it.
    expect((await callRaw("POST", "/_nema/accounts", "name=B", "text/plain")).status).toBe(415);
    expect((await call("POST", "/_nema/accounts", { name: "B", adapter: "claude-code" })).status).toBe(201);
  });
});
