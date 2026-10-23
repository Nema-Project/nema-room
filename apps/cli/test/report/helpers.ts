import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

export type Received = { path: string; auth: string | undefined; body: unknown };

export type FakeHub = { url: string; received: Received[]; status: number; reply: string; close(): Promise<void> };

/** A fake hub that records each POST and answers with `status` (202 by default). */
export async function fakeHub(): Promise<FakeHub> {
  const hub: FakeHub = { url: "", received: [], status: 202, reply: "{}", close: async () => {} };
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      hub.received.push({ path: req.url ?? "", auth: req.headers.authorization, body: data === "" ? null : JSON.parse(data) });
      res.writeHead(hub.status, { "content-type": "application/json" });
      res.end(hub.status === 204 ? undefined : hub.reply);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  hub.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return hub;
}

/** A URL nothing listens on. */
export async function deadHubUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

export const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), prefix));

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

/** A repo on `main` with one commit. */
export function makeRepo(): string {
  const dir = tmp("nema-report-repo-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

export const stdinOf = (text: string) => Readable.from([Buffer.from(text)]);

export function collectOut() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, out: { log: (s: string) => logs.push(s), error: (s: string) => errors.push(s) } };
}
