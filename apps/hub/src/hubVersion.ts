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

export function versionSkewMessage(hubVersion: string): string {
  return `hub 与 nema CLI 版本不一致（hub ${hubVersion}），请安装 nema@${hubVersion}`;
}
