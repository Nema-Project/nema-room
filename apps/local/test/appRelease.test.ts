import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createAppReleaseService, readBuildIdentity, UPDATE_CHECK_FILE, UPDATE_STATUS_FILE } from "../src/appRelease.js";
import { createGatewayCredential, startGateway } from "../src/gateway.js";
import { SessionManager } from "../src/session.js";

const homes: string[] = [];
const gateways: Array<{ close(): Promise<void> }> = [];
function tempHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "nema-release-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const newer = () => new Response(JSON.stringify({ tag_name: "v0.2.0", draft: false, prerelease: false }), { status: 200 });

describe("desktop release service", () => {
  test("reads a short commit from the manifest or build metadata", () => {
    const root = tempHome();
    expect(readBuildIdentity(root, { version: "0.1.3", commit: "ABCDEF0123456789" }).commit).toBe("abcdef0");
    writeFileSync(path.join(root, "build-metadata.json"), JSON.stringify({ build: { commit: "1234abcd5678" } }));
    expect(readBuildIdentity(root, { version: "0.1.3" })).toEqual({ version: "0.1.3", commit: "1234abc" });
    expect(readBuildIdentity(root, { version: "0.1.3", commit: "nope" }).commit).toBe("1234abc");
  });

  test("serves the version only to a signed-in session and checks with a fake release", async () => {
    const home = tempHome();
    const fetchImpl = vi.fn(async () => newer());
    const appRelease = createAppReleaseService({ home, version: "0.1.3", commit: "abc1234", fetchImpl, schedule: false });
    const session = new SessionManager();
    const gateway = await startGateway({
      webTarget: "http://127.0.0.1:9",
      hubTarget: "http://127.0.0.1:9",
      session,
      port: 0,
      privateGatewayCredential: createGatewayCredential(),
      appRelease,
    });
    gateways.push(gateway);
    const token = session.consumeTicket(session.issueTicket())!;
    const cookie = `nema_session_${new URL(gateway.origin).port}=${token}`;

    expect((await fetch(`${gateway.origin}/_nema/version`)).status).toBe(401);
    expect(await (await fetch(`${gateway.origin}/_nema/version`, { headers: { cookie } })).json()).toEqual({ version: "0.1.3", commit: "abc1234" });

    const checked = await fetch(`${gateway.origin}/_nema/update/check`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(await checked.json()).toEqual({
      enabled: true,
      state: "newer",
      offer: { version: "0.2.0", url: "https://github.com/Nema-Project/nema-room/releases/tag/v0.2.0" },
    });
    const status = JSON.parse(readFileSync(path.join(home, UPDATE_STATUS_FILE), "utf8")) as { state: string; url: string };
    expect(status).toMatchObject({ state: "newer", version: "0.2.0", url: "https://github.com/Nema-Project/nema-room/releases/tag/v0.2.0" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const disabled = await fetch(`${gateway.origin}/_nema/update`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(await disabled.json()).toMatchObject({ enabled: false, state: "disabled" });
    expect(JSON.parse(readFileSync(path.join(home, UPDATE_CHECK_FILE), "utf8"))).toEqual({ updateCheck: { enabled: false } });
    expect(disabled.headers.get("cache-control")).toBe("no-store");
    appRelease.close();
    session.close();
  });

  test("a disabled automatic check does not call the network, and a tray request still does", async () => {
    const home = tempHome();
    writeFileSync(path.join(home, UPDATE_CHECK_FILE), JSON.stringify({ updateCheck: { enabled: false } }));
    const fetchImpl = vi.fn(async () => newer());
    const quiet = createAppReleaseService({ home, version: "0.1.3", fetchImpl, schedule: true, delayMs: 10, intervalMs: 60_000, requestPollMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fetchImpl).not.toHaveBeenCalled();
    quiet.close();

    const asked = createAppReleaseService({ home, version: "0.1.3", fetchImpl, schedule: true, delayMs: 60_000, intervalMs: 60_000, requestPollMs: 20 });
    writeFileSync(path.join(home, UPDATE_CHECK_FILE), JSON.stringify({ updateCheck: { enabled: false }, checkRequestedAt: Date.now() }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    asked.close();
  });

  test("a failed check stays silent", async () => {
    const home = tempHome();
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    const service = createAppReleaseService({ home, version: "0.1.3", fetchImpl, schedule: false });
    const result = await service.dispatch("POST", "/_nema/update/check", {});
    expect(result).toEqual({ status: 200, body: { enabled: true, state: "error" } });
    expect(JSON.parse(readFileSync(path.join(home, UPDATE_STATUS_FILE), "utf8"))).toMatchObject({ state: "error" });
    service.close();
  });
});
