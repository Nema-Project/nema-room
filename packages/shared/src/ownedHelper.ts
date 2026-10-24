import { execFile, type ExecFileOptions } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export type OwnedHelperExit = { code: number | null; signal: NodeJS.Signals | null };

/** The target's stdio and durable target-exit/pipe-close lifecycle from the native guardian API. */
export type OwnedHelperProcess = {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  exited: Promise<OwnedHelperExit>;
  closed: Promise<OwnedHelperExit>;
};

export type OwnedHelperSpawnOptions = Pick<SpawnOptions, "cwd" | "env" | "stdio" | "windowsHide" | "windowsVerbatimArguments"> & {
  signal?: AbortSignal;
};

/** Per-runtime injection contract. No shared implementation or process-global owner is installed. */
export type OwnedHelperScope = {
  spawn(command: string, args: string[], options?: OwnedHelperSpawnOptions): Promise<OwnedHelperProcess>;
  stopAccepting(): void;
  drain(): Promise<void>;
};

export type OwnedHelperSpawner = (
  command: string,
  args: string[],
  options?: OwnedHelperSpawnOptions,
) => Promise<OwnedHelperProcess>;

export type OwnedHelperFileOptions = Pick<ExecFileOptions, "cwd" | "env" | "timeout" | "maxBuffer" | "encoding"> & {
  input?: Buffer;
  signal?: AbortSignal;
};

export type OwnedHelperFileResult = {
  error: Error | null;
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
};

/** Buffered execFile-compatible helper call. An injected scope is fail-closed and never falls back to spawn(). */
export async function runHelperFile(
  command: string,
  args: string[],
  options: OwnedHelperFileOptions = {},
  scope?: OwnedHelperScope,
): Promise<OwnedHelperFileResult> {
  if (!scope) {
    return new Promise((resolve) => {
      execFile(command, args, options, (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
        const childError = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        resolve({
          error: error ?? null,
          stdout: out,
          stderr: err,
          code: childError && typeof childError.code === "number" ? childError.code : childError ? null : 0,
          signal: (childError as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null } | null)?.signal ?? null,
          timedOut: Boolean(childError?.killed),
        });
      });
    });
  }

  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  let child: OwnedHelperProcess;
  try {
    child = await scope.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const code = cause && typeof cause === "object" && "code" in cause ? (cause as { code?: unknown }).code : undefined;
    return {
      error,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: typeof code === "number" ? code : null,
      signal: null,
      timedOut: false,
    };
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outSize = 0;
  let errSize = 0;
  let overflow = false;
  let timedOut = false;
  const collect = (target: Buffer[], chunk: Buffer, isOut: boolean) => {
    if (overflow) return;
    if (isOut) outSize += chunk.length;
    else errSize += chunk.length;
    if (outSize + errSize > maxBuffer) {
      overflow = true;
      child.kill("SIGTERM");
      return;
    }
    target.push(Buffer.from(chunk));
  };
  child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk, true));
  child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk, false));
  if (options.input !== undefined && child.stdin) {
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeout && options.timeout > 0) timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, options.timeout);
  const closed = await child.closed;
  if (timer) clearTimeout(timer);
  const out = Buffer.concat(stdout);
  const err = Buffer.concat(stderr);
  const error = overflow
    ? Object.assign(new Error(`maxBuffer exceeded: ${maxBuffer} bytes`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })
    : timedOut
      ? Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT", killed: true })
      : closed.code === 0 ? null : Object.assign(new Error(err.toString("utf8").trim() || `${command} exited ${closed.code ?? closed.signal ?? "unknown"}`), { code: closed.code, signal: closed.signal });
  return { error, stdout: out, stderr: err, code: closed.code, signal: closed.signal, timedOut };
}
