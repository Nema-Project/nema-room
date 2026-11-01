import { ChildProcess } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { McpStdioTransport } from "../../src/extensions/mcp/stdioTransport.js";

const posix = process.platform !== "win32";

/** Sent once the fake server's handlers are in place, so a stop never races its setup. */
const READY = "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\\n');";
/** A server that quits when its input closes, as the MCP stdio shutdown expects. */
const EXITS_ON_EOF = `process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); ${READY}`;
/** A server that ignores both the closed input and SIGTERM, so only SIGKILL ends it. */
const IGNORES_EOF = `process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000); ${READY}`;

type Sent = { signal: string; inputEnded: boolean };

/** Starts the fake server and resolves once it reported that its handlers are installed. */
async function started(script: string): Promise<McpStdioTransport> {
  const transport = new McpStdioTransport({ bin: process.execPath, args: ["-e", script], env: {}, cwd: process.cwd() });
  const ready = new Promise<void>((done) => { transport.onmessage = () => done(); });
  await transport.start();
  await ready;
  return transport;
}

function childOf(transport: McpStdioTransport): ChildProcess {
  return (transport as unknown as { child: ChildProcess }).child;
}

/** Every signal the transport sends, with whether the child's input had already been ended by then. */
function recordSignals(child: ChildProcess): Sent[] {
  const sent: Sent[] = [];
  const pid = child.pid!;
  const killChild = ChildProcess.prototype.kill;
  vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, signal?: NodeJS.Signals | number) {
    if (this === child) sent.push({ signal: String(signal ?? "SIGTERM"), inputEnded: child.stdin?.writableEnded === true });
    return killChild.call(this, signal);
  });
  const killProcess = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((target: number, signal?: string | number) => {
    if (target === -pid || target === pid) sent.push({ signal: String(signal ?? "SIGTERM"), inputEnded: child.stdin?.writableEnded === true });
    return killProcess(target, signal);
  });
  return sent;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("a server that exits when its input closes is never sent SIGTERM or SIGKILL", async () => {
  const transport = await started(EXITS_ON_EOF);
  const child = childOf(transport);
  const sent = recordSignals(child);
  await transport.close();
  expect(child.exitCode).toBe(0);
  expect(child.signalCode).toBeNull();
  // After the leader is gone, POSIX still sweeps its process group with SIGKILL; nothing reached the server itself.
  expect(sent.filter((s) => s.signal === "SIGTERM")).toEqual([]);
  expect(child.stdin?.writableEnded).toBe(true);
});

test("a server that ignores its closed input is sent SIGTERM only after the input closed, then SIGKILL", async () => {
  const transport = await started(IGNORES_EOF);
  const child = childOf(transport);
  const sent = recordSignals(child);
  const began = Date.now();
  await transport.close();
  const took = Date.now() - began;
  expect(sent[0]).toEqual({ signal: "SIGTERM", inputEnded: true });
  if (posix) {
    // The server ignores SIGTERM: SIGKILL follows, and the whole stop stays within the former 2s grace.
    expect(sent.map((s) => s.signal).slice(0, 2)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.signalCode).toBe("SIGKILL");
  } else {
    expect(child.signalCode).not.toBeNull();
  }
  expect(took).toBeLessThan(4000);
}, 10_000);
