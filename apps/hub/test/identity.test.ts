import { afterEach, expect, test } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import { EventBus } from "../src/events.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

afterEach(cleanupHubDeps);
const HUB = "http://127.0.0.1:4400";
async function appFor(identity?: AppDeps["identity"]) {
  const deps = await makeHubDeps();
  const app = createApp({ ...deps, events: new EventBus(), daemonStatus: () => false,
    daemon: { call: async () => { throw new Error("offline"); } }, releaseVersion: "test", ...(identity ? { identity } : {}) });
  app.get("/api/identity-probe", c => c.json(c.get("identity")));
  return app;
}
test("defaults to local identity and ignores identity headers", async () => {
  const app = await appFor();
  expect((await app.request(`${HUB}/api/workspaces`)).status).toBe(200);
  const res = await app.request(`${HUB}/api/identity-probe`, { headers: { "x-nema-user-id": "usr_evil", "x-nema-user": "usr_evil" } });
  expect(await res.json()).toEqual({ userId: "usr_local" });
});
test("null provider rejects only UI routes and leaves version public", async () => {
  let calls = 0;
  const app = await appFor(async () => { calls++; return null; });
  const denied = await app.request(`${HUB}/api/workspaces`);
  expect(denied.status).toBe(401);
  expect(await denied.json()).toEqual({ error: "unauthorized" });
  calls = 0;
  expect((await app.request(`${HUB}/api/version`)).status).toBe(200);
  for (const path of ["/share/missing", "/room/missing", "/report"]) await app.request(`${HUB}${path}`);
  expect(calls).toBe(0);
});
