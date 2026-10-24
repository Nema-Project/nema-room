import { expect, test, vi } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import type { TaskAssign } from "@nema/shared";
import { Runner, type AgentAdapter } from "../src/daemon/runner.js";

const claudeConstruction = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  gate: undefined as Promise<void> | undefined,
  started: undefined as (() => void) | undefined,
}));
vi.mock("../src/claude/adapter.js", () => ({
  ClaudeCodeAdapter: class {
    readonly name = "claude-code";
    constructor(options: Record<string, unknown>) { claudeConstruction.options = options; }
    async run() {
      claudeConstruction.started?.();
      if (claudeConstruction.gate) await claudeConstruction.gate;
      return { ok: true as const, reply: "" };
    }
  },
}));

const assigned: TaskAssign = {
  type: "task.assign", taskId: "lifecycle", workspaceId: "w", adapter: "auto",
  confidential: true, prompt: "p", runToken: "r", hubUrl: "h", pluginTools: [],
};

test("owner stop waits for adapter teardown and suppresses late events and completion", async () => {
  let started!: () => void;
  const active = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const adapter: AgentAdapter = {
    name: "codex-direct",
    async run(_task, onEvent, signal) {
      started();
      await cleanup;
      onEvent({ type: "progress", text: "too late" });
      return { ok: true, reply: signal?.aborted ? "late" : "done" };
    },
  };
  const runner = new Runner([adapter], () => ({ adapter: "codex-direct", reasoningEffort: "medium", authMode: "siwc" }));
  const events: unknown[] = [];
  const completions: unknown[] = [];
  runner.enqueue(assigned, (event) => events.push(event), (result) => completions.push(result));
  await active;
  const stopping = runner.stop();
  release();
  await stopping;
  expect(events).toEqual([]);
  expect(completions).toEqual([]);
});

test("runner setup forwards packaged CLI entry and exec path to Claude MCP launch", async () => {
  claudeConstruction.options = undefined;
  const { createRunner } = await import("../src/daemon/setup.js");
  const runner = createRunner({
    nemaHome: "synthetic-home", userCodexHome: "synthetic-codex", version: "test",
    cliEntry: "C:/packaged/nema/dist/index.js", execPath: "C:/runtime/node.exe",
    getConfig: () => ({ adapter: "claude-code", reasoningEffort: "medium", authMode: "siwc" }),
  });
  await new Promise<void>((resolve) => runner.enqueue({ ...assigned, adapter: "claude-code" }, () => {}, () => resolve()));
  expect(claudeConstruction.options).toMatchObject({ cliEntry: "C:/packaged/nema/dist/index.js", execPath: "C:/runtime/node.exe" });
  await runner.stop();
});

test("startDaemon close waits for its active runner and socket teardown", async () => {
  const { startDaemon } = await import("../src/daemon/setup.js");
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/daemon" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  let release!: () => void;
  claudeConstruction.gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const active = new Promise<void>((resolve) => { started = resolve; });
  claudeConstruction.started = started;
  const daemon = startDaemon({
    hubUrl: `http://127.0.0.1:${address.port}`, token: "test", nemaHome: "synthetic-home",
    userCodexHome: "synthetic-codex", version: "test",
    getConfig: () => ({ adapter: "claude-code", reasoningEffort: "medium", authMode: "siwc" }),
  });
  try {
    const [socket] = await once(wss, "connection") as [WebSocket];
    await new Promise<void>((resolve) => socket.once("message", () => resolve()));
    socket.send(JSON.stringify({ ...assigned, adapter: "claude-code" }));
    await active;
    const closing = daemon.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
  } finally {
    release();
    await daemon.close();
    claudeConstruction.gate = undefined;
    claudeConstruction.started = undefined;
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
