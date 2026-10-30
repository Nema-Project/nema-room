import { describe, expect, test } from "vitest";
import { isCredentialSlot, mcpTargetChanged, parseMcpConfig, secretRefs } from "../src/mcpConfig.js";

const MARK = "nema-test-secret-7f3a";

function rejects(input: unknown, pattern: RegExp): void {
  let message = "";
  try {
    parseMcpConfig(input);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(pattern);
  expect(message).not.toContain(MARK);
}

describe("parseMcpConfig", () => {
  test("accepts a stdio config with plain, secret and env values", () => {
    const config = parseMcpConfig({
      transport: "stdio",
      command: "node",
      args: ["server.mjs", "--port", "0"],
      env: { LOG_LEVEL: { value: "debug" }, API_TOKEN: { secret: "API_TOKEN" }, HOME_DIR: { env: "HOME" } },
    });
    expect(config).toEqual({
      transport: "stdio",
      command: "node",
      args: ["server.mjs", "--port", "0"],
      env: { LOG_LEVEL: { value: "debug" }, API_TOKEN: { secret: "API_TOKEN" }, HOME_DIR: { env: "HOME" } },
    });
  });

  test("accepts an HTTP config with hyphenated header names", () => {
    const config = parseMcpConfig({
      transport: "http",
      url: "https://mcp.example.com/mcp?region=eu",
      headers: { "X-API-Key": { secret: "KEY" }, "Content-Type": { value: "application/json" }, "X-Region": { value: "eu" } },
    });
    expect(config).toMatchObject({ transport: "http", url: "https://mcp.example.com/mcp?region=eu" });
  });

  test("allows plain http only on loopback", () => {
    for (const url of ["http://127.0.0.1:3001/mcp", "http://localhost:3001/mcp", "http://[::1]:3001/mcp"]) {
      expect(parseMcpConfig({ transport: "http", url, headers: {} }).transport).toBe("http");
    }
    rejects({ transport: "http", url: "http://mcp.example.com/mcp", headers: {} }, /https/);
    rejects({ transport: "http", url: "ftp://mcp.example.com/mcp", headers: {} }, /https/);
  });

  test("refuses credentials in the URL", () => {
    rejects({ transport: "http", url: `https://user:${MARK}@mcp.example.com/mcp`, headers: {} }, /user name or password/);
    rejects({ transport: "http", url: `https://mcp.example.com/mcp?token=${MARK}`, headers: {} }, /query parameter "token"/);
    rejects({ transport: "http", url: `https://mcp.example.com/mcp?api_key=${MARK}`, headers: {} }, /query parameter "api_key"/);
    rejects({ transport: "http", url: `https://mcp.example.com/mcp#${MARK}`, headers: {} }, /fragment/);
  });

  test("credential slots take only secret or env references", () => {
    rejects({ transport: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: { value: `Bearer ${MARK}` } } }, /"Authorization".*reference/);
    rejects({ transport: "http", url: "https://mcp.example.com/mcp", headers: { Cookie: { value: MARK } } }, /"Cookie".*reference/);
    rejects({ transport: "stdio", command: "node", args: [], env: { API_TOKEN: { value: MARK } } }, /"API_TOKEN".*reference/);
    rejects({ transport: "stdio", command: "node", args: [], env: { GITHUB_PAT_SECRET: { value: MARK } } }, /"GITHUB_PAT_SECRET".*reference/);
    expect(parseMcpConfig({ transport: "stdio", command: "node", args: [], env: { API_TOKEN: { env: "API_TOKEN" } } }).transport).toBe("stdio");
  });

  test("refuses credential-looking arguments", () => {
    rejects({ transport: "stdio", command: "server", args: [`--api-key=${MARK}`], env: {} }, /argument 1/);
    rejects({ transport: "stdio", command: "server", args: [`-token=${MARK}`], env: {} }, /argument 1/);
    rejects({ transport: "stdio", command: "server", args: ["ok", `--password=${MARK}`], env: {} }, /argument 2/);
    expect(parseMcpConfig({ transport: "stdio", command: "server", args: ["--port=3000", "--verbose"], env: {} }).transport).toBe("stdio");
  });

  test("refuses a credential flag followed by its value as a separate argument", () => {
    rejects({ transport: "stdio", command: "server", args: ["--api-key", MARK], env: {} }, /argument 1/);
    rejects({ transport: "stdio", command: "server", args: ["serve", "-token", MARK], env: {} }, /argument 2/);
    // A credential-named switch with no value after it is a plain switch.
    expect(parseMcpConfig({ transport: "stdio", command: "server", args: ["--no-auth", "--verbose"], env: {} }).args).toEqual(["--no-auth", "--verbose"]);
    expect(parseMcpConfig({ transport: "stdio", command: "server", args: ["--use-keychain"], env: {} }).transport).toBe("stdio");
  });

  test("refuses PATH and HOME in env, which the daemon sets itself", () => {
    for (const name of ["PATH", "Path", "HOME"]) {
      rejects({ transport: "stdio", command: "node", args: [], env: { [name]: { value: "/x" } } }, new RegExp(`"${name}" is set by Nema`));
    }
  });

  test("refuses __proto__ as a name instead of losing the entry", () => {
    rejects(JSON.parse(`{"transport":"stdio","command":"node","args":[],"env":{"__proto__":{"value":"x"}}}`), /__proto__/);
    rejects(JSON.parse(`{"transport":"http","url":"https://a.example/mcp","headers":{"__proto__":{"value":"x"}}}`), /__proto__/);
  });

  test("refuses secret references that differ only by letter case", () => {
    rejects({ transport: "stdio", command: "node", args: [], env: { A_TOKEN: { secret: "TOKEN" }, B_TOKEN: { secret: "Token" } } }, /letter case/);
    expect(parseMcpConfig({ transport: "stdio", command: "node", args: [], env: { A_TOKEN: { secret: "TOKEN" }, B_TOKEN: { secret: "TOKEN" } } }).transport).toBe("stdio");
  });

  test("refuses malformed commands, names and values", () => {
    rejects(null, /object/);
    rejects({ transport: "sse" }, /transport/);
    rejects({ transport: "stdio", command: "", args: [], env: {} }, /command/);
    rejects({ transport: "stdio", command: "node\nrm", args: [], env: {} }, /command/);
    rejects({ transport: "stdio", command: "node", args: "server.mjs", env: {} }, /args/);
    rejects({ transport: "stdio", command: "node", args: ["a\u0000b"], env: {} }, /argument 1/);
    rejects({ transport: "stdio", command: "node", args: [], env: { "BAD-NAME": { value: "x" } } }, /environment variable name/);
    rejects({ transport: "stdio", command: "node", args: [], env: { OK: { value: "x", secret: "Y" } } }, /exactly one/);
    rejects({ transport: "stdio", command: "node", args: [], env: { OK: { secret: "../etc" } } }, /reference name/);
    rejects({ transport: "http", url: "https://mcp.example.com/mcp", headers: { "Bad Header": { value: "x" } } }, /header name/);
    rejects({ transport: "http", url: "https://mcp.example.com/mcp", headers: { "X-Region": { value: `eu\r\n${MARK}` } } }, /"X-Region"/);
    rejects({ transport: "http", url: "not a url", headers: {} }, /URL/);
  });

  test("drops unknown keys", () => {
    const config = parseMcpConfig({ transport: "stdio", command: "node", args: [], env: {}, extra: MARK });
    expect(JSON.stringify(config)).not.toContain(MARK);
  });
});

describe("helpers", () => {
  test("isCredentialSlot matches names, not values", () => {
    for (const name of ["Authorization", "proxy-authorization", "COOKIE", "API_KEY", "x-api-key", "SESSION_ID", "DB_PASSWORD", "MY_CREDENTIALS"]) {
      expect(isCredentialSlot(name)).toBe(true);
    }
    for (const name of ["LOG_LEVEL", "X-Region", "Content-Type", "PORT"]) expect(isCredentialSlot(name)).toBe(false);
  });

  test("secretRefs lists the distinct secret names a config uses", () => {
    expect(
      secretRefs(parseMcpConfig({ transport: "stdio", command: "node", args: [], env: { A_TOKEN: { secret: "T" }, B_TOKEN: { secret: "T" }, C: { env: "C" } } })),
    ).toEqual(["T"]);
  });

  test("mcpTargetChanged is true only when the command, its arguments, the URL or the transport change", () => {
    const stdio = parseMcpConfig({ transport: "stdio", command: "node", args: ["a"], env: {} });
    expect(mcpTargetChanged(null, stdio)).toBe(false);
    expect(mcpTargetChanged(stdio, parseMcpConfig({ transport: "stdio", command: "node", args: ["a"], env: { LOG: { value: "1" } } }))).toBe(false);
    expect(mcpTargetChanged(stdio, parseMcpConfig({ transport: "stdio", command: "node", args: ["b"], env: {} }))).toBe(true);
    expect(mcpTargetChanged(stdio, parseMcpConfig({ transport: "stdio", command: "deno", args: ["a"], env: {} }))).toBe(true);
    // A relative command or argument resolves against cwd, so a new cwd can mean another program.
    expect(mcpTargetChanged(stdio, parseMcpConfig({ transport: "stdio", command: "node", args: ["a"], cwd: "/srv/other", env: {} }))).toBe(true);
    const http = parseMcpConfig({ transport: "http", url: "https://a.example/mcp", headers: {} });
    expect(mcpTargetChanged(stdio, http)).toBe(true);
    expect(mcpTargetChanged(http, parseMcpConfig({ transport: "http", url: "https://b.example/mcp", headers: {} }))).toBe(true);
  });
});
