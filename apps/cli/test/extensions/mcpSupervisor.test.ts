import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseMcpConfig, type McpConfig } from "@nema/shared";
import { McpSupervisor, type McpStatus } from "../../src/extensions/mcp/supervisor.js";
// @ts-expect-error plain JavaScript fixture
import { startHttpFake } from "../fixtures/fake-mcp-server.mjs";

const MARK = "nema-test-secret-7f3a";
const FIXTURE = fileURLToPath(new URL("../fixtures/fake-mcp-server.mjs", import.meta.url));
const posix = process.platform !== "win32";

let home: string;
let configs: Map<string, McpConfig>;
let secretValues: Map<string, string>;
let supervisor: McpSupervisor | undefined;
const servers: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nema-mcp-sup-"));
  configs = new Map();
  secretValues = new Map();
  process.env.NEMA_TEST_LEAK = "leak";
  process.env.NEMA_TEST_FORWARD = "forwarded";
});
afterEach(async () => {
  await supervisor?.closeAll();
  supervisor = undefined;
  for (const server of servers.splice(0)) await server.close();
  delete process.env.NEMA_TEST_LEAK;
  delete process.env.NEMA_TEST_FORWARD;
  rmSync(home, { recursive: true, force: true });
});

function make(options: { timeoutMs?: number; platform?: NodeJS.Platform } = {}): McpSupervisor {
  supervisor = new McpSupervisor({
    nemaHome: home,
    configs: { config: (id) => { const c = configs.get(id); if (!c) throw new Error(`MCP server not found: ${id}`); return c; } },
    secrets: { resolve: (id, name) => { const v = secretValues.get(`${id}/${name}`); if (v === undefined) throw new Error(`MCP secret ${name} is not set for ${id}`); return v; } },
    timeoutMs: options.timeoutMs ?? 10_000,
    platform: options.platform,
  });
  return supervisor;
}

function stdio(id: string, env: Record<string, unknown> = {}): { record: string; starts: string } {
  const record = join(home, `${id}.record.json`);
  const starts = join(home, `${id}.starts`);
  configs.set(id, parseMcpConfig({
    transport: "stdio",
    command: "node",
    args: [FIXTURE],
    env: { FAKE_RECORD: { value: record }, FAKE_STARTS: { value: starts }, ...env },
  }));
  return { record, starts };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function until(check: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

const recorded = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { keys: string[]; env: Record<string, string>; pid: number };
const startCount = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);
const clean = (status: McpStatus) => expect(JSON.stringify(status)).not.toContain(MARK);

describe.skipIf(!posix)("stdio (POSIX, no owned-helper scope)", () => {
  test("starts a bare `node` command, lists tools with stable digests, reports serverInfo", async () => {
    stdio("search");
    const sup = make();
    const status = await sup.start("search");
    expect(status).toMatchObject({ id: "search", connection: "connected", server: { name: "fake-mcp", version: "1.2.3" }, lastError: null });
    expect(status.tools.map((tool) => tool.name)).toEqual(["tool_1", "tool_2"]);
    expect(status.tools[0]!.schemaDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(sup.status("search")).toEqual(status);
    await sup.stop("search");
    expect(sup.status("search").connection).toBe("disconnected");
    const again = await sup.start("search");
    expect(again.tools).toEqual(status.tools);
  });

  test("the child sees exactly the configured environment plus PATH and HOME", async () => {
    const { record } = stdio("search", { API_TOKEN: { secret: "API_TOKEN" }, FORWARD: { env: "NEMA_TEST_FORWARD" }, LOG_LEVEL: { value: "info" } });
    secretValues.set("search/API_TOKEN", MARK);
    const status = await make().start("search");
    expect(status.connection).toBe("connected");
    clean(status);
    const seen = recorded(record);
    expect(seen.keys).toEqual(["API_TOKEN", "FAKE_RECORD", "FAKE_STARTS", "FORWARD", "HOME", "LOG_LEVEL", "PATH"]);
    expect(seen.env.API_TOKEN).toBe(MARK);
    expect(seen.env.FORWARD).toBe("forwarded");
    expect(seen.env.PATH).toBe(process.env.PATH);
    expect(seen.env.HOME).toBe(join(home, "run", "mcp", "search", "home"));
    expect(seen.keys).not.toContain("NEMA_TEST_LEAK");
  });

  test("a missing secret or env reference fails before anything starts, naming only the slot", async () => {
    const { starts } = stdio("search", { API_TOKEN: { secret: "API_TOKEN" } });
    const sup = make();
    const status = await sup.start("search");
    expect(status).toMatchObject({ connection: "error" });
    expect(status.lastError).toMatch(/API_TOKEN/);
    stdio("other", { FORWARD: { env: "NEMA_TEST_UNSET_VAR" } });
    expect((await sup.start("other")).lastError).toMatch(/NEMA_TEST_UNSET_VAR/);
    expect(startCount(starts)).toBe(0);
  });

  test("a start that times out ends as an error and leaves no process or grandchild", async () => {
    const grandchild = join(home, "grandchild.pid");
    const { record } = stdio("slow", { FAKE_HANG: { value: "1" }, FAKE_GRANDCHILD: { value: grandchild } });
    const status = await make({ timeoutMs: 800 }).start("slow");
    expect(status).toMatchObject({ connection: "error" });
    expect(status.lastError).toMatch(/did not answer/);
    const pid = recorded(record).pid;
    const grand = Number(readFileSync(grandchild, "utf8"));
    expect(await until(() => !alive(pid) && !alive(grand))).toBe(true);
  });

  test("stop and closeAll leave no process or grandchild", async () => {
    const g1 = join(home, "g1.pid");
    const g2 = join(home, "g2.pid");
    const a = stdio("one", { FAKE_GRANDCHILD: { value: g1 } });
    const b = stdio("two", { FAKE_GRANDCHILD: { value: g2 } });
    const sup = make();
    await sup.start("one");
    await sup.start("two");
    const pids = [recorded(a.record).pid, Number(readFileSync(g1, "utf8")), recorded(b.record).pid, Number(readFileSync(g2, "utf8"))];
    expect(pids.every(alive)).toBe(true);
    await sup.stop("one");
    expect(await until(() => !alive(pids[0]!) && !alive(pids[1]!))).toBe(true);
    expect(alive(pids[2]!)).toBe(true);
    await sup.closeAll();
    expect(await until(() => !alive(pids[2]!) && !alive(pids[3]!))).toBe(true);
    expect((await sup.start("one")).lastError).toMatch(/shutting down/);
  });

  test("two starts in a row spawn one process", async () => {
    const { starts } = stdio("search");
    const sup = make();
    const [first, second] = await Promise.all([sup.start("search"), sup.start("search")]);
    expect(first.connection).toBe("connected");
    expect(second).toEqual(first);
    expect(await sup.start("search")).toEqual(first);
    expect(startCount(starts)).toBe(1);
  });

  test("stop during a start ends the start and leaves no process", async () => {
    const { record } = stdio("slow", { FAKE_HANG: { value: "1" } });
    const sup = make({ timeoutMs: 20_000 });
    const starting = sup.start("slow");
    expect(await until(() => existsSync(record))).toBe(true);
    const began = Date.now();
    await sup.stop("slow");
    const status = await starting;
    expect(Date.now() - began).toBeLessThan(5000);
    expect(status.connection).toBe("disconnected");
    expect(await until(() => !alive(recorded(record).pid))).toBe(true);
  });

  test("closeAll during a start waits for it and leaves no process", async () => {
    const { record } = stdio("slow", { FAKE_HANG: { value: "1" } });
    const sup = make({ timeoutMs: 20_000 });
    const starting = sup.start("slow");
    expect(await until(() => existsSync(record))).toBe(true);
    await sup.closeAll();
    expect((await starting).connection).not.toBe("connected");
    expect(alive(recorded(record).pid)).toBe(false);
  });

  test("restart hands the server the new secret and stops the old process", async () => {
    const { record } = stdio("search", { API_TOKEN: { secret: "API_TOKEN" } });
    secretValues.set("search/API_TOKEN", "old-value");
    const sup = make();
    await sup.start("search");
    const before = recorded(record);
    secretValues.set("search/API_TOKEN", MARK);
    const status = await sup.restart("search");
    expect(status.connection).toBe("connected");
    const after = recorded(record);
    expect(after.env.API_TOKEN).toBe(MARK);
    expect(after.pid).not.toBe(before.pid);
    expect(await until(() => !alive(before.pid))).toBe(true);
    // restart of a stopped server does not start it.
    await sup.stop("search");
    expect((await sup.restart("search")).connection).toBe("disconnected");
  });

  test("restart during a start starts again with the new values", async () => {
    const { record } = stdio("slow", { API_TOKEN: { secret: "API_TOKEN" }, FAKE_HANG: { value: "1" } });
    secretValues.set("slow/API_TOKEN", "old-value");
    const sup = make({ timeoutMs: 20_000 });
    const starting = sup.start("slow");
    expect(await until(() => existsSync(record))).toBe(true);
    const firstPid = recorded(record).pid;
    stdio("slow", { API_TOKEN: { secret: "API_TOKEN" } });
    secretValues.set("slow/API_TOKEN", MARK);
    const status = await sup.restart("slow");
    await starting;
    expect(status.connection).toBe("connected");
    expect(recorded(record).env.API_TOKEN).toBe(MARK);
    expect(await until(() => !alive(firstPid))).toBe(true);
  });

  test("a relative cwd is refused", async () => {
    const { starts } = stdio("search");
    configs.set("search", { ...(configs.get("search") as Extract<McpConfig, { transport: "stdio" }>), cwd: "relative/dir" });
    const status = await make().start("search");
    expect(status.lastError).toMatch(/absolute/);
    expect(startCount(starts)).toBe(0);
  });

  test("a server that exits on its own is reported as an error", async () => {
    const { record } = stdio("search");
    const sup = make();
    await sup.start("search");
    process.kill(recorded(record).pid, "SIGKILL");
    expect(await until(() => sup.status("search").connection === "error")).toBe(true);
    expect(sup.status("search").lastError).toMatch(/exited/);
  });
});

describe("stdio on Windows without an owned-helper scope", () => {
  test("refuses to start and spawns nothing", async () => {
    const { starts } = stdio("search");
    const status = await make({ platform: "win32" }).start("search");
    expect(status.connection).toBe("error");
    expect(status.lastError).toMatch(/Windows/);
    expect(startCount(starts)).toBe(0);
  });
});

describe("HTTP", () => {
  test("connects, sends resolved headers, and lists tools", async () => {
    const fake = await startHttpFake({ tools: 3 });
    servers.push(fake);
    configs.set("web", parseMcpConfig({ transport: "http", url: fake.url, headers: { Authorization: { secret: "AUTH" }, "X-Region": { value: "eu" } } }));
    secretValues.set("web/AUTH", `Bearer ${MARK}`);
    const status = await make().start("web");
    expect(status).toMatchObject({ connection: "connected", server: { name: "fake-mcp", version: "1.2.3" } });
    expect(status.tools).toHaveLength(3);
    clean(status);
    expect(fake.requests[0].headers.authorization).toBe(`Bearer ${MARK}`);
    expect(fake.requests[0].headers["x-region"]).toBe("eu");
  });

  test("401 means needs-login", async () => {
    const fake = await startHttpFake({ status: 401 });
    servers.push(fake);
    configs.set("web", parseMcpConfig({ transport: "http", url: fake.url, headers: { Authorization: { secret: "AUTH" } } }));
    secretValues.set("web/AUTH", MARK);
    const status = await make().start("web");
    expect(status.connection).toBe("needs-login");
    clean(status);
  });

  test("a redirect is not followed", async () => {
    const target = await startHttpFake();
    const fake = await startHttpFake({ status: 302, location: target.url });
    servers.push(target, fake);
    configs.set("web", parseMcpConfig({ transport: "http", url: fake.url, headers: { Authorization: { secret: "AUTH" } } }));
    secretValues.set("web/AUTH", MARK);
    const status = await make().start("web");
    expect(status.connection).toBe("error");
    expect(status.lastError).toMatch(/redirect/);
    clean(status);
    expect(target.requests).toHaveLength(0);
  });

  test("an unreachable address is an error", async () => {
    const fake = await startHttpFake();
    const url = fake.url;
    await fake.close();
    configs.set("web", parseMcpConfig({ transport: "http", url, headers: {} }));
    const status = await make({ timeoutMs: 3000 }).start("web");
    expect(status.connection).toBe("error");
  });
});

test("an unknown id reports an error status without throwing", async () => {
  const status = await make().start("nothing");
  expect(status).toMatchObject({ id: "nothing", connection: "error" });
  expect(make().status("nothing")).toMatchObject({ connection: "disconnected", tools: [], server: null });
});
