import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpConfig, McpConnection, McpValue } from "@nema/shared";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { commandSpec, windowsRuntimeEnv, withElectronNode } from "../../platform.js";
import type { McpLeftovers } from "./leftovers.js";
import { LEFTOVER_RECORD, McpStdioTransport } from "./stdioTransport.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TOOLS = 512;
/** Set by the supervisor for every stdio server; a config cannot replace them. */
const RESERVED_ENV = /^(path|home|userprofile)$/i;

export type McpStatus = {
  id: string;
  connection: McpConnection;
  server: { name: string; version: string } | null;
  tools: Array<{ name: string; schemaDigest: string }>;
  lastError: string | null;
};

export type McpSupervisorOptions = {
  nemaHome: string;
  configs: { config(id: string): McpConfig };
  secrets: { resolve(id: string, name: string): string };
  ownedHelpers?: OwnedHelperScope;
  /** Connect plus `listTools`. */
  timeoutMs?: number;
  /** For tests. */
  platform?: NodeJS.Platform;
  /** Records of running stdio servers (POSIX, without the owned-helper scope). */
  leftovers?: McpLeftovers;
};

/** A start failure whose message is safe to show: it names a slot or a condition, never a value or server output. */
class StartError extends Error {
  constructor(message: string, readonly connection: McpConnection = "error") {
    super(message);
  }
}

type Instance = {
  client: Client;
  transport: Transport;
  /** Set once `stop` or `closeAll` has asked this instance to end. */
  ending: boolean;
};

type Attempt = { abort: AbortController };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function schemaDigest(schema: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(schema ?? null))).digest("hex");
}

const idle = (id: string): McpStatus => ({ id, connection: "disconnected", server: null, tools: [], lastError: null });

/**
 * Starts, connects to and stops the MCP servers people configured. One instance per id; every
 * operation on an id runs on that id's chain, so starts, stops and restarts never interleave.
 * Nothing here hands tools to an agent (D-3): it records what the server offers, nothing more.
 */
export class McpSupervisor {
  private readonly statuses = new Map<string, McpStatus>();
  private readonly instances = new Map<string, Instance>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly stopsQueued = new Map<string, number>();
  private shuttingDown = false;

  constructor(private readonly o: McpSupervisorOptions) {}

  /** Show a note on a stopped server, e.g. that a copy left by the previous daemon was stopped. */
  note(id: string, message: string): void {
    if (this.status(id).connection === "disconnected") this.set(id, { ...idle(id), lastError: message });
  }

  status(id: string): McpStatus {
    return this.statuses.get(id) ?? idle(id);
  }

  /** Idempotent: a connected or connecting id returns its status without a second process. */
  start(id: string): Promise<McpStatus> {
    if (this.shuttingDown) return Promise.resolve(this.set(id, { ...idle(id), connection: "error", lastError: "the daemon is shutting down" }));
    const current = this.status(id).connection;
    // A queued stop wins over the status it has not changed yet: start again after it.
    if ((current === "connecting" || current === "connected") && !this.stopsQueued.get(id)) {
      // A start already queued or running answers for both callers.
      const pending = this.chains.get(id);
      return pending ? pending.then(() => this.status(id), () => this.status(id)) : Promise.resolve(this.status(id));
    }
    this.set(id, { ...idle(id), connection: "connecting" });
    // Registered now, not when the chain reaches it, so a stop queued behind it can cancel it.
    const attempt: Attempt = { abort: new AbortController() };
    this.attempts.set(id, attempt);
    return this.enqueue(id, () => this.doStart(id, attempt));
  }

  stop(id: string): Promise<void> {
    this.attempts.get(id)?.abort.abort();
    return this.stopping(id, () => this.doStop(id));
  }

  /** For credential changes: a running server comes back with the new values; a stopped one stays stopped. */
  restart(id: string): Promise<McpStatus> {
    // A start in flight is using the old values: end it and start again.
    const attempt = this.attempts.get(id);
    attempt?.abort.abort();
    const wasStarting = attempt !== undefined || this.status(id).connection === "connecting";
    return this.stopping(id, async () => {
      const wasRunning = wasStarting || this.instances.has(id);
      await this.doStop(id);
      if (!wasRunning || this.shuttingDown) return this.status(id);
      this.set(id, { ...idle(id), connection: "connecting" });
      const next: Attempt = { abort: new AbortController() };
      this.attempts.set(id, next);
      return this.doStart(id, next);
    });
  }

  /** Queue an operation that begins with a stop, counted so `start` does not mistake it for a running server. */
  private stopping<T>(id: string, run: () => Promise<T>): Promise<T> {
    this.stopsQueued.set(id, (this.stopsQueued.get(id) ?? 0) + 1);
    return this.enqueue(id, async () => {
      try {
        return await run();
      } finally {
        const left = (this.stopsQueued.get(id) ?? 1) - 1;
        if (left > 0) this.stopsQueued.set(id, left);
        else this.stopsQueued.delete(id);
      }
    });
  }

  /** Refuse new starts, end the ones in flight, then stop everything. */
  async closeAll(): Promise<void> {
    this.shuttingDown = true;
    for (const attempt of this.attempts.values()) attempt.abort.abort();
    await Promise.allSettled([...this.chains.values()]);
    await Promise.allSettled([...this.instances.keys()].map((id) => this.enqueue(id, () => this.doStop(id))));
  }

  private set(id: string, status: McpStatus): McpStatus {
    this.statuses.set(id, status);
    return status;
  }

  private enqueue<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.chains.set(id, next);
    void next.catch(() => {}).finally(() => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    });
    return next;
  }

  private async doStop(id: string): Promise<void> {
    const instance = this.instances.get(id);
    this.instances.delete(id);
    if (instance) {
      instance.ending = true;
      await instance.client.close().catch(() => {});
      await instance.transport.close().catch(() => {});
    }
    this.set(id, idle(id));
  }

  private async doStart(id: string, attempt: Attempt): Promise<McpStatus> {
    if (this.instances.has(id)) {
      if (this.attempts.get(id) === attempt) this.attempts.delete(id);
      return this.status(id);
    }
    let transport: Transport | undefined;
    let status: { last?: number } = {};
    try {
      if (attempt.abort.signal.aborted) throw new StartError("stopped", "disconnected");
      if (this.shuttingDown) throw new StartError("the daemon is shutting down");
      let config: McpConfig;
      try {
        config = this.o.configs.config(id);
      } catch (error) {
        throw new StartError(error instanceof Error ? error.message : "MCP config cannot be read");
      }
      const built = this.transportFor(id, config);
      transport = built.transport;
      status = built.status;
      const client = new Client({ name: "nema-daemon", version: "0.1.0" });
      client.onerror = () => {};
      const instance: Instance = { client, transport, ending: false };
      const timeoutMs = this.o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const signal = AbortSignal.any([attempt.abort.signal, AbortSignal.timeout(timeoutMs)]);
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(attempt.abort.signal.aborted ? new StartError("stopped", "disconnected") : new StartError(`the server did not answer within ${Math.round(timeoutMs / 1000)} s`));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
      aborted.catch(() => {});
      await Promise.race([client.connect(transport, { timeout: timeoutMs, signal }), aborted]);
      const listed = await Promise.race([client.listTools(undefined, { timeout: timeoutMs, signal }), aborted]);
      if (attempt.abort.signal.aborted) throw new StartError("stopped", "disconnected");
      const info = client.getServerVersion();
      this.instances.set(id, instance);
      client.onclose = () => {
        if (instance.ending || this.instances.get(id) !== instance) return;
        this.instances.delete(id);
        void instance.transport.close().catch(() => {});
        this.set(id, { ...this.status(id), connection: "error", lastError: "the server exited" });
      };
      return this.set(id, {
        id,
        connection: "connected",
        server: info ? { name: String(info.name).slice(0, 200), version: String(info.version).slice(0, 100) } : null,
        // What the server reports is untrusted: keep the list and the names bounded.
        tools: listed.tools.slice(0, MAX_TOOLS).map((tool) => ({ name: String(tool.name).slice(0, 128), schemaDigest: schemaDigest(tool.inputSchema) })),
        lastError: null,
      });
    } catch (error) {
      await transport?.close().catch(() => {});
      const failure = this.classify(error, status.last);
      return this.set(id, { ...idle(id), connection: failure.connection, lastError: failure.connection === "disconnected" ? null : failure.message });
    } finally {
      if (this.attempts.get(id) === attempt) this.attempts.delete(id);
    }
  }

  private classify(error: unknown, httpStatus: number | undefined): StartError {
    if (error instanceof StartError) return error;
    if (httpStatus === 401 || httpStatus === 403) return new StartError(`the server asked for a login (HTTP ${httpStatus})`, "needs-login");
    if (httpStatus !== undefined && httpStatus >= 300 && httpStatus < 400) return new StartError(`the server answered with a redirect (HTTP ${httpStatus}); redirects are not followed`);
    if (httpStatus !== undefined && httpStatus >= 400) return new StartError(`the server answered HTTP ${httpStatus}`);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return new StartError("the command was not found");
    if (code === "EACCES") return new StartError("the command cannot be run");
    if (code === LEFTOVER_RECORD) return new StartError("could not record the server under run/mcp in the Nema home, so it was not started");
    // SDK and server messages can carry server output; keep a fixed text.
    return new StartError("the server could not be reached or closed the connection");
  }

  private value(id: string, value: McpValue): string {
    if ("value" in value) return value.value;
    if ("secret" in value) {
      try {
        return this.o.secrets.resolve(id, value.secret);
      } catch {
        throw new StartError(`secret ${value.secret} is not set or cannot be read`);
      }
    }
    const found = process.env[value.env];
    if (found === undefined) throw new StartError(`environment variable ${value.env} is not set for the daemon`);
    return found;
  }

  private transportFor(id: string, config: McpConfig): { transport: Transport; status: { last?: number } } {
    const status: { last?: number } = {};
    if (config.transport === "http") {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(config.headers)) headers[name] = this.value(id, value);
      const fetchManual = async (url: string | URL, init?: RequestInit) => {
        const response = await fetch(url, { ...init, redirect: "manual" });
        status.last = response.status;
        return response;
      };
      return {
        transport: new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers, redirect: "manual" },
          fetch: fetchManual,
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
        }),
        status,
      };
    }
    const platform = this.o.platform ?? process.platform;
    if (platform === "win32" && !this.o.ownedHelpers) {
      throw new StartError("stdio MCP servers on Windows need the desktop app, which can clean up their process tree");
    }
    if (config.cwd !== undefined && !path.isAbsolute(config.cwd)) throw new StartError("cwd must be an absolute path");
    const home = path.join(this.o.nemaHome, "run", "mcp", id, "home");
    const env: NodeJS.ProcessEnv = { ...windowsRuntimeEnv(process.env) };
    for (const [name, value] of Object.entries(config.env)) {
      if (RESERVED_ENV.test(name)) continue;
      env[name] = this.value(id, value);
    }
    // Last, so a config can never replace them (parseMcpConfig also refuses the names).
    env.PATH = process.env.PATH ?? "";
    env.HOME = home;
    // Windows programs (and Node's os.homedir()) read USERPROFILE, not HOME.
    if (platform === "win32") env.USERPROFILE = home;
    // Under Electron this forces Node mode after the config is copied, so a config cannot clear it.
    // Under host Node the configured value stays, including an explicit ELECTRON_RUN_AS_NODE.
    const childEnv = withElectronNode(env);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const command = commandSpec(config.command, config.args, childEnv);
    return {
      transport: new McpStdioTransport({
        bin: command.bin,
        args: command.args,
        env: childEnv,
        cwd: config.cwd ?? home,
        ownedHelpers: this.o.ownedHelpers,
        ...(this.o.leftovers && !this.o.ownedHelpers && platform !== "win32"
          ? { leftover: { record: (pid: number) => this.o.leftovers!.record(id, pid), clear: (pid: number) => this.o.leftovers!.clear(id, pid) } }
          : {}),
      }),
      status,
    };
  }
}
