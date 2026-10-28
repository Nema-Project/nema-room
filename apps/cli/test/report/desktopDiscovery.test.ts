import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_INSTANCE_PROTOCOL, controlOriginFor, controlPortFor, homeHashFor, homeIdentityFor, instanceHmac } from "@nema/shared/localInstance";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_HUB_URL, resolveHubTarget } from "../../src/report/commands.js";
import { discoverDesktopOrigin } from "../../src/report/desktop.js";
import { protectPrivatePath } from "../../src/secrets/permissions.js";

let home: string;
let server: http.Server | undefined;
const ORIGIN = "http://127.0.0.1:43111";

beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), "nema-desktop-discovery-"))); });
afterEach(async () => {
  vi.unstubAllEnvs();
  if (server?.listening) { server.close(); server.closeAllConnections(); await once(server, "close"); }
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

type Fake = { secret?: string; serverSecret?: string; instanceId?: string; serve?: boolean; origin?: string; port?: number };

/** A descriptor plus a fake control endpoint that answers the way the desktop runtime does. */
async function startFake(options: Fake = {}): Promise<void> {
  const identity = homeIdentityFor(home);
  const homeHash = homeHashFor(identity);
  const port = options.port ?? controlPortFor(identity);
  const controlOrigin = controlOriginFor(port);
  const secret = options.secret ?? randomBytes(32).toString("hex");
  const instanceId = randomUUID();
  const installationId = randomBytes(32).toString("hex");
  const file = join(home, "instance.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, protocol: LOCAL_INSTANCE_PROTOCOL, homeHash, instanceId, installationId, pid: process.pid, controlOrigin, origin: options.origin ?? ORIGIN, secret }), { mode: 0o600 });
  protectPrivatePath(file, 0o600);
  if (options.serve === false) return;
  server = http.createServer((req, res) => {
    const challenge = new URL(req.url ?? "/", controlOrigin).searchParams.get("challenge") ?? "";
    const answeredId = options.instanceId ?? instanceId;
    const proof = instanceHmac(options.serverSecret ?? secret, [LOCAL_INSTANCE_PROTOCOL, homeHash, answeredId, installationId, controlOrigin, ORIGIN, challenge]).toString("hex");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ protocol: LOCAL_INSTANCE_PROTOCOL, homeHash, instanceId: answeredId, installationId, controlOrigin, origin: ORIGIN, challenge, proof }));
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
}

describe("discoverDesktopOrigin", () => {
  test("returns the origin of an instance that proves its identity with the descriptor secret", async () => {
    await startFake();
    expect(await discoverDesktopOrigin(home)).toBe(ORIGIN);
  });

  test("returns null when the endpoint cannot prove the secret, answers as another instance, or is gone", async () => {
    await startFake({ serverSecret: randomBytes(32).toString("hex") });
    expect(await discoverDesktopOrigin(home)).toBeNull();
    server!.close(); server!.closeAllConnections(); await once(server!, "close");
    await startFake({ instanceId: randomUUID() });
    expect(await discoverDesktopOrigin(home)).toBeNull();
    server!.close(); server!.closeAllConnections(); await once(server!, "close");
    await startFake({ serve: false });
    expect(await discoverDesktopOrigin(home)).toBeNull();
  });

  test("returns the origin when the descriptor still names the previous control port", async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const identity = homeIdentityFor(home);
      const port = 20000 + createHash("sha256").update(identity).digest().readUInt32BE(0) % 25000;
      if (port !== controlPortFor(identity)) {
        await startFake({ port });
        expect(await discoverDesktopOrigin(home)).toBe(ORIGIN);
        return;
      }
      rmSync(home, { recursive: true, force: true });
      home = realpathSync(mkdtempSync(join(tmpdir(), "nema-desktop-discovery-")));
    }
    throw new Error("no home whose previous control port differs from the current one");
  });

  test("returns null for a missing home, a missing descriptor and a non-loopback origin", async () => {
    expect(await discoverDesktopOrigin(join(home, "does-not-exist"))).toBeNull();
    expect(await discoverDesktopOrigin(home)).toBeNull();
    await startFake({ origin: "http://example.test" });
    expect(await discoverDesktopOrigin(home)).toBeNull();
  });
});

describe("resolveHubTarget", () => {
  test("an explicit --hub or NEMA_HUB_URL wins and is never probed", async () => {
    const discover = vi.fn(async () => ORIGIN);
    expect(await resolveHubTarget("http://127.0.0.1:9999", discover)).toBe("http://127.0.0.1:9999");
    vi.stubEnv("NEMA_HUB_URL", "http://127.0.0.1:8888");
    expect(await resolveHubTarget(undefined, discover)).toBe("http://127.0.0.1:8888");
    expect(discover).not.toHaveBeenCalled();
  });

  test("otherwise uses a verified desktop instance, else the legacy default", async () => {
    vi.stubEnv("NEMA_HUB_URL", "");
    expect(await resolveHubTarget(undefined, async () => ORIGIN)).toBe(ORIGIN);
    expect(await resolveHubTarget(undefined, async () => null)).toBe(DEFAULT_HUB_URL);
  });
});
