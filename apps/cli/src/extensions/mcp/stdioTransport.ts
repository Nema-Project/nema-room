import { spawn, type ChildProcess } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { OwnedHelperProcess, OwnedHelperScope } from "@nema/shared/ownedHelper";

const KILL_GRACE_MS = 2000;
const STOPPED = "MCP server stopped";

export type McpStdioLaunch = {
  bin: string;
  args: string[];
  /** The child's whole environment; nothing is inherited. */
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Desktop runtime: the guardian owns the process tree. Without it the child leads its own POSIX process group. */
  ownedHelpers?: OwnedHelperScope;
};

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  // detached => the child leads its own group; a negative pid signals the whole group.
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
}

/**
 * The SDK's stdio client transport, except that the environment is exactly `env`, stderr is dropped
 * (it can echo credentials), and stopping takes the process group down with it. A descendant that
 * leaves the group (setsid) is not covered without the owned-helper scope.
 */
export class McpStdioTransport implements Transport {
  private child: ChildProcess | OwnedHelperProcess | undefined;
  private readonly buffer = new ReadBuffer();
  private startPromise?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly launch: McpStdioLaunch) {}

  /** Process id of the server, once spawned. */
  get pid(): number | undefined {
    const child = this.child;
    return child && "pid" in child ? child.pid : undefined;
  }

  start(): Promise<void> {
    this.startPromise = this.launch.ownedHelpers ? this.startOwned(this.launch.ownedHelpers) : this.startDetached();
    return this.startPromise;
  }

  private startDetached(): Promise<void> {
    const { bin, args, env, cwd } = this.launch;
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true, detached: process.platform !== "win32" });
      this.child = child;
      let spawned = false;
      child.on("error", (error) => {
        if (!spawned) reject(error);
        else this.onerror?.(error);
      });
      child.on("spawn", () => {
        spawned = true;
        if (this.closed) signalGroup(child.pid, "SIGKILL");
        resolve();
      });
      child.on("close", () => this.onclose?.());
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => this.read(chunk));
    });
  }

  private async startOwned(scope: OwnedHelperScope): Promise<void> {
    const { bin, args, env, cwd } = this.launch;
    const child = await scope.spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    this.child = child;
    if (this.closed) {
      child.kill("SIGTERM");
      await child.closed;
      throw new Error(STOPPED);
    }
    void child.closed.then(() => this.onclose?.());
    child.stdin?.on("error", (error) => this.onerror?.(error as Error));
    child.stdout?.on("data", (chunk: Buffer) => this.read(chunk));
  }

  private read(chunk: Buffer): void {
    this.buffer.append(chunk);
    for (;;) {
      let message: JSONRPCMessage | null;
      try { message = this.buffer.readMessage(); }
      catch (error) { this.onerror?.(error as Error); continue; }
      if (message === null) break;
      this.onmessage?.(message);
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (this.closed || !stdin || !stdin.writable) {
        reject(new Error(STOPPED));
        return;
      }
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", resolve);
    });
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.stop();
    }
    return this.closing;
  }

  private async stop(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => {});
    const child = this.child;
    this.buffer.clear();
    if (!child) return;
    if (!("exitCode" in child)) {
      child.kill("SIGTERM");
      await child.closed;
      return;
    }
    const pid = child.pid;
    const running = child.exitCode === null && child.signalCode === null;
    if (running) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (process.platform === "win32") child.kill("SIGKILL");
          else signalGroup(pid, "SIGKILL");
        }, KILL_GRACE_MS);
        timer.unref();
        child.once("close", () => { clearTimeout(timer); resolve(); });
        if (process.platform === "win32") child.kill("SIGTERM");
        else signalGroup(pid, "SIGTERM");
      });
    }
    // The leader is gone; anything still in its group goes now.
    if (process.platform !== "win32") signalGroup(pid, "SIGKILL");
  }
}
