import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canSymlinkFiles } from "../links.js";

/**
 * Commit everything in `repo` plus a symlink entry (mode 120000) named `name`, and return the new HEAD sha.
 * Where the OS can create the link it is a real one. Elsewhere (unprivileged Windows) the same tree entry
 * is written with git plumbing, which is all the code under test ever sees: it reads git objects, not the
 * checkout. `run` is the test file's own git runner.
 */
export function commitWithSymlink(run: (cwd: string, args: string[]) => string, repo: string, name: string, target: string, message: string): string {
  if (canSymlinkFiles) {
    symlinkSync(target, join(repo, name));
    run(repo, ["add", "-A"]);
  } else {
    run(repo, ["add", "-A"]);
    const scratch = mkdtempSync(join(tmpdir(), "nema-symlink-blob-"));
    try {
      const blob = join(scratch, "target");
      writeFileSync(blob, target);
      const sha = run(repo, ["hash-object", "-w", blob]).trim();
      run(repo, ["update-index", "--add", "--cacheinfo", `120000,${sha},${name}`]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  run(repo, ["commit", "-m", message]);
  return run(repo, ["rev-parse", "HEAD"]).trim();
}
