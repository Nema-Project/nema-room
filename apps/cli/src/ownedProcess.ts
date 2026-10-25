import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import net, { type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

const CONNECT_TIMEOUT_MS = 4_000;
const STARTUP_TIMEOUT_MS = 10_000;
const RETRY_MS = 25;

export type OwnedExit = { code: number | null; signal: NodeJS.Signals | null };
export type OwnedClose = OwnedExit;

export type OwnedProcess = {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  /** Terminates the guardian by its ChildProcess handle; closing its Job kills its helpers. */
  kill(signal?: NodeJS.Signals | number): boolean;
  /** Remains settled even when the target exits before spawnOwned() returns. */
  exited: Promise<OwnedExit>;
  /** Remains settled after all forwarded stdio has closed. */
  closed: Promise<OwnedClose>;
};

export type SpawnOwnedOptions = Pick<SpawnOptions, "cwd" | "env" | "stdio" | "windowsHide" | "windowsVerbatimArguments"> & {
  signal?: AbortSignal;
};

export class OwnedSpawnError extends Error {
  readonly path: string;
  readonly spawnargs: string[];
  readonly win32ErrorCode: number;
  readonly code: string;
  readonly syscall: string;

  constructor(command: string, args: string[], win32ErrorCode: number) {
    const code = nodeCodeForWin32(win32ErrorCode);
    super(`spawn ${command} ${code}`);
    this.name = "OwnedSpawnError";
    this.path = command;
    this.spawnargs = [...args];
    this.win32ErrorCode = win32ErrorCode;
    this.code = code;
    this.syscall = `spawn ${command}`;
  }
}

export class OwnedGuardianError extends Error {
  readonly path: string;
  readonly code: string | undefined;

  constructor(guardianPath: string, cause: NodeJS.ErrnoException) {
    super(`Could not start owned-helper guardian: ${cause.code ?? "unknown error"}`);
    this.name = "OwnedGuardianError";
    this.path = guardianPath;
    this.code = cause.code;
  }
}

function nodeCodeForWin32(code: number): string {
  switch (code) {
    case 2:
    case 3:
    case 126:
    case 127:
      return "ENOENT";
    case 5:
    case 740:
      return "EACCES";
    case 32:
    case 33:
      return "EBUSY";
    case 193:
      return "ENOEXEC";
    default:
      return "EIO";
  }
}

function abortError(): Error {
  const error = new Error("The owned helper startup was aborted");
  error.name = "AbortError";
  Object.assign(error, { code: "ABORT_ERR" });
  return error;
}

function isAbortError(value: unknown): value is Error {
  return value instanceof Error && value.name === "AbortError";
}

function pipeName(): string {
  return `\\\\.\\pipe\\nema-owned-${randomBytes(24).toString("hex")}`;
}

function retryablePipeError(error: NodeJS.ErrnoException): boolean {
  return error.code === "ENOENT" || error.code === "ECONNREFUSED";
}

function childEventPromises(child: ChildProcess): { exited: Promise<OwnedExit>; closed: Promise<OwnedClose> } {
  const exited = new Promise<OwnedExit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const closed = new Promise<OwnedClose>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { exited, closed };
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function connectPipe(name: string, childFailure: Promise<never>, signal?: AbortSignal): Promise<Socket> {
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let lastError: NodeJS.ErrnoException | undefined;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError();
    const socket = net.createConnection(name);
    try {
      await raceAbort(Promise.race([
        new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        }),
        childFailure,
      ]), signal);
      return socket;
    } catch (error) {
      socket.destroy();
      if (isAbortError(error)) throw error;
      if (error instanceof OwnedGuardianError) throw error;
      if (error instanceof Error && "code" in error && retryablePipeError(error as NodeJS.ErrnoException)) {
        lastError = error as NodeJS.ErrnoException;
        await raceAbort(Promise.race([delay(RETRY_MS), childFailure]), signal);
        continue;
      }
      throw error;
    }
  }
  const error = new Error("Timed out connecting to the owned-helper lease pipe", { cause: lastError });
  error.name = "OwnedGuardianTimeoutError";
  throw error;
}

function readStartupStatus(socket: Socket, childFailure: Promise<never>, signal?: AbortSignal): Promise<{ tag: "R" | "E"; code: number }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("Timed out waiting for owned-helper startup result")), STARTUP_TIMEOUT_MS);
    const onAbort = () => finish(abortError());
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 5) return;
      const tag = String.fromCharCode(buffer[0]!);
      const code = buffer.readUInt32LE(1);
      if (tag !== "R" && tag !== "E") return finish(new Error("Invalid owned-helper startup result"));
      finish(undefined, { tag, code });
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("Owned-helper guardian closed its startup channel"));
    const finish = (error?: Error, status?: { tag: "R" | "E"; code: number }) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(status!);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    childFailure.catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

function writeLease(socket: Socket, childFailure: Promise<never>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return raceAbort(Promise.race([
    new Promise<void>((resolve, reject) => socket.write("LEASE", (error) => error ? reject(error) : resolve())),
    childFailure,
  ]), signal);
}

async function terminateAndDrain(child: ChildProcess, closed: Promise<OwnedClose>, socket?: Socket): Promise<void> {
  socket?.destroy();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await closed;
}

/**
 * Start one helper inside a Windows Job Object owned by the shipped guardian.
 * This API is intentionally Windows-only; POSIX helper ownership is a separate gate.
 */
export async function spawnOwned(
  guardianPath: string,
  command: string,
  args: string[],
  options: SpawnOwnedOptions = {},
): Promise<OwnedProcess> {
  if (process.platform !== "win32") throw new Error("spawnOwned is available only on Windows until POSIX ownership is proven");
  if (options.signal?.aborted) throw abortError();

  const name = pipeName();
  const guardianArgs = [name, options.windowsVerbatimArguments ? "verbatim" : "quoted", command, ...args];
  const child = spawn(guardianPath, guardianArgs, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? "pipe",
    windowsHide: options.windowsHide ?? true,
    windowsVerbatimArguments: false,
  });
  const { exited, closed } = childEventPromises(child);
  const guardianFailure = new Promise<never>((_, reject) => {
    child.once("error", (error) => reject(new OwnedGuardianError(guardianPath, error as NodeJS.ErrnoException)));
  });

  let socket: Socket | undefined;
  const signal = options.signal;
  try {
    socket = await connectPipe(name, guardianFailure, signal);
    await writeLease(socket, guardianFailure, signal);
    const status = await readStartupStatus(socket, guardianFailure, signal);
    if (status.tag === "E") {
      await closed;
      throw new OwnedSpawnError(command, args, status.code);
    }
    if (signal?.aborted) throw abortError();

    const kill = (requested: NodeJS.Signals | number = "SIGTERM"): boolean => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      return child.kill(requested);
    };
    if (signal) {
      const onAbort = () => { kill("SIGTERM"); };
      signal.addEventListener("abort", onAbort, { once: true });
      void closed.then(() => signal.removeEventListener("abort", onAbort));
    }
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, kill, exited, closed };
  } catch (error) {
    await terminateAndDrain(child, closed, socket);
    if (signal?.aborted && !isAbortError(error)) throw abortError();
    throw error;
  }
}
