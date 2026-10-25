import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A directory link every platform can create: a junction on Windows (no privilege needed), a symlink elsewhere. */
export function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : undefined);
}

function probeFileSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "nema-link-probe-"));
  try {
    writeFileSync(join(dir, "target"), "x");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Windows only lets privileged users (admin or Developer Mode) create file symlinks, and a junction cannot
 * point at a file. Tests that plant a file symlink run only where it can be created; a skipped test proves
 * nothing, so Windows acceptance needs a run on a host where this is true.
 */
export const canSymlinkFiles = probeFileSymlinks();
