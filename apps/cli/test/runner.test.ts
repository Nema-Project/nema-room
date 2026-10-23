import { expect, test, vi } from "vitest";
import type { TaskAssign } from "@nema/shared";
import { Runner, resolveAdapterName, type AgentAdapter } from "../src/daemon/runner.js";
import type { NemaConfig } from "../src/config.js";

const cfg = (adapter: NemaConfig["adapter"]): NemaConfig => ({ adapter, reasoningEffort: "medium", authMode: "siwc" });
const task = (adapter: string): TaskAssign => ({ type: "task.assign", taskId: "t", workspaceId: "w", adapter, confidential: true, prompt: "p", runToken: "r", hubUrl: "h", pluginTools: [] });
const done = (r: Runner, t: TaskAssign) => new Promise((res) => r.enqueue(t, () => {}, res));

test("resolveAdapterName", () => {
  expect(resolveAdapterName("auto", cfg("codex-direct"))).toBe("codex-direct");
  expect(resolveAdapterName("codex", cfg("codex-direct"))).toBe("codex-direct");
  expect(resolveAdapterName("codex-cli", cfg("codex-direct"))).toBe("codex-direct");
});

test("runner resolves auto and the retired codex names to codex-direct", async () => {
  const run = vi.fn(async () => ({ ok: true as const, reply: "ok" }));
  const runner = new Runner([{ name: "codex-direct", run }], () => cfg("codex-direct"));
  expect(await done(runner, task("auto"))).toEqual({ ok: true, reply: "ok" });
  expect(await done(runner, task("codex"))).toEqual({ ok: true, reply: "ok" });
  expect(await done(runner, task("codex-cli"))).toEqual({ ok: true, reply: "ok" });
  expect(run).toHaveBeenCalledTimes(3);
});

test("runner reports unavailable resolved adapter without fallback", async () => {
  const run = vi.fn(async () => ({ ok: true as const, reply: "ok" }));
  const runner = new Runner([{ name: "other", run }], () => cfg("codex-direct"));
  const r = (await done(runner, task("auto"))) as { ok: boolean; error: string };
  expect(r.ok).toBe(false);
  expect(r.error).toContain("codex-direct");
  expect(run).not.toHaveBeenCalled();
});

test("runner passes confidential tasks through to the adapter (guard lives in the adapter)", async () => {
  const run = vi.fn(async () => ({ ok: false as const, error: "refused" }));
  const a: AgentAdapter = { name: "codex-direct", run };
  const r = await done(new Runner([a], () => cfg("codex-direct")), task("auto"));
  expect(r).toEqual({ ok: false, error: "refused" });
  expect(run).toHaveBeenCalledTimes(1);
});

test("a Runner without a config getter uses the shared default (codex-direct)", async () => {
  const direct = vi.fn(async () => ({ ok: true as const, reply: "direct" }));
  const cli = vi.fn(async () => ({ ok: true as const, reply: "cli" }));
  const runner = new Runner([{ name: "codex-cli", run: cli }, { name: "codex-direct", run: direct }]);
  expect(await done(runner, task("auto"))).toEqual({ ok: true, reply: "direct" });
  expect(cli).not.toHaveBeenCalled();
});

test("an unreadable config reaches the chat as a Chinese message, not a raw zod/JSON error", async () => {
  const runner = new Runner([{ name: "codex-direct", run: vi.fn() }], () => {
    JSON.parse("{oops");
    return cfg("codex-direct");
  });
  const r = (await done(runner, task("auto"))) as { ok: boolean; error: string };
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/^配置文件 ~\/\.nema\/config\.json 无法读取：/);
});
