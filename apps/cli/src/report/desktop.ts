// Finds the running Nema desktop app for `nema report` when no hub is given. The descriptor file is private to this
// user, but a loopback port can be taken by any process, so the report token is only ever sent to an origin whose
// control endpoint has proved, with the descriptor's secret, that it is this home's instance.
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { LOCAL_INSTANCE_PROTOCOL, acceptedControlPorts, controlOriginFor, equalHex, homeHashFor, homeIdentityFor, instanceHmac } from "@nema/shared/localInstance";
import { openPrivateFile, privateModeMatches } from "../secrets/permissions.js";

const REQUEST_TIMEOUT_MS = 800;

export const defaultDesktopHome = (): string => path.join(os.homedir(), ".nema", "desktop");

type Descriptor = { homeHash: string; instanceId: string; installationId: string; controlOrigin: string; origin: string; secret: string };

function loopbackOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.origin === value;
  } catch { return false; }
}

function readDescriptor(file: string): Descriptor | null {
  try { lstatSync(file); } catch { return null; }
  const fd = openPrivateFile(file);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !privateModeMatches(stat) || stat.size > 16_384) return null;
    const raw = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>;
    if (raw.schemaVersion !== 1 || raw.protocol !== LOCAL_INSTANCE_PROTOCOL) return null;
    const { homeHash, instanceId, installationId, controlOrigin, origin, secret } = raw;
    if (typeof homeHash !== "string" || !/^[0-9a-f]{64}$/.test(homeHash) || typeof instanceId !== "string" || !/^[0-9a-f-]{36}$/i.test(instanceId) ||
      typeof installationId !== "string" || !/^[0-9a-f]{64}$/.test(installationId) || typeof controlOrigin !== "string" || !loopbackOrigin(origin) ||
      typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret)) return null;
    return { homeHash, instanceId, installationId, controlOrigin, origin, secret };
  } finally { closeSync(fd); }
}

function getProof(port: number, challenge: string): Promise<{ status: number; body: unknown } | null> {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port, path: `/_nema/instance?challenge=${challenge}`, method: "GET",
      headers: { host: `127.0.0.1:${port}` }, timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 4096) res.destroy(); else chunks.push(chunk); });
      res.on("error", () => resolve(null));
      res.on("close", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** The verified UI/API origin of the running desktop instance for this home, or null. Never throws. */
export async function discoverDesktopOrigin(home = defaultDesktopHome()): Promise<string | null> {
  try {
    const canonical = realpathSync.native(home);
    const identity = homeIdentityFor(canonical);
    const homeHash = homeHashFor(identity);
    const accepted = acceptedControlPorts(identity).map(controlOriginFor);
    const descriptor = readDescriptor(path.join(canonical, "instance.json"));
    if (!descriptor || descriptor.homeHash !== homeHash || !accepted.includes(descriptor.controlOrigin)) return null;
    const controlOrigin = descriptor.controlOrigin;
    const port = Number(new URL(controlOrigin).port);

    const challenge = randomBytes(32).toString("hex");
    const response = await getProof(port, challenge);
    if (!response || response.status !== 200 || !response.body || typeof response.body !== "object") return null;
    const proof = response.body as Record<string, unknown>;
    if (proof.protocol !== LOCAL_INSTANCE_PROTOCOL || proof.homeHash !== homeHash || proof.instanceId !== descriptor.instanceId ||
      proof.installationId !== descriptor.installationId || proof.controlOrigin !== controlOrigin || proof.origin !== descriptor.origin ||
      proof.challenge !== challenge || typeof proof.proof !== "string") return null;
    const expected = instanceHmac(descriptor.secret, [LOCAL_INSTANCE_PROTOCOL, homeHash, descriptor.instanceId, descriptor.installationId, controlOrigin, descriptor.origin, challenge]).toString("hex");
    return equalHex(proof.proof, expected) ? descriptor.origin : null;
  } catch { return null; }
}
