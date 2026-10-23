import { expect, test } from "vitest";
import type { TaskAssign } from "@nema/shared";
import { Runner, type AgentAdapter } from "../src/daemon/runner.js";

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
