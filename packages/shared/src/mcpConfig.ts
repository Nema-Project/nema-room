/**
 * An MCP server the person configured: how to start or reach it, and which values come from where.
 *
 * Credentials never live in this object. A value in a credential slot (see `isCredentialSlot`) has
 * to be a reference: `{ secret }` names a private file the daemon keeps next to the extension, and
 * `{ env }` names a variable in the daemon's own environment. Error messages name fields, never values.
 */

export type McpValue = { value: string } | { secret: string } | { env: string };

export type McpStdioConfig = { transport: "stdio"; command: string; args: string[]; cwd?: string; env: Record<string, McpValue> };
export type McpHttpConfig = { transport: "http"; url: string; headers: Record<string, McpValue> };
export type McpConfig = McpStdioConfig | McpHttpConfig;

export type McpConnection = "disconnected" | "connecting" | "connected" | "needs-login" | "error";

/** What a listing shows for an MCP record. No command line, address or value is part of it. */
export type McpRecordState = {
  transport: "stdio" | "http";
  connection: McpConnection;
  /** `serverInfo` from the last successful initialize, or null. */
  server: { name: string; version: string } | null;
  tools: Array<{ name: string; schemaDigest: string }>;
  secrets: Array<{ name: string; configured: boolean }>;
  lastError: string | null;
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const REF_NAME = ENV_NAME;
// RFC 7230 token, capped.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const SENSITIVE = ["token", "secret", "password", "passwd", "key", "auth", "cookie", "session", "credential"];
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_ARGS = 256;
const MAX_TEXT = 8192;

/** True when a variable, header or parameter name says it carries a credential. Matching is by name only. */
export function isCredentialSlot(name: string): boolean {
  const lower = name.toLowerCase();
  return CREDENTIAL_HEADERS.has(lower) || SENSITIVE.some((word) => lower.includes(word));
}

function fail(message: string): never {
  throw new Error(`invalid MCP config: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, what: string, { allowNewline = false } = {}): string {
  if (typeof value !== "string" || value.length > MAX_TEXT || value.includes("\u0000") || (!allowNewline && /[\r\n]/.test(value))) {
    fail(`${what} must be a single line of text`);
  }
  return value;
}

function parseValue(raw: unknown, slot: string, { header }: { header: boolean }): McpValue {
  if (!isObject(raw)) fail(`"${slot}" must be { value }, { secret } or { env }`);
  const keys = ["value", "secret", "env"].filter((key) => key in raw);
  if (keys.length !== 1) fail(`"${slot}" must have exactly one of value, secret or env`);
  const key = keys[0]!;
  if (key === "value") {
    if (isCredentialSlot(slot)) fail(`"${slot}" looks like a credential; use a { secret } or { env } reference`);
    if (typeof raw.value !== "string" || raw.value.length > MAX_TEXT || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(raw.value) || (header && /[\r\n]/.test(raw.value))) {
      fail(`"${slot}" must be a single line of text`);
    }
    return { value: raw.value };
  }
  const name = raw[key];
  if (typeof name !== "string" || !REF_NAME.test(name)) fail(`"${slot}" has an invalid reference name`);
  return key === "secret" ? { secret: name } : { env: name };
}

function parseValues(raw: unknown, what: string, nameRule: RegExp, nameLabel: string, header: boolean): Record<string, McpValue> {
  if (raw === undefined) return {};
  if (!isObject(raw)) fail(`${what} must be an object`);
  const out: Record<string, McpValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    // A plain object would take `__proto__` as its prototype and drop the entry.
    if (name === "__proto__") fail(`${nameLabel} "__proto__" is not allowed`);
    // The supervisor gives every stdio server the daemon's PATH and a private HOME (USERPROFILE on Windows).
    if (!header && /^(path|home|userprofile)$/i.test(name)) fail(`${nameLabel} "${name}" is set by Nema and cannot be configured`);
    if (!nameRule.test(name)) fail(`invalid ${nameLabel} "${name.slice(0, 64)}"`);
    out[name] = parseValue(value, name, { header });
  }
  return out;
}

function parseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > MAX_TEXT) fail("URL must be text");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("URL is not valid");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    fail("URL must use https (plain http only on 127.0.0.1, ::1 or localhost)");
  }
  if (url.username || url.password) fail("URL must not contain a user name or password");
  if (url.hash) fail("URL must not contain a fragment");
  for (const name of url.searchParams.keys()) {
    if (isCredentialSlot(name)) fail(`query parameter "${name.slice(0, 64)}" looks like a credential; send it as a header reference`);
  }
  return url.toString();
}

/** Validate a config from an untrusted caller and return a copy holding only the known fields. */
export function parseMcpConfig(input: unknown): McpConfig {
  if (!isObject(input)) fail("expected an object");
  const config = parseShape(input);
  // One file per secret name; on a case-insensitive disk `TOKEN` and `Token` would be one file.
  const seen = new Map<string, string>();
  for (const ref of secretRefs(config)) {
    const other = seen.get(ref.toLowerCase());
    if (other !== undefined && other !== ref) fail(`secret references "${other}" and "${ref}" differ only by letter case`);
    seen.set(ref.toLowerCase(), ref);
  }
  return config;
}

function parseShape(input: Record<string, unknown>): McpConfig {
  if (input.transport === "stdio") {
    const command = input.command;
    if (typeof command !== "string" || command.trim() === "" || command.length > 4096 || /[\u0000\r\n]/.test(command)) {
      fail("command must be a non-empty single line");
    }
    if (!Array.isArray(input.args) || input.args.length > MAX_ARGS) fail("args must be a list of strings");
    const args = input.args.map((arg, index) => text(arg, `argument ${index + 1}`));
    args.forEach((value, index) => {
      // `--api-key=…`, or `--api-key …` with the value as the next argument. A credential-named
      // switch followed by a long option (`--…`) or by nothing is a plain switch (`--no-auth`);
      // anything else after it, even `-x`, may be its value, so it is refused.
      const joined = /^--?([A-Za-z0-9_.-]+)=/.exec(value)?.[1];
      const bare = /^--?([A-Za-z0-9_.-]+)$/.exec(value)?.[1];
      const next = args[index + 1];
      const separate = bare !== undefined && next !== undefined && !next.startsWith("--");
      if ((joined && isCredentialSlot(joined)) || (separate && isCredentialSlot(bare))) {
        fail(`argument ${index + 1} looks like a credential; pass it through an environment variable reference`);
      }
    });
    const config: McpStdioConfig = { transport: "stdio", command, args, env: parseValues(input.env, "env", ENV_NAME, "environment variable name", false) };
    if (input.cwd !== undefined) {
      const cwd = text(input.cwd, "cwd");
      // Checked on save, not only at start, so a config that can never start is never stored.
      if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(cwd)) fail("cwd must be an absolute path");
      config.cwd = cwd;
    }
    return config;
  }
  if (input.transport === "http") {
    return { transport: "http", url: parseUrl(input.url), headers: parseValues(input.headers, "headers", HEADER_NAME, "header name", true) };
  }
  fail("transport must be stdio or http");
}

/** Distinct `{ secret }` names, in first-use order. */
export function secretRefs(config: McpConfig): string[] {
  const values = Object.values(config.transport === "stdio" ? config.env : config.headers);
  const names: string[] = [];
  for (const value of values) if ("secret" in value && !names.includes(value.secret)) names.push(value.secret);
  return names;
}

/**
 * True when a save changes what stored credentials would be handed to: another program, other
 * arguments, another working directory, another address, or another transport. A first save has nothing to compare against.
 */
export function mcpTargetChanged(previous: McpConfig | null, next: McpConfig): boolean {
  if (!previous) return false;
  if (previous.transport !== next.transport) return true;
  if (previous.transport === "stdio" && next.transport === "stdio") {
    return previous.command !== next.command || previous.cwd !== next.cwd || previous.args.length !== next.args.length || previous.args.some((arg, i) => arg !== next.args[i]);
  }
  return (previous as McpHttpConfig).url !== (next as McpHttpConfig).url;
}
