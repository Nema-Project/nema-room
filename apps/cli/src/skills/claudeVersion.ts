import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandSpec } from "../platform.js";

// Native Skills need Claude Code 2.1.309+ (spec §3): `blockReadsOutsideWorkingDirectories` needs 2.1.257,
// and the prefix for same-named `--add-dir` Skills needs 2.1.309.

export const MIN_CLAUDE_SKILLS_VERSION = "2.1.309";

const execFileAsync = promisify(execFile);

/** The first `x.y.z` in `claude --version` output. */
export function parseClaudeVersion(stdout: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(stdout)?.[0] ?? null;
}

/** True when `version` is at least `min`, comparing each part as a number. */
export function versionAtLeast(version: string, min: string = MIN_CLAUDE_SKILLS_VERSION): boolean {
  const a = version.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

const runners = new Map<string, () => Promise<string>>();

/** Runs `<bin> --version`; one function per binary, so its result is cached once. */
export function claudeVersionRunner(bin = "claude"): () => Promise<string> {
  let run = runners.get(bin);
  if (!run) {
    run = async () => {
      const command = commandSpec(bin, ["--version"]);
      const { stdout } = await execFileAsync(command.bin, command.args, { timeout: 10_000, windowsHide: true });
      return stdout;
    };
    runners.set(bin, run);
  }
  return run;
}

const cache = new WeakMap<() => Promise<string>, Promise<{ ok: boolean; version: string | null }>>();

/**
 * Whether this Claude Code can load Skills natively. Runs once per runner and keeps the answer for the
 * daemon's lifetime; a run that fails counts as not supported.
 */
export function claudeSkillsSupported(run: () => Promise<string> = claudeVersionRunner()): Promise<{ ok: boolean; version: string | null }> {
  let result = cache.get(run);
  if (!result) {
    result = run().then(
      (stdout) => {
        const version = parseClaudeVersion(stdout);
        return { ok: version !== null && versionAtLeast(version), version };
      },
      () => ({ ok: false, version: null }),
    );
    cache.set(run, result);
  }
  return result;
}
