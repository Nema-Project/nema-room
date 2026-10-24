// The daemon's one long-lived MCP client to github-mcp-server. The child gets fixed read-only arguments
// and exactly PATH, HOME (under ~/.nema/run/github/) and GITHUB_PERSONAL_ACCESS_TOKEN; its stderr is dropped.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { PLUGINS } from "@nema/shared";
import { readGithubToken } from "../secrets/github.js";
import { commandSpec, windowsRuntimeEnv } from "../platform.js";

export const GITHUB_ARGS = ["stdio", "--read-only", "--toolsets", "pull_requests,issues"] as const;

const NOT_INSTALLED = "github-mcp-server 未安装";
const STOPPED = "GitHub 插件已停止";
const TIMED_OUT = "GitHub 插件调用超时";
const START_FAILED = "GitHub 插件启动失败";
const MAX_TEXT = 65_536;
const CALL_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 60_000;
const STATUS_TIMEOUT_MS = 10_000;

/** The fixed tool list, from the `github` manifest. Nothing else is ever called. */
export const GITHUB_TOOLS: readonly string[] = (PLUGINS.find((plugin) => plugin.id === "github")?.functions ?? []).map((fn) =>
  fn.name.slice("github__".length),
);

const noTool = (tool: string) => new Error(`GitHub 插件没有工具 ${tool}`);

function cutUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let index = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += ch.length;
  }
  return text.slice(0, index);
}

/** Like the SDK's StdioClientTransport, but the child environment is exactly `env`, with nothing inherited. */
class ExactEnvStdioTransport implements Transport {
  private child: ChildProcess | undefined;
  private readonly buffer = new ReadBuffer();
  private closing?: Promise<void>;
  private spawnedChild: ChildProcess | undefined;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    private readonly bin: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly cwd: string,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = commandSpec(this.bin, [...GITHUB_ARGS], this.env);
      const child = spawn(command.bin, command.args, { env: this.env, cwd: this.cwd, stdio: ["pipe", "pipe", "ignore"], shell: false, windowsHide: true });
      this.child = child;
      this.spawnedChild = child;
      let spawned = false;
      child.on("error", (error) => {
        if (!spawned) reject(error);
        else this.onerror?.(error);
      });
      child.on("spawn", () => {
        spawned = true;
        resolve();
      });
      child.on("close", () => {
        this.child = undefined;
        this.onclose?.();
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        this.buffer.append(chunk);
        for (;;) {
          let message: JSONRPCMessage | null;
          try {
            message = this.buffer.readMessage();
          } catch (error) {
            this.onerror?.(error as Error);
            continue;
          }
          if (message === null) break;
          this.onmessage?.(message);
        }
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin || !stdin.writable) {
        reject(new Error(STOPPED));
        return;
      }
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", resolve);
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeChild();
    return this.closing;
  }

  private async closeChild(): Promise<void> {
    const child = this.spawnedChild;
    this.child = undefined;
    this.buffer.clear();
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const done = () => { if (killTimer) clearTimeout(killTimer); resolve(); };
        child.once("close", done);
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, 2000);
        killTimer.unref();
      });
    }
  }
}

type Connection = {
  client: Client;
  transport: ExactEnvStdioTransport;
  tools: Set<string>;
  alive: boolean;
  /** Rejects with `GitHub 插件已停止` when the child exits. */
  stopped: Promise<never>;
};

export type GithubMcpOpts = {
  nemaHome: string;
  /** Defaults to `github-mcp-server` from PATH. */
  bin?: string;
  /** Overrides the PATH the child sees; defaults to the daemon's PATH. */
  spawnEnv?: { PATH?: string };
  /** For tests. */
  timeoutMs?: number;
  retryDelayMs?: number;
  warn?: (message: string) => void;
};

export class GithubMcp {
  private conn: Connection | null = null;
  private starting: Promise<Connection> | null = null;
  private startError: { message: string; until: number } | null = null;
  private closed = false;
  private closing?: Promise<void>;
  private startingTransport?: ExactEnvStdioTransport;

  constructor(private readonly opts: GithubMcpOpts) {}

  private get bin(): string {
    return this.opts.bin || "github-mcp-server";
  }

  private homeDir(): string {
    const dir = path.join(this.opts.nemaHome, "run", "github", "home");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private basePath(): string {
    return this.opts.spawnEnv?.PATH ?? process.env.PATH ?? "";
  }

  private warn(message: string): void {
    (this.opts.warn ?? ((m: string) => console.warn(m)))(message);
  }

  /** `installed`: the binary runs. `loggedIn`: the token file is readable. Never starts the server. */
  async status(): Promise<{ installed: boolean; loggedIn: boolean; detail: string }> {
    let loggedIn = true;
    let tokenDetail = "";
    try {
      readGithubToken(this.opts.nemaHome);
    } catch (e) {
      loggedIn = false;
      tokenDetail = e instanceof Error ? e.message : String(e);
    }
    const version = await this.version();
    if (!version.ok) return { installed: false, loggedIn, detail: version.detail };
    return { installed: true, loggedIn, detail: loggedIn ? version.detail : tokenDetail };
  }

  private version(): Promise<{ ok: boolean; detail: string }> {
    const home = this.homeDir();
    const command = commandSpec(this.bin, ["--version"]);
    return new Promise((resolve) => {
      execFile(
        command.bin,
        command.args,
        { env: { ...windowsRuntimeEnv(process.env), PATH: this.basePath(), HOME: home }, cwd: home, timeout: STATUS_TIMEOUT_MS, shell: false, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve({ ok: false, detail: (error as NodeJS.ErrnoException).code === "ENOENT" ? NOT_INSTALLED : START_FAILED });
            return;
          }
          resolve({ ok: true, detail: cutUtf8(String(stdout).trim(), 200) });
        },
      );
    });
  }

  /** Calls one fixed read tool and returns its text content, capped at 64 KB. */
  async call(tool: string, args: object): Promise<unknown> {
    if (!GITHUB_TOOLS.includes(tool)) throw noTool(tool);
    if (this.closed) throw new Error(STOPPED);
    const conn = await this.ensure();
    if (!conn.tools.has(tool)) throw noTool(tool);
    let result;
    try {
      result = await Promise.race([
        conn.client.callTool({ name: tool, arguments: args as Record<string, unknown> }, undefined, {
          timeout: this.opts.timeoutMs ?? CALL_TIMEOUT_MS,
        }),
        conn.stopped,
      ]);
    } catch (e) {
      if (!conn.alive) throw new Error(STOPPED);
      const message = e instanceof Error ? e.message : String(e);
      if (/timed out|timeout/i.test(message)) throw new Error(TIMED_OUT);
      throw new Error(`GitHub 插件调用失败：${cutUtf8(message, 2000)}`);
    }
    const content = Array.isArray(result.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>) : [];
    const text = content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string)
      .join("\n");
    if (result.isError) throw new Error(`GitHub：${cutUtf8(text, 2000)}`);
    return cutUtf8(text, MAX_TEXT);
  }

  private async ensure(): Promise<Connection> {
    if (this.conn?.alive) return this.conn;
    // The token is re-read on every start, so `nema auth github` takes effect without a daemon restart.
    const token = readGithubToken(this.opts.nemaHome);
    if (this.startError && Date.now() < this.startError.until) throw new Error(this.startError.message);
    if (!this.starting) {
      this.starting = this.start(token).then(
        (conn) => {
          this.starting = null;
          this.startError = null;
          this.conn = conn;
          return conn;
        },
        (error: unknown) => {
          this.starting = null;
          const message = error instanceof Error ? error.message : String(error);
          this.startError = { message, until: Date.now() + (this.opts.retryDelayMs ?? RETRY_DELAY_MS) };
          throw new Error(message);
        },
      );
    }
    return this.starting;
  }

  private async start(token: string): Promise<Connection> {
    if (this.closed) throw new Error(STOPPED);
    const home = this.homeDir();
    const transport = new ExactEnvStdioTransport(this.bin, { ...windowsRuntimeEnv(process.env), PATH: this.basePath(), HOME: home, GITHUB_PERSONAL_ACCESS_TOKEN: token }, home);
    this.startingTransport = transport;
    const client = new Client({ name: "nema-daemon", version: "0.1.0" });
    let markStopped: (error: Error) => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      markStopped = reject;
    });
    stopped.catch(() => {});
    const conn: Connection = { client, transport, tools: new Set(), alive: true, stopped };
    client.onclose = () => {
      conn.alive = false;
      if (this.conn === conn) this.conn = null;
      markStopped(new Error(STOPPED));
    };
    client.onerror = () => {
      // Errors surface through the call that hit them, or through the close that follows.
    };
    try {
      await client.connect(transport, { timeout: this.opts.timeoutMs ?? CALL_TIMEOUT_MS });
      const listed = await client.listTools(undefined, { timeout: this.opts.timeoutMs ?? CALL_TIMEOUT_MS });
      const offered = new Set(listed.tools.map((item) => item.name));
      for (const tool of GITHUB_TOOLS) {
        if (offered.has(tool)) conn.tools.add(tool);
        else this.warn(`[nema] github-mcp-server 没有工具 ${tool}，已跳过`);
      }
    } catch (e) {
      conn.alive = false;
      await transport.close().catch(() => {});
      if (this.startingTransport === transport) this.startingTransport = undefined;
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(NOT_INSTALLED);
      throw new Error(START_FAILED);
    }
    if (this.closed) {
      conn.alive = false;
      await transport.close().catch(() => {});
      if (this.startingTransport === transport) this.startingTransport = undefined;
      throw new Error(STOPPED);
    }
    if (this.startingTransport === transport) this.startingTransport = undefined;
    return conn;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      conn.alive = false;
      conn.client.onclose?.();
    }
    const starting = this.starting;
    this.closing = Promise.all([
      conn?.transport.close() ?? Promise.resolve(),
      this.startingTransport?.close() ?? Promise.resolve(),
      starting?.then((pending) => pending.transport.close(), () => {}) ?? Promise.resolve(),
    ]).then(() => {});
    return this.closing;
  }
}
