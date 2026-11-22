import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { extractTarGz } from "@nema/cli/components/archive";

export type PresetDbResult = { seeded: true } | { seeded: false; reason: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Lands the desktop payload's first-run database seed (#265) at `target`, which must not exist yet.
 *
 * The archive is extracted into a fresh sibling directory with the component installer's extractor (absolute
 * names, `..`, hard links, and symlink escapes are refused), checked for a PGlite `PG_VERSION` file, and only
 * then renamed into place. Any failure removes that sibling and returns `seeded: false`, so the caller opens an
 * empty directory exactly as before. An existing `target` is never read, changed, or replaced.
 */
export async function seedPresetDb(archive: string, target: string): Promise<PresetDbResult> {
  try {
    if (present(target)) return { seeded: false, reason: "the database directory already exists" };
  } catch (error) {
    return { seeded: false, reason: message(error) };
  }
  const staging = join(dirname(target), `${basename(target)}.preset-${randomBytes(6).toString("hex")}`);
  let created = false;
  try {
    // Not recursive: the managed home already exists, and a leftover name must not be reused.
    mkdirSync(staging, { mode: 0o700 });
    created = true;
    await extractTarGz(readFileSync(archive), staging);
    if (!lstatSync(join(staging, "PG_VERSION")).isFile()) throw new Error("the seed has no PG_VERSION file");
    // rename(2) would replace an empty directory on POSIX; refuse instead of touching anything at `target`.
    if (present(target)) throw new Error("the database directory appeared while the seed was extracted");
    renameSync(staging, target);
    return { seeded: true };
  } catch (error) {
    let reason = message(error);
    if (created) {
      try { rmSync(staging, { recursive: true, force: true }); }
      catch (cleanup) { reason += `; the partial seed ${staging} could not be removed: ${message(cleanup)}`; }
    }
    return { seeded: false, reason };
  }
}
