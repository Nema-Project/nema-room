import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Release version the daemon must match. `@nema/hub` stays 0.0.0; the user-facing version is the CLI package. */
export function readHubReleaseVersion(start = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    for (const file of [path.join(dir, "apps", "cli", "package.json"), path.join(dir, "cli", "package.json")]) {
      try {
        const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "@nema/cli" && typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
      } catch {
        // Keep walking until the monorepo or image layout that contains apps/cli/package.json.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not read the CLI release version for hub pairing");
}

/**
 * The oldest CLI a hub accepts (D-9). Held at the current CLI version: the release stamp for v0.3.3 must
 * raise it to 0.3.3, the first version that speaks registration credentials and heldRepos reporting.
 * Raising it before that stamp would refuse the development CLI, which still reports 0.3.2 until the
 * stamp runs — the hub reads its own release version from the same package.
 */
export const MIN_DAEMON_VERSION = "0.3.2";

type ParsedVersion = { core: number[]; pre: (string | number)[] | null };

function parseVersion(version: string): ParsedVersion {
  const [withoutBuild] = version.split("+");
  const [main, ...preParts] = (withoutBuild ?? "").split("-");
  const core = (main ?? "").split(".").map((part) => {
    const num = Number.parseInt(part, 10);
    return Number.isFinite(num) ? num : 0;
  });
  while (core.length < 3) core.push(0);
  const pre = preParts.length > 0
    ? preParts.join("-").split(".").map((part) => (/^\d+$/.test(part) ? Number.parseInt(part, 10) : part))
    : null;
  return { core, pre };
}

/**
 * Compares `x.y.z` versions (an optional `-prerelease` sorts before its release, per SemVer). Returns a
 * negative number when `a` is older, zero when equal, positive when newer. Non-numeric parts count as 0,
 * so a malformed version never passes as newer than the floor by accident.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i]! - pb.core[i]!;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    // A numeric identifier sorts before an alphanumeric one.
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The refusal for a daemon below the minimum version: names the floor and tells the operator to install
 * the hub's version. Keeps the `版本不一致` phrase and the `@nema-project/nema@<version>` spec the CLI's
 * reconnect logic keys on.
 */
export function versionSkewMessage(hubVersion: string, minVersion: string = MIN_DAEMON_VERSION): string {
  return `hub 与 nema CLI 版本不一致：hub 要求 CLI 不低于 ${minVersion}（hub ${hubVersion}），请安装 @nema-project/nema@${hubVersion} 后重启 daemon`;
}
