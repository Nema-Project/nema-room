// Agent CLIs (Codex, Claude Code) are never bundled or installed by Nema (#132 D-6 = A): this only reports
// whether one answers `--version` on PATH and, when not, where its official install instructions live.
import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { promisify } from "node:util";
import { commandPathCandidates, commandSpec } from "./platform.js";

const execFileAsync = promisify(execFile);

export type AgentCliId = "codex" | "claude-code";

export type AgentCliStatus = {
  id: AgentCliId;
  /** The command looked up on PATH. */
  command: string;
  installed: boolean;
  /** First line of `--version` when installed. */
  version: string | null;
  /** The vendor's own install instructions; Nema links to them and never runs an installer. */
  installUrl: string;
};

export const AGENT_CLIS: ReadonlyArray<{ id: AgentCliId; command: string; installUrl: string }> = [
  { id: "codex", command: "codex", installUrl: "https://developers.openai.com/codex/cli" },
  { id: "claude-code", command: "claude", installUrl: "https://code.claude.com/docs/en/setup" },
];

const VERSION_TIMEOUT_MS = 10_000;

/** Runs `<command> --version` and resolves with its stdout; rejects with the spawn error as Node reports it. */
export type VersionRunner = (command: string) => Promise<string>;

export async function runVersion(command: string, timeoutMs: number = VERSION_TIMEOUT_MS): Promise<string> {
  const spec = commandSpec(command, ["--version"]);
  // execFile resolves successfully when the child traps the kill signal and exits 0, so track the timer
  // separately: a probe that outlived the timeout is a timeout whatever the exit status.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, timeoutMs);
  try {
    const { stdout } = await execFileAsync(spec.bin, spec.args, { timeout: timeoutMs, windowsHide: true });
    if (timedOut) {
      throw Object.assign(new Error(`Command timed out after ${timeoutMs}ms: ${spec.bin} --version`), { killed: true, signal: "SIGTERM" });
    }
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One `--version` answer, split by how it ended (#302 D-4). `enoent` is the spawn itself failing to find a
 * file — which on POSIX also covers a dangling link or a missing shebang interpreter, so it is not yet "not
 * installed". `error` is everything else: a non-zero exit, or `commandSpec` refusing a Windows shim.
 */
export type VersionResult =
  | { kind: "ok"; version: string | null }
  | { kind: "enoent" }
  | { kind: "timeout" }
  | { kind: "error" };

export type VersionExecutor = (command: string) => Promise<VersionResult>;

function firstLine(stdout: string): string | null {
  const version = stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return version === "" ? null : version;
}

/** The shared executor: one runner, its outcome split. Never rejects. */
export function executeVersion(run: VersionRunner = runVersion): VersionExecutor {
  return async (command) => {
    try {
      return { kind: "ok", version: firstLine(await run(command)) };
    } catch (e) {
      const err = e as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null | undefined;
      if (err?.code === "ENOENT") return { kind: "enoent" };
      // execFile's `timeout` kills the child and rejects with `killed` and the signal it sent; runVersion
      // throws the same shape when the child traps the signal and exits 0 after the timer fired.
      if (err?.killed === true && typeof err.signal === "string") return { kind: "timeout" };
      return { kind: "error" };
    }
  };
}

/** One `--version` per CLI, in parallel. A CLI that is missing, times out or fails counts as not installed. */
export async function detectAgentClis(run: VersionRunner = runVersion): Promise<AgentCliStatus[]> {
  const execute = executeVersion(run);
  return Promise.all(
    AGENT_CLIS.map(async ({ id, command, installUrl }) => {
      const result = await execute(command);
      if (result.kind === "ok") return { id, command, installed: true, version: result.version, installUrl };
      return { id, command, installed: false, version: null, installUrl };
    }),
  );
}

/**
 * Whether PATH has a directory entry for this command, by `commandSpec`'s lookup rules. Only `lstat`: nothing
 * is executed, and a link counts even when its target is gone — that is exactly the broken-shim case.
 */
export function commandOnSearchPath(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  for (const candidate of commandPathCandidates(command, env, platform)) {
    try {
      lstatSync(candidate);
      return true;
    } catch {
      // Absent or unreadable: keep looking.
    }
  }
  return false;
}

/** What readiness reports about a command: ENOENT is resolved into "nothing on PATH" or "on PATH but broken". */
export type CliProbe =
  | { kind: "ok"; version: string | null }
  | { kind: "not_found" }
  | { kind: "broken" }
  | { kind: "timeout" }
  | { kind: "error" };

export function classifyVersion(command: string, result: VersionResult, env: NodeJS.ProcessEnv = process.env, platform = process.platform): CliProbe {
  if (result.kind !== "enoent") return result;
  return commandOnSearchPath(command, env, platform) ? { kind: "broken" } : { kind: "not_found" };
}

export const VERSION_CACHE_MS = 30_000;

type Started = { generation: number; promise: Promise<VersionResult> };

/**
 * `--version` with a short success cache, for readiness only (D-4). `detectAgentClis` does not use it, so
 * the components page keeps running a fresh probe each time.
 *
 * - Only `ok` is cached, for 30 seconds: a user who just installed the CLI must not keep reading "not found".
 * - Ordinary requests share the command's latest in-flight probe.
 * - `force` starts a new probe and drops the cache at once.
 * - Only the latest started probe may write the cache; an older one that answers after a `force` cannot.
 */
export class VersionProbe {
  private readonly execute: VersionExecutor;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { result: VersionResult; at: number }>();
  private readonly latest = new Map<string, Started>();
  private generation = 0;

  constructor(o: { execute?: VersionExecutor; now?: () => number; ttlMs?: number } = {}) {
    this.execute = o.execute ?? executeVersion();
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? VERSION_CACHE_MS;
  }

  version(command: string, o: { force?: boolean } = {}): Promise<VersionResult> {
    if (o.force) {
      this.cache.delete(command);
      return this.start(command);
    }
    const cached = this.cache.get(command);
    if (cached !== undefined && this.now() - cached.at < this.ttlMs) return Promise.resolve(cached.result);
    const inFlight = this.latest.get(command);
    if (inFlight !== undefined) return inFlight.promise;
    return this.start(command);
  }

  private start(command: string): Promise<VersionResult> {
    const generation = ++this.generation;
    const promise = Promise.resolve()
      .then(() => this.execute(command))
      .catch((): VersionResult => ({ kind: "error" }))
      .then((result) => {
        if (this.latest.get(command)?.generation === generation) {
          this.latest.delete(command);
          if (result.kind === "ok") this.cache.set(command, { result, at: this.now() });
          else this.cache.delete(command);
        }
        return result;
      });
    this.latest.set(command, { generation, promise });
    return promise;
  }
}
