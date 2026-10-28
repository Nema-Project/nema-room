// The local-instance identity protocol shared by the desktop runtime (which answers) and the CLI (which verifies
// before it sends a report token anywhere). Node-only: import from "@nema/shared/localInstance", never from the index.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const LOCAL_INSTANCE_PROTOCOL = "nema-local-v1";

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();

export const homeHashFor = (identity: string): string => sha256(identity).toString("hex");
// 20000–32767 stays below the default ephemeral ranges (Linux 32768, macOS/Windows 49152).
export const controlPortFor = (identity: string): number => 20000 + sha256(identity).readUInt32BE(0) % 12768;
export const controlOriginFor = (port: number): string => `http://127.0.0.1:${port}`;

/** Canonical identity is case-insensitive on Windows because the filesystem is. */
export const homeIdentityFor = (canonicalHome: string, platform: NodeJS.Platform = process.platform): string =>
  platform === "win32" ? canonicalHome.toLowerCase() : canonicalHome;

export function instanceHmac(secret: string, tuple: unknown[]): Buffer {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(JSON.stringify(tuple)).digest();
}

export function equalHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
