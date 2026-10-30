import { expect, test } from "vitest";
import { stopOnSignals } from "../src/daemon/signals.js";

function harness(close: () => Promise<void>, timeoutMs = 1000) {
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  const logs: string[] = [];
  stopOnSignals({ close, on: (signal, handler) => handlers.set(signal, handler), exit: (code) => exits.push(code), log: (line) => logs.push(line), timeoutMs });
  return { handlers, exits, logs };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("SIGINT, SIGTERM and SIGHUP close the daemon (and its MCP servers) before exiting", async () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    let closed = 0;
    const h = harness(async () => { closed += 1; });
    expect([...h.handlers.keys()].sort()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);
    h.handlers.get(signal)!();
    await tick();
    expect(closed).toBe(1);
    expect(h.exits).toEqual([0]);
  }
});

test("a failed close exits non-zero; a second signal does not close twice", async () => {
  let closed = 0;
  const h = harness(async () => { closed += 1; throw new Error("boom"); });
  h.handlers.get("SIGTERM")!();
  await tick();
  expect(h.exits).toEqual([1]);
  expect(h.logs.join("\n")).toMatch(/boom/);
  const twice = harness(async () => { closed += 1; });
  twice.handlers.get("SIGTERM")!();
  twice.handlers.get("SIGTERM")!();
  await tick();
  expect(closed).toBe(2);
  expect(twice.exits).toEqual([130]);
});

test("a close that hangs is cut off after the timeout, and a second signal exits at once", async () => {
  const hung = harness(() => new Promise(() => {}), 50);
  hung.handlers.get("SIGINT")!();
  await tick(120);
  expect(hung.exits).toEqual([1]);
  const twice = harness(() => new Promise(() => {}), 10_000);
  twice.handlers.get("SIGINT")!();
  twice.handlers.get("SIGINT")!();
  expect(twice.exits).toEqual([130]);
});
