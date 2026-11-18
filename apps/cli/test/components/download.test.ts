import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { bypassesProxy, downloadOnce, downloadWithRetry, proxyFor, sourceUrl, sourceUrls } from "../../src/components/download.js";
import { ComponentInstallError } from "../../src/components/types.js";
import { fakeComponent, sha256 } from "./fixtures.js";

let root: string;
const servers: Server[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nema-download-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(root, { recursive: true, force: true });
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("mirrors", () => {
  const { target } = fakeComponent("/dev/null");

  test("each mirror variable replaces only its own upstream prefix", () => {
    const env = { NEMA_GRAPHIFY_PYTHON_MIRROR: "https://mirror.example/pbs/", NEMA_GRAPHIFY_PYPI_BASE: "https://pypi.example/root" };
    expect(sourceUrl(target.python, "python", env)).toBe(`https://mirror.example/pbs/20261026/${target.python.file.replace("+", "%2B")}`);
    expect(sourceUrl(target.wheels[0]!, "wheel", env)).toBe(`https://pypi.example/root/packages/aa/bb/${target.wheels[0]!.file}`);
    expect(sourceUrl(target.python, "python", {})).toBe(target.python.url);
    expect(sourceUrls(target, { NEMA_GRAPHIFY_PYPI_BASE: "https://pypi.example" })[0]).toBe(target.python.url);
  });

  test("a mirror that is not http(s) is refused", () => {
    expect(() => sourceUrl(target.python, "python", { NEMA_GRAPHIFY_PYTHON_MIRROR: "file:///tmp" })).toThrow(ComponentInstallError);
  });
});

describe("proxy selection", () => {
  test("HTTPS_PROXY for https, HTTP_PROXY for http, NO_PROXY wins", () => {
    const env = { HTTPS_PROXY: "http://secure-proxy:3128", HTTP_PROXY: "plain-proxy:8080", NO_PROXY: "internal.example,.corp.example,10.0.0.1:8443" };
    expect(proxyFor(new URL("https://files.pythonhosted.org/x"), env)?.host).toBe("secure-proxy:3128");
    expect(proxyFor(new URL("http://files.pythonhosted.org/x"), env)?.host).toBe("plain-proxy:8080");
    expect(proxyFor(new URL("https://internal.example/x"), env)).toBeNull();
    expect(proxyFor(new URL("https://a.corp.example/x"), env)).toBeNull();
    expect(proxyFor(new URL("https://10.0.0.1:8443/x"), env)).toBeNull();
    expect(proxyFor(new URL("https://10.0.0.1/x"), env)?.host).toBe("secure-proxy:3128");
    expect(proxyFor(new URL("https://github.com/x"), {})).toBeNull();
    expect(bypassesProxy(new URL("https://anything.example"), { no_proxy: "*" })).toBe(true);
    expect(bypassesProxy(new URL("http://[::1]:9000/x"), { NO_PROXY: "[::1]:9000" })).toBe(true);
    expect(bypassesProxy(new URL("http://[::1]:9000/x"), { NO_PROXY: "::1" })).toBe(true);
  });
});

describe("downloads", () => {
  test("an http download goes through HTTP_PROXY in absolute form", async () => {
    const seen: string[] = [];
    const proxy = await listen(createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200).end("via proxy");
    }));
    const dest = path.join(root, "a.bin");
    const got = await downloadOnce("http://upstream.invalid/pkg/a.bin", dest, { env: { HTTP_PROXY: `http://${proxy}` } });
    expect(seen).toEqual(["GET http://upstream.invalid/pkg/a.bin"]);
    expect(readFileSync(dest, "utf8")).toBe("via proxy");
    expect(got).toEqual({ sha256: sha256("via proxy"), size: "via proxy".length });
  });

  test("an https download asks HTTPS_PROXY for a CONNECT tunnel and reports a refusal as a proxy failure", async () => {
    const tunnels: string[] = [];
    const server = createServer((_req, res) => res.writeHead(500).end());
    server.on("connect", (req, socket: Socket) => {
      tunnels.push(req.url ?? "");
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    const proxy = await listen(server);
    const error = await downloadOnce("https://files.pythonhosted.org/packages/aa/bb/x.whl", path.join(root, "x.whl"), { env: { HTTPS_PROXY: `http://${proxy}` } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComponentInstallError);
    expect((error as ComponentInstallError).reason).toBe("proxy");
    expect(tunnels).toEqual(["files.pythonhosted.org:443"]);
  });

  test("an unreachable proxy is a proxy failure, and NO_PROXY goes direct", async () => {
    const dead = await listen(createServer(() => undefined));
    servers.at(-1)!.close();
    const origin = await listen(createServer((_req, res) => res.writeHead(200).end("direct")));
    const viaDead = await downloadOnce(`http://${origin}/a`, path.join(root, "a"), { env: { HTTP_PROXY: `http://${dead}` } }).catch((e: unknown) => e);
    expect((viaDead as ComponentInstallError).reason).toBe("proxy");
    const direct = await downloadOnce(`http://${origin}/b`, path.join(root, "b"), { env: { HTTP_PROXY: `http://${dead}`, NO_PROXY: "127.0.0.1" } });
    expect(direct.size).toBe("direct".length);
  });

  test("redirects are followed and an oversized body stops early as a hash mismatch", async () => {
    const origin = await listen(createServer((req, res) => {
      if (req.url === "/moved") res.writeHead(302, { location: "/real" }).end();
      else res.writeHead(200).end("0123456789");
    }));
    expect((await downloadOnce(`http://${origin}/moved`, path.join(root, "r"), { env: {} })).size).toBe(10);
    const error = await downloadOnce(`http://${origin}/real`, path.join(root, "big"), { env: {}, maxBytes: 4 }).catch((e: unknown) => e);
    expect((error as ComponentInstallError).reason).toBe("hash-mismatch");
    expect(() => readFileSync(path.join(root, "big"))).toThrow();
  });

  test("a silent server hits the idle timeout", async () => {
    const origin = await listen(createServer((_req, res) => {
      res.writeHead(200);
      res.write("partial");
    }));
    const error = await downloadOnce(`http://${origin}/slow`, path.join(root, "slow"), { env: {}, timeoutMs: 200 }).catch((e: unknown) => e);
    expect((error as ComponentInstallError).reason).toBe("network");
    expect(() => readFileSync(path.join(root, "slow"))).toThrow();
  });

  test("network failures retry with the backoff, at most three times; a 404 does not retry", async () => {
    let calls = 0;
    const origin = await listen(createServer((req, res) => {
      calls++;
      if (req.url === "/missing") res.writeHead(404).end();
      else if (calls <= 2) res.writeHead(503).end();
      else res.writeHead(200).end("ok");
    }));
    const slept: number[] = [];
    const sleep = async (ms: number) => { slept.push(ms); };
    expect((await downloadWithRetry(`http://${origin}/flaky`, path.join(root, "f"), { env: {}, sleep })).size).toBe(2);
    expect(slept).toEqual([1_000, 2_000]);

    calls = -100;
    slept.length = 0;
    const exhausted = await downloadWithRetry(`http://${origin}/always`, path.join(root, "g"), { env: {}, sleep }).catch((e: unknown) => e);
    expect((exhausted as ComponentInstallError).reason).toBe("network");
    expect(slept).toEqual([1_000, 2_000, 4_000]);

    slept.length = 0;
    const missing = await downloadWithRetry(`http://${origin}/missing`, path.join(root, "m"), { env: {}, sleep }).catch((e: unknown) => e);
    expect((missing as ComponentInstallError).message).toMatch(/404/);
    expect(slept).toEqual([]);
  });

  test("a cancel stops the download and is not retried", async () => {
    const origin = await listen(createServer((_req, res) => {
      res.writeHead(200);
      res.write("first bytes");
    }));
    const controller = new AbortController();
    const pending = downloadWithRetry(`http://${origin}/x`, path.join(root, "x"), { env: {}, signal: controller.signal, onBytes: () => controller.abort(), sleep: async () => { throw new Error("must not retry"); } });
    const error = await pending.catch((e: unknown) => e);
    expect((error as Error).name).toBe("AbortError");
    expect(() => readFileSync(path.join(root, "x"))).toThrow();
  });
});
