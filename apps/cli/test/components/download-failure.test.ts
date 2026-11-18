// Regression test for a write failure that surfaces after the response ends: the download
// must reject and the partial file must be removed, never returned as a success. The write
// side is faked through a node:fs mock (vi.hoisted state), because no real filesystem
// failure can be produced deterministically here.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ failFlush: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realCreateWriteStream = actual.createWriteStream;
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof realCreateWriteStream>) => {
      const stream = realCreateWriteStream(...args);
      if (state.failFlush) {
        const originalEnd = stream.end.bind(stream);
        stream.end = (...endArgs: Parameters<typeof stream.end>) => {
          (originalEnd as (...a: unknown[]) => void)(...endArgs);
          // Fail the flush after the response has ended: the next microtask runs before
          // the stream finishes, so finished() observes the error, not a success.
          queueMicrotask(() =>
            stream.emit("error", Object.assign(new Error("No space left on device"), { code: "ENOSPC" })),
          );
        };
      }
      return stream;
    },
  };
});

import { downloadOnce } from "../../src/components/download.js";

let root: string;
const servers: Server[] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nema-download-failure-"));
  state.failFlush = false;
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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("late write failures", () => {
  test("a write failure after the response ends rejects the download and removes the partial file", async () => {
    const body = Buffer.from("graphify bytes");
    const base = await listen(createServer((_req, res) => res.end(body)));
    state.failFlush = true;
    const dest = path.join(root, "graphify.tar.gz");
    await expect(downloadOnce(`${base}/graphify.tar.gz`, dest, { env: {} })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(() => readFileSync(dest)).toThrow(/ENOENT/);
  });

  test("the same download succeeds when the flush does not fail", async () => {
    const body = Buffer.from("graphify bytes");
    const base = await listen(createServer((_req, res) => res.end(body)));
    const dest = path.join(root, "graphify.tar.gz");
    const result = await downloadOnce(`${base}/graphify.tar.gz`, dest, { env: {} });
    expect(result.size).toBe(body.length);
    expect(readFileSync(dest)).toEqual(body);
  });
});
