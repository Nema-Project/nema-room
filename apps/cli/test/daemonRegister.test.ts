import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { daemonCredentialPath, registerDaemon, resolveDaemonToken } from "../src/daemon/register.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function tempHome() {
  const home = await mkdtemp(join(os.tmpdir(), "nema-daemon-register-"));
  homes.push(home);
  return home;
}

test("registers using the supplied code and writes the credential privately", async () => {
  const nemaHome = await tempHome();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "dmn_fixture", credential: "fixture-secret" }, { status: 201 }));
  await registerDaemon({ nemaHome, hubUrl: "http://127.0.0.1:4400", code: "fixture-code", label: "Laptop", fetcher });
  expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:4400/api/daemons/register", expect.objectContaining({
    method: "POST",
    redirect: "error",
    body: JSON.stringify({ code: "fixture-code", label: "Laptop" }),
  }));
  expect(await readFile(daemonCredentialPath(nemaHome), "utf8")).toBe("fixture-secret");
  if (process.platform !== "win32") expect((await stat(daemonCredentialPath(nemaHome))).mode & 0o777).toBe(0o600);
});

test("a bad code returns a readable error without creating a credential file", async () => {
  const nemaHome = await tempHome();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "fixture-code" }, { status: 400 }));
  await expect(registerDaemon({ nemaHome, hubUrl: "http://127.0.0.1:4400", code: "fixture-code", label: "Laptop", fetcher }))
    .rejects.toThrow(/invalid, expired, or already used/i);
  await expect(stat(daemonCredentialPath(nemaHome))).rejects.toMatchObject({ code: "ENOENT" });
});


const cli = vi.hoisted(() => ({
  send: vi.fn<(raw: string) => void>(),
  stopOnSignals: vi.fn<(owner: { close(): Promise<void> }) => void>(),
}));

vi.mock("ws", () => ({
  default: class extends EventEmitter {
    static OPEN = 1;
    readonly OPEN = 1;
    readonly readyState = 1;
    send = cli.send;
    constructor() {
      super();
      queueMicrotask(() => this.emit("open"));
    }
    close() {
      this.emit("close");
    }
  },
}));

vi.mock("../src/daemon/signals.js", () => ({ stopOnSignals: cli.stopOnSignals }));

test("the default daemon action sends the shared token and prefers a registered credential", async () => {
  const home = await tempHome();
  const tokenFile = join(home, "shared-token");
  await writeFile(tokenFile, "local-token\n");
  const hub = "http://127.0.0.1:4400";
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const argv = process.argv;
  const helloToken = async () => {
    vi.resetModules();
    cli.send.mockClear();
    cli.stopOnSignals.mockClear();
    process.argv = [process.execPath, entry, "daemon", "--hub", hub, "--token-file", tokenFile];
    try {
      await import("../src/index.js");
      return JSON.parse(cli.send.mock.calls[0]![0]).token;
    } finally {
      await cli.stopOnSignals.mock.calls[0]?.[0].close();
    }
  };
  try {
    expect(await helloToken()).toBe("local-token");
    const nemaHome = join(home, ".nema");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ credential: "registered-token" }));
    await registerDaemon({ nemaHome, hubUrl: hub, code: "fixture", label: "Laptop", fetcher });
    await rm(tokenFile);
    expect(await helloToken()).toBe("registered-token");
    expect(resolveDaemonToken(nemaHome, { token: "local-token" })).toBe("registered-token");
  } finally {
    process.argv = argv;
    vi.restoreAllMocks();
  }
});

test("the register subcommand reads the code from stdin and uses its own hub and label", async () => {
  const { Readable } = await import("node:stream");
  const home = await tempHome();
  const hub = "https://hub.example.com";
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const argv = process.argv;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ credential: "fixture-secret" }));
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(process, "stdin", "get").mockReturnValue(Readable.from(["fixture-code\n"]) as typeof process.stdin);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = [process.execPath, entry, "daemon", "register", "--hub", hub, "--label", "Build machine"];
  try {
    vi.resetModules();
    await import("../src/index.js");
    expect(fetcher).toHaveBeenCalledWith(`${hub}/api/daemons/register`, expect.objectContaining({
      body: JSON.stringify({ code: "fixture-code", label: "Build machine" }),
    }));
    expect(await readFile(daemonCredentialPath(join(home, ".nema")), "utf8")).toBe("fixture-secret");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/fixture-code|fixture-secret/);
  } finally {
    process.argv = argv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
