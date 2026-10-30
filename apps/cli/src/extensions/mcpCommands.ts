// `nema mcp add | edit | start | stop | status | list | secret set | secret clear`.
//
// Configs and start/stop go through the hub's /api routes, so only the daemon writes `index.json` and
// `mcp.json`. `secret set` and `secret clear` only touch the private credential files on this
// computer (D-2), so a value never travels through the hub from the CLI. Bare `nema mcp` stays the
// Room MCP server that Codex and Claude Code start.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { parseMcpConfig, secretRefs, type McpValue } from "@nema/shared";
import type { Out } from "../direct/authCommands.js";
import { openMcpSecretStore } from "../secrets/mcp.js";
import { readStdinLine } from "../secrets/file.js";
import { openExtensionStore } from "./store.js";

export type McpCommandDeps = {
  nemaHome: string;
  hubUrl: (flag?: string) => Promise<string>;
  out: Out;
  stdin: () => NodeJS.ReadableStream;
  fetch?: typeof fetch;
};

const REF = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** `NAME=value`, `NAME=secret:REF`, `NAME=env:VAR`; `NAME=value:…` keeps a literal that starts with a prefix. */
export function parseValueFlag(raw: string): [string, McpValue] {
  const at = raw.indexOf("=");
  if (at <= 0) throw new Error("expected NAME=VALUE, NAME=secret:REF or NAME=env:VAR");
  const name = raw.slice(0, at);
  const rest = raw.slice(at + 1);
  if (rest.startsWith("secret:")) return [name, { secret: rest.slice(7) }];
  if (rest.startsWith("env:")) return [name, { env: rest.slice(4) }];
  if (rest.startsWith("value:")) return [name, { value: rest.slice(6) }];
  return [name, { value: rest }];
}

type ConfigFlags = { name?: string; command?: string; arg?: string[]; cwd?: string; url?: string; env?: string[]; header?: string[]; hub?: string };

function configFrom(flags: ConfigFlags): unknown {
  if (flags.command && flags.url) throw new Error("give --command or --url, not both");
  const values = (items: string[] | undefined) => Object.fromEntries((items ?? []).map(parseValueFlag));
  if (flags.url) return { transport: "http", url: flags.url, headers: values(flags.header) };
  if (!flags.command) throw new Error("give --command (stdio) or --url (HTTP)");
  return { transport: "stdio", command: flags.command, args: flags.arg ?? [], ...(flags.cwd ? { cwd: flags.cwd } : {}), env: values(flags.env) };
}

class HubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function registerMcpCommands(mcp: Command, deps: McpCommandDeps, exit: (code: number) => void = (code) => { process.exitCode = code; }): void {
  const fetchImpl = deps.fetch ?? fetch;

  async function hub(flag: string | undefined, method: string, route: string, body?: unknown): Promise<any> {
    const base = await deps.hubUrl(flag);
    let response: Response;
    try {
      response = await fetchImpl(`${base}/api${route}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      throw new HubError(0, `Nema hub is not reachable at ${base}`);
    }
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (response.status === 401 || response.status === 403) {
      throw new HubError(response.status, "this hub only accepts the desktop app's own requests; use the Plugins page there (secrets can still be set with `nema mcp secret set`)");
    }
    if (!response.ok) throw new HubError(response.status, typeof json?.error === "string" ? json.error : `the hub refused the request (HTTP ${response.status})`);
    return json;
  }

  const action = <A extends unknown[]>(run: (...args: A) => Promise<void>) => async (...args: A) => {
    try {
      await run(...args);
      exit(0);
    } catch (error) {
      deps.out.error(error instanceof Error ? error.message : String(error));
      exit(1);
    }
  };

  const withConfigFlags = (command: Command) =>
    command
      .option("--name <name>", "display name")
      .option("--command <command>", "stdio: program to start (no shell)")
      .option("--arg <arg>", "stdio: one argument; repeat for more", (value: string, all: string[] = []) => [...all, value])
      .option("--cwd <dir>", "stdio: absolute working directory")
      .option("--env <NAME=VALUE>", "stdio: environment value, NAME=secret:REF or NAME=env:VAR; repeatable", (value: string, all: string[] = []) => [...all, value])
      .option("--url <url>", "HTTP: server address (https, or http on loopback)")
      .option("--header <NAME=VALUE>", "HTTP: request header, same forms as --env; repeatable", (value: string, all: string[] = []) => [...all, value])
      .option("--hub <url>", "hub URL (default: NEMA_HUB_URL, else a running Nema desktop app, else http://127.0.0.1:4400)");

  async function exists(flag: string | undefined, id: string): Promise<{ name: string } | null> {
    try {
      return await hub(flag, "GET", `/extensions/${encodeURIComponent(id)}/mcp`);
    } catch (error) {
      if (error instanceof HubError && error.status === 404) return null;
      throw error;
    }
  }

  async function save(id: string, flags: ConfigFlags, mode: "add" | "edit"): Promise<void> {
    // Checked here first, so a refused value never leaves this computer.
    const config = parseMcpConfig(configFrom(flags));
    const current = await exists(flags.hub, id);
    if (mode === "add" && current) throw new Error(`MCP server ${id} already exists; use \`nema mcp edit\``);
    if (mode === "edit" && !current) throw new Error(`MCP server not found: ${id}`);
    const name = flags.name ?? current?.name;
    if (!name) throw new Error("give --name");
    await hub(flags.hub, "POST", "/extensions/mcp", { id, name, config });
    deps.out.log(`saved ${id}; its stored secrets: ${secretRefs(config).join(", ") || "none"} (set with \`nema mcp secret set ${id} NAME\`)`);
  }

  withConfigFlags(mcp.command("add <id>").description("Add an MCP server (stdio --command or HTTP --url)")).action(action((id: string, flags: ConfigFlags) => save(id, flags, "add")));
  withConfigFlags(mcp.command("edit <id>").description("Replace an MCP server's config; a new command, args, cwd or URL clears its secrets")).action(action((id: string, flags: ConfigFlags) => save(id, flags, "edit")));

  const printStatus = (status: { id: string; connection: string; lastError: string | null; tools?: unknown[] }) =>
    deps.out.log(`${status.id}: ${status.connection}${status.tools?.length ? `, ${status.tools.length} tools` : ""}${status.lastError ? ` (${status.lastError})` : ""}`);

  for (const verb of ["start", "stop"] as const) {
    mcp.command(`${verb} <id>`).description(`${verb === "start" ? "Start" : "Stop"} an MCP server`).option("--hub <url>", "hub URL")
      .action(action(async (id: string, flags: { hub?: string }) => printStatus(await hub(flags.hub, "POST", `/extensions/${encodeURIComponent(id)}/mcp/${verb}`, {}))));
  }
  mcp.command("status <id>").description("Show an MCP server's connection").option("--hub <url>", "hub URL")
    .action(action(async (id: string, flags: { hub?: string }) => printStatus(await hub(flags.hub, "GET", `/extensions/${encodeURIComponent(id)}/mcp/status`))));
  mcp.command("list").description("List MCP servers").option("--hub <url>", "hub URL")
    .action(action(async (flags: { hub?: string }) => {
      const rows = ((await hub(flags.hub, "GET", "/extensions")) as any[]).filter((row) => row?.kind === "mcp");
      if (rows.length === 0) deps.out.log("no MCP servers");
      for (const row of rows) deps.out.log(`${row.id}  ${row.name}  ${row.source}  ${row.useState}  ${row.mcp?.connection ?? "unknown"}`);
    }));

  /** Only names the saved config references, read without writing anything the daemon owns. */
  function referenced(id: string, name: string): void {
    if (!REF.test(name)) throw new Error("invalid secret name");
    const root = path.join(deps.nemaHome, "extensions");
    const record = openExtensionStore(root).list().find((row) => row.id === id);
    if (!record) throw new Error(`MCP server not found: ${id}`);
    if (record.kind !== "mcp" || record.provision !== "managed") throw new Error(`${id} is not an MCP server`);
    let refs: string[];
    try {
      refs = secretRefs(parseMcpConfig(JSON.parse(readFileSync(path.join(root, "extensions", id, "mcp.json"), "utf8"))));
    } catch {
      throw new Error(`the config of ${id} cannot be read; save it again`);
    }
    if (!refs.includes(name)) throw new Error(`secret ${name} is not referenced by the config of ${id}`);
  }

  const secret = mcp.command("secret").description("Write or clear an MCP server credential on this computer");
  secret.command("set <id> <name>").description("Read one line from stdin into the private credential file")
    .action(action(async (id: string, name: string) => {
      referenced(id, name);
      const value = await readStdinLine(deps.stdin());
      openMcpSecretStore(deps.nemaHome).set(id, name, value);
      deps.out.log(`saved ${name} for ${id}; a running server uses it after a restart (\`nema mcp stop ${id}\` then \`start\`)`);
    }));
  secret.command("clear <id> <name>").description("Delete one credential file")
    .action(action(async (id: string, name: string) => {
      if (!REF.test(name)) throw new Error("invalid secret name");
      openMcpSecretStore(deps.nemaHome).clear(id, name);
      deps.out.log(`cleared ${name} for ${id}`);
    }));
}
