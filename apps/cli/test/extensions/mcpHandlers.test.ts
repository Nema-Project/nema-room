import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { registerExtensionHandlers } from "../../src/extensions/handlers.js";
import { createMcpHandlers } from "../../src/extensions/mcpHandlers.js";
import { openExtensionStore } from "../../src/extensions/store.js";
import { openMcpSecretStore } from "../../src/secrets/mcp.js";

const MARK = "nema-test-secret-7f3a";
const FIXTURE = fileURLToPath(new URL("../fixtures/fake-mcp-server.mjs", import.meta.url));
const posix = process.platform !== "win32";

let home: string;
let router: RpcRouter;
let handlers: { close(): Promise<void> };
let seq = 0;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nema-mcp-rpc-"));
  router = new RpcRouter();
  handlers = registerExtensionHandlers(router, home, { mcpTimeoutMs: 10_000 });
});
afterEach(async () => {
  await handlers.close();
  rmSync(home, { recursive: true, force: true });
});

async function call(method: string, params: unknown): Promise<{ ok: boolean; result?: unknown; error?: string; raw: string }> {
  const response = await router.handle({ type: "rpc.request", id: String(++seq), method, params });
  const raw = JSON.stringify(response);
  expect(raw).not.toContain(MARK);
  return response.ok ? { ok: true, result: response.result, raw } : { ok: false, error: response.error, raw };
}

async function ok(method: string, params: unknown): Promise<any> {
  const response = await call(method, params);
  if (!response.ok) throw new Error(`${method} failed: ${response.error}`);
  return response.result;
}

const record = (name: string) => join(home, `${name}.json`);
function stdio(extra: Record<string, unknown> = {}) {
  return {
    transport: "stdio",
    command: "node",
    args: [FIXTURE],
    env: { API_TOKEN: { secret: "API_TOKEN" }, FAKE_RECORD: { value: record("child") }, ...extra },
  };
}

async function list(): Promise<any[]> {
  return ok("extensions.list", {});
}

describe("extensions.mcp.* configs and credentials", () => {
  test("save, get and list never carry a value; list shows the MCP state", async () => {
    const saved = await ok("extensions.mcp.save", { id: "search", name: "Search", config: stdio() });
    expect(saved).toMatchObject({ id: "search", kind: "mcp", source: "mcp:stdio" });
    await ok("extensions.mcp.setSecret", { id: "search", name: "API_TOKEN", value: MARK });
    const got = await ok("extensions.mcp.get", { id: "search" });
    expect(got).toMatchObject({ id: "search", name: "Search", secrets: [{ name: "API_TOKEN", configured: true }] });
    expect(got.config.env.API_TOKEN).toEqual({ secret: "API_TOKEN" });
    const row = (await list()).find((item) => item.id === "search");
    expect(row.mcp).toEqual({ transport: "stdio", connection: "disconnected", server: null, tools: [], secrets: [{ name: "API_TOKEN", configured: true }], lastError: null });
  });

  test("clearSecret empties the slot", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: stdio() });
    await ok("extensions.mcp.setSecret", { id: "search", name: "API_TOKEN", value: MARK });
    const cleared = await ok("extensions.mcp.clearSecret", { id: "search", name: "API_TOKEN" });
    expect(cleared).toMatchObject({ id: "search", name: "API_TOKEN", configured: false });
  });

  test("bad params are refused and write nothing", async () => {
    for (const [method, params] of [
      ["extensions.mcp.save", { id: "search", name: "Search" }],
      ["extensions.mcp.save", { id: "search", name: "Search", config: { ...stdio(), env: { API_TOKEN: { value: MARK } } } }],
      ["extensions.mcp.setSecret", { id: "search", name: "API_TOKEN" }],
      ["extensions.mcp.setSecret", { id: "search", name: "API_TOKEN", value: 7 }],
      ["extensions.mcp.get", {}],
      ["extensions.mcp.start", { id: "search", command: "evil" }],
      ["extensions.mcp.start", { id: "search", url: "https://evil.example/mcp" }],
    ] as const) {
      expect((await call(method, params)).ok).toBe(false);
    }
    expect(existsSync(join(home, "extensions", "index.json"))).toBe(false);
  });

  test("a secret the config does not reference is refused", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: stdio() });
    const response = await call("extensions.mcp.setSecret", { id: "search", name: "OTHER", value: MARK });
    expect(response.error).toMatch(/not referenced/);
  });

  test("a create-only save refuses an id that already exists, even when two race", async () => {
    const [first, second] = await Promise.all([
      call("extensions.mcp.save", { id: "search", name: "One", config: stdio(), create: true }),
      call("extensions.mcp.save", { id: "search", name: "Two", config: { ...stdio(), command: "other" }, create: true }),
    ]);
    expect(first.ok).toBe(true);
    expect(second.error).toBe("MCP server search already exists");
    expect((await ok("extensions.mcp.get", { id: "search" })).name).toBe("One");
    expect((await call("extensions.mcp.save", { id: "search", name: "One", config: stdio(), create: "yes" })).error).toMatch(/create/);
  });

  test("an edit save (create: false) never brings back a server that was removed", async () => {
    expect((await call("extensions.mcp.save", { id: "search", name: "Search", config: stdio(), create: false })).error).toBe("MCP server not found: search");
    expect((await list()).some((item) => item.id === "search")).toBe(false);
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: stdio() });
    expect((await ok("extensions.mcp.save", { id: "search", name: "Renamed", config: stdio(), create: false })).name).toBe("Renamed");
  });

  test("status and stop refuse an id that is not a managed MCP server", async () => {
    expect((await call("extensions.mcp.status", { id: "nothing" })).error).toBe("MCP server not found: nothing");
    expect((await call("extensions.mcp.stop", { id: "nothing" })).error).toBe("MCP server not found: nothing");
    expect((await call("extensions.mcp.status", { id: "code" })).error).toBe("code is not an MCP server");
  });

  test("save refuses an id held by a skill", async () => {
    openExtensionStore(join(home, "extensions")).putManaged({
      id: "notes", kind: "skill", name: "notes", summary: "", source: "nema install", revision: "abc", provision: "managed",
      installState: "installed", useState: "enabled", availability: "ready", externalPath: null, error: null,
    });
    expect((await call("extensions.mcp.save", { id: "notes", name: "N", config: stdio() })).error).toMatch(/not an MCP server/);
    expect((await call("extensions.mcp.start", { id: "notes" })).error).toMatch(/not an MCP server/);
  });
});

describe("start-up reconciliation", () => {
  test("a record whose mcp.json is gone is damaged, and orphan secrets are dropped", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: stdio() });
    await handlers.close();
    rmSync(join(home, "extensions", "extensions", "search", "mcp.json"));
    openMcpSecretStore(home).set("orphan", "API_TOKEN", MARK);
    router = new RpcRouter();
    handlers = registerExtensionHandlers(router, home, { mcpTimeoutMs: 10_000 });
    const row = (await list()).find((item) => item.id === "search");
    expect(row.availability).toBe("damaged");
    expect(openMcpSecretStore(home).ids()).toEqual([]);
    expect((await call("extensions.mcp.start", { id: "search" })).error).toMatch(/damaged/);
  });
});

describe.skipIf(!posix)("start, stop and the operations around them", () => {
  const childPid = () => (JSON.parse(readFileSync(record("child"), "utf8")) as { pid: number }).pid;
  const childEnv = () => (JSON.parse(readFileSync(record("child"), "utf8")) as { env: Record<string, string> }).env;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  async function until(check: () => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end && !check()) await new Promise((r) => setTimeout(r, 25));
    return check();
  }

  test("start, status and stop; list reflects the connection", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: stdio() });
    await ok("extensions.mcp.setSecret", { id: "search", name: "API_TOKEN", value: MARK });
    const started = await ok("extensions.mcp.start", { id: "search" });
    expect(started).toMatchObject({ id: "search", connection: "connected", server: { name: "fake-mcp" } });
    expect(childEnv().API_TOKEN).toBe(MARK);
    expect((await ok("extensions.mcp.status", { id: "search" })).connection).toBe("connected");
    expect((await list()).find((item) => item.id === "search").mcp.connection).toBe("connected");
    const pid = childPid();
    await ok("extensions.mcp.stop", { id: "search" });
    expect(await until(() => !alive(pid))).toBe(true);
    expect((await ok("extensions.mcp.status", { id: "search" })).connection).toBe("disconnected");
  });

  test("a disabled server cannot start, and disabling a running one stops it", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: { ...stdio(), env: { FAKE_RECORD: { value: record("child") } } } });
    await ok("extensions.mcp.start", { id: "search" });
    const pid = childPid();
    await ok("extensions.setUse", { id: "search", useState: "disabled" });
    expect(await until(() => !alive(pid))).toBe(true);
    expect((await call("extensions.mcp.start", { id: "search" })).error).toMatch(/disabled/);
  });

  test("a start sent while the server is being disabled never leaves a disabled server running", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: { ...stdio(), env: { FAKE_RECORD: { value: record("child") } } } });
    await ok("extensions.mcp.start", { id: "search" });
    const disabling = call("extensions.setUse", { id: "search", useState: "disabled" });
    const starts: Array<Promise<unknown>> = [];
    let done = false;
    void disabling.finally(() => { done = true; });
    // Starts at every turn until the disable has answered, so one lands between its stop and its write.
    while (!done) {
      starts.push(call("extensions.mcp.start", { id: "search" }));
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    }
    starts.push(call("extensions.mcp.start", { id: "search" }));
    expect((await disabling).ok).toBe(true);
    await Promise.all(starts);
    const row = (await list()).find((item) => item.id === "search");
    expect(row.useState).toBe("disabled");
    expect(row.mcp.connection).toBe("disconnected");
  });

  test("disable writes on the server's chain: a start queued while it runs reads the new state", async () => {
    const own = mkdtempSync(join(tmpdir(), "nema-mcp-disable-"));
    const mcp = createMcpHandlers(own);
    const own_router = new RpcRouter();
    const store = openExtensionStore(join(own, "extensions"));
    mcp.register(own_router, (id) => store.list().find((row) => row.id === id));
    try {
      const rpc = async (method: string, params: unknown) => own_router.handle({ type: "rpc.request", id: String(++seq), method, params });
      expect((await rpc("extensions.mcp.save", { id: "search", name: "Search", config: { ...stdio(), env: { FAKE_RECORD: { value: record("child") } } } })).ok).toBe(true);
      expect((await rpc("extensions.mcp.start", { id: "search" })).ok).toBe(true);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let start: Promise<any> | null = null;
      const disabling = mcp.disable("search", async () => {
        // The write is slow; a start arriving now must wait for it.
        start = rpc("extensions.mcp.start", { id: "search" });
        await gate;
        store.setUseState("search", "disabled");
      });
      await new Promise((r) => setTimeout(r, 50));
      release();
      await disabling;
      const answer = await start!;
      expect(answer.ok).toBe(false);
      expect(answer.error).toMatch(/disabled/);
      expect(mcp.state(store.list().find((row) => row.id === "search")!).connection).toBe("disconnected");
    } finally {
      await mcp.close();
      rmSync(own, { recursive: true, force: true });
    }
  });

  test("a stop also cancels a start still queued behind another operation", async () => {
    const starts = join(home, "starts.log");
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: { ...stdio(), env: { FAKE_HANG: { value: "1" }, FAKE_STARTS: { value: starts } } } });
    const first = call("extensions.mcp.start", { id: "search" });
    const second = call("extensions.mcp.start", { id: "search" });
    expect(await until(() => existsSync(starts))).toBe(true);
    await ok("extensions.mcp.stop", { id: "search" });
    const [a, b] = await Promise.all([first, second]);
    expect(b.ok ? (b.result as any).connection : b.error).not.toBe("connecting");
    expect(a.ok ? (a.result as any).connection : "refused").not.toBe("connected");
    expect(readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(1);
    expect((await ok("extensions.mcp.status", { id: "search" })).connection).toBe("disconnected");
  }, 20_000);

  test("a server left running by a daemon that did not shut down is stopped on the next start, with a note", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: { ...stdio(), env: { FAKE_RECORD: { value: record("child") } } } });
    await ok("extensions.mcp.start", { id: "search" });
    const pid = childPid();
    expect(existsSync(join(home, "run", "mcp", "search", "server.json"))).toBe(true);
    // The old daemon is gone without closing; a new one starts on the same home.
    const next = new RpcRouter();
    const again = registerExtensionHandlers(next, home, { mcpTimeoutMs: 10_000 });
    try {
      const rpc = async (method: string, params: unknown) => next.handle({ type: "rpc.request", id: String(++seq), method, params });
      // The first list (the Plugins page loading) already waits for the recovery and carries its note.
      const first: any = await rpc("extensions.list", {});
      const row = first.result.find((item: any) => item.id === "search");
      expect(alive(pid)).toBe(false);
      expect(row.mcp.connection).toBe("disconnected");
      expect(row.mcp.lastError).toMatch(/left running by the previous daemon/);
      expect(existsSync(join(home, "run", "mcp", "search", "server.json"))).toBe(false);
      const restarted: any = await rpc("extensions.mcp.start", { id: "search" });
      expect(restarted.result.connection).toBe("connected");
    } finally {
      await again.close();
    }
  });

  test("when the recovery itself fails, no start runs until it succeeds, and the daemon keeps serving", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: { ...stdio(), env: { FAKE_RECORD: { value: record("child") } } } });
    mkdirSync(join(home, "run"), { recursive: true });
    // Not a directory: the next daemon cannot read its records.
    rmSync(join(home, "run", "mcp"), { recursive: true, force: true });
    writeFileSync(join(home, "run", "mcp"), "");
    const next = new RpcRouter();
    const again = registerExtensionHandlers(next, home, { mcpTimeoutMs: 10_000 });
    try {
      const rpc = async (method: string, params: unknown): Promise<any> => next.handle({ type: "rpc.request", id: String(++seq), method, params });
      const started = await rpc("extensions.mcp.start", { id: "search" });
      expect(started.ok).toBe(false);
      expect(started.error).toMatch(/left running by the previous daemon/);
      expect((await rpc("extensions.list", {})).ok).toBe(true);
    } finally {
      await again.close();
    }
  });

  test("a record that cannot be written fails the start cleanly and leaves no server running", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: { ...stdio(), env: { FAKE_RECORD: { value: record("child") } } } });
    // A directory where the record goes: writing it fails.
    mkdirSync(join(home, "run", "mcp", "search", "server.json"), { recursive: true });
    const started = await call("extensions.mcp.start", { id: "search" });
    expect(started.ok).toBe(true);
    expect((started.result as any).connection).toBe("error");
    expect((started.result as any).lastError).toMatch(/could not record/);
    if (existsSync(record("child"))) {
      const pid = childPid();
      expect(await until(() => !alive(pid))).toBe(true);
    }
  });

  test("a server that exits on its own takes the rest of its process group with it", async () => {
    const grandchild = join(home, "grandchild.pid");
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: { ...stdio(), env: { FAKE_RECORD: { value: record("child") }, FAKE_GRANDCHILD: { value: grandchild } } } });
    await ok("extensions.mcp.start", { id: "search" });
    const pid = childPid();
    const grand = Number(readFileSync(grandchild, "utf8"));
    process.kill(pid, "SIGKILL");
    expect(await until(() => !alive(grand))).toBe(true);
    expect(await until(() => !existsSync(join(home, "run", "mcp", "search", "server.json")))).toBe(true);
  });

  test("remove stops the server and deletes config, secrets and record", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: stdio() });
    await ok("extensions.mcp.setSecret", { id: "search", name: "API_TOKEN", value: MARK });
    await ok("extensions.mcp.start", { id: "search" });
    const pid = childPid();
    expect(await ok("extensions.remove", { id: "search" })).toEqual({ id: "search", removed: "managed" });
    expect(await until(() => !alive(pid))).toBe(true);
    expect(existsSync(join(home, "extensions", "extensions", "search"))).toBe(false);
    expect(existsSync(join(home, "secrets", "mcp", "search"))).toBe(false);
    expect((await list()).some((item) => item.id === "search")).toBe(false);
  });

  test("saving a running server stops it first; a new command clears its secrets", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: stdio() });
    await ok("extensions.mcp.setSecret", { id: "search", name: "API_TOKEN", value: MARK });
    await ok("extensions.mcp.start", { id: "search" });
    const pid = childPid();
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: { ...stdio(), args: [FIXTURE, "--other"] } });
    expect(await until(() => !alive(pid))).toBe(true);
    expect((await ok("extensions.mcp.status", { id: "search" })).connection).toBe("disconnected");
    expect((await ok("extensions.mcp.get", { id: "search" })).secrets).toEqual([{ name: "API_TOKEN", configured: false }]);
  });

  test("setting a secret while running restarts the server with the new value", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: stdio() });
    await ok("extensions.mcp.setSecret", { id: "search", name: "API_TOKEN", value: "old-value" });
    await ok("extensions.mcp.start", { id: "search" });
    const pid = childPid();
    const result = await ok("extensions.mcp.setSecret", { id: "search", name: "API_TOKEN", value: MARK });
    expect(result.status.connection).toBe("connected");
    expect(childEnv().API_TOKEN).toBe(MARK);
    expect(await until(() => !alive(pid))).toBe(true);
  });

  test("close stops every running server", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: stdio() });
    await ok("extensions.mcp.setSecret", { id: "search", name: "API_TOKEN", value: MARK });
    await ok("extensions.mcp.start", { id: "search" });
    const pid = childPid();
    await handlers.close();
    expect(await until(() => !alive(pid))).toBe(true);
    expect((await call("extensions.mcp.start", { id: "search" })).ok).toBe(true);
    expect((await ok("extensions.mcp.status", { id: "search" })).connection).not.toBe("connected");
  });

  test("nothing Nema writes besides the secret files holds the value", async () => {
    await ok("extensions.mcp.save", { id: "search", name: "Search", config: stdio() });
    await ok("extensions.mcp.setSecret", { id: "search", name: "API_TOKEN", value: MARK });
    await ok("extensions.mcp.start", { id: "search" });
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [readFileSync(join(dir, e.name), "utf8")]));
    expect(walk(join(home, "extensions")).join("\n")).not.toContain(MARK);
  });
});
