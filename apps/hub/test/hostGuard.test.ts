import { afterEach, expect, test } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { EventBus } from "../src/events.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import { parseAllowedHosts } from "../src/main.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await cleanupHubDeps();
});

const PORT = 4400;

async function appFor(extra: Partial<AppDeps> = {}) {
  const { db, dataDir, close } = await makeHubDeps();
  closers.push(close);
  return createApp({
    db, dataDir, events: new EventBus(), daemonStatus: () => false,
    daemon: { call: async () => { throw new Error("offline"); } },
    releaseVersion: "test", port: PORT, ...extra,
  });
}

/**
 * GET /api/version answers before the identity middleware, so 200 means hostGuard passed
 * and 403 means hostGuard refused the Host. Any other status would mean the guard let the
 * request through to a route that answered differently.
 */
async function statusFor(app: ReturnType<typeof createApp>, host: string) {
  return (await app.request(`http://${host}/api/version`)).status;
}

test("remote on + allowlist: listed host passes, unlisted host is refused, loopback always passes", async () => {
  const app = await appFor({ remoteAuth: true, allowedHosts: ["hub.example.lan"] });
  expect(await statusFor(app, "hub.example.lan:4400")).toBe(200);
  // A list entry without a port matches the hostname part whatever port the Host carries.
  expect(await statusFor(app, "hub.example.lan")).toBe(200);
  expect(await statusFor(app, "evil.example:4400")).toBe(403);
  expect(await statusFor(app, "127.0.0.1:4400")).toBe(200);
  expect(await statusFor(app, "localhost:4400")).toBe(200);
});

test("remote off + allowlist filled: the list is ignored, behaviour is exactly today's", async () => {
  const app = await appFor({ allowedHosts: ["hub.example.lan"] });
  expect(await statusFor(app, "hub.example.lan:4400")).toBe(403);
  expect(await statusFor(app, "evil.example:4400")).toBe(403);
  expect(await statusFor(app, "127.0.0.1:4400")).toBe(200);
  expect(await statusFor(app, "localhost:4400")).toBe(200);
});

test("remote on + empty allowlist: only loopback passes", async () => {
  const app = await appFor({ remoteAuth: true, allowedHosts: [] });
  expect(await statusFor(app, "hub.example.lan:4400")).toBe(403);
  expect(await statusFor(app, "127.0.0.1:4400")).toBe(200);
  expect(await statusFor(app, "localhost:4400")).toBe(200);
});

test("remote on + no allowlist: only loopback passes", async () => {
  const app = await appFor({ remoteAuth: true });
  expect(await statusFor(app, "hub.example.lan:4400")).toBe(403);
  expect(await statusFor(app, "127.0.0.1:4400")).toBe(200);
});

test("an allowlist entry with a port matches only that port", async () => {
  const app = await appFor({ remoteAuth: true, allowedHosts: ["hub.example.lan:8443"] });
  expect(await statusFor(app, "hub.example.lan:8443")).toBe(200);
  expect(await statusFor(app, "hub.example.lan:4400")).toBe(403);
  expect(await statusFor(app, "hub.example.lan")).toBe(403);
});

test("allowlist matching is case-insensitive", async () => {
  const app = await appFor({ remoteAuth: true, allowedHosts: ["HUB.Example.LAN"] });
  expect(await statusFor(app, "hub.example.lan:4400")).toBe(200);
  expect(await statusFor(app, "HUB.EXAMPLE.LAN:4400")).toBe(200);
});

test("remote off without a list keeps today's loopback-only behaviour", async () => {
  const app = await appFor({});
  expect(await statusFor(app, "127.0.0.1:4400")).toBe(200);
  expect(await statusFor(app, "localhost:4400")).toBe(200);
  expect(await statusFor(app, "evil.example:4400")).toBe(403);
});

test("parseAllowedHosts splits on commas, trims, and drops empties", () => {
  expect(parseAllowedHosts(undefined)).toEqual([]);
  expect(parseAllowedHosts("")).toEqual([]);
  expect(parseAllowedHosts("hub.example.lan, hub.example.lan:8443 ,, ")).toEqual(["hub.example.lan", "hub.example.lan:8443"]);
});
