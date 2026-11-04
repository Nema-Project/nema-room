import { realpathSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { protectPrivatePath } from "@nema/cli/secrets/permissions";

export interface HomePaths {
  home: string;
  db: string;
  data: string;
  instance: string;
}

export function defaultHome(): string {
  return join(homedir(), ".nema", "desktop");
}

/**
 * Creates and canonicalizes an isolated desktop home. The legacy ~/.nema/data is never selected.
 * `protect: false` is only for a caller that has already protected this exact path in this turn.
 * It does not skip later checks of files inside the home.
 */
export function resolveHome(home = defaultHome(), options?: { protect?: boolean }): HomePaths {
  const requested = resolve(home);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const canonical = realpathSync.native(requested);
  if (options?.protect !== false) protectPrivatePath(canonical, 0o700);
  return {
    home: canonical,
    db: join(canonical, "db"),
    data: join(canonical, "data"),
    instance: join(canonical, "instance.json"),
  };
}

/** Canonical identity is case-insensitive on Windows because the filesystem is. */
export function homeIdentity(canonicalHome: string): string {
  return process.platform === "win32" ? canonicalHome.toLowerCase() : canonicalHome;
}
