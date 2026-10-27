import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskAssign } from "@nema/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { configGet, configSet } from "../src/configCommands.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { createRunner } from "../src/daemon/setup.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "nema-cmd-test-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

function out() {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: { log: (s: string) => void lines.push(s), error: (s: string) => void errors.push(s) } };
}

test("config get with no key lists every key; with a key prints just the value", () => {
  const o = out();
  expect(configGet({ nemaHome: home, out: o.out })).toBe(0);
  expect(o.lines.join("\n")).toContain("adapter=codex-direct");
  expect(o.lines.join("\n")).toContain("reasoningEffort=medium");
  expect(o.lines.join("\n")).toContain("authMode=siwc");
  expect(o.lines.some((l) => l.startsWith("model="))).toBe(true);
  const k = out();
  expect(configGet({ nemaHome: home, out: k.out, key: "adapter" })).toBe(0);
  expect(k.lines).toEqual(["codex-direct"]);
});

test("config get rejects an unknown key", () => {
  const o = out();
  expect(configGet({ nemaHome: home, out: o.out, key: "bogus" })).toBe(1);
  expect(o.errors[0]).toContain("bogus");
});

test("config set persists valid values for all four keys", () => {
  const o = out();
  expect(configSet({ nemaHome: home, out: o.out, key: "adapter", value: "codex-cli" })).toBe(1);
  expect(o.errors.join("\n")).toContain("不再启动 Codex CLI");
  expect(configSet({ nemaHome: home, out: o.out, key: "model", value: "gpt-x" })).toBe(0);
  expect(configSet({ nemaHome: home, out: o.out, key: "reasoningEffort", value: "high" })).toBe(0);
  expect(configSet({ nemaHome: home, out: o.out, key: "authMode", value: "compat" })).toBe(0);
  expect(loadConfig(home)).toEqual({ adapter: "codex-direct", model: "gpt-x", reasoningEffort: "high", authMode: "compat" });
});

test("config set accepts claude-code and still rejects codex-cli", () => {
  const o = out();
  expect(configSet({ nemaHome: home, out: o.out, key: "adapter", value: "claude-code" })).toBe(0);
  expect(loadConfig(home).adapter).toBe("claude-code");
  expect(configSet({ nemaHome: home, out: o.out, key: "adapter", value: "codex-cli" })).toBe(1);
});

test("config set accepts BYOK mode and valid base URLs", () => {
  const o = out();
  expect(configSet({ nemaHome: home, out: o.out, key: "authMode", value: "byok" })).toBe(0);
  expect(configSet({ nemaHome: home, out: o.out, key: "byokBaseUrl", value: "http://127.0.0.1:8080/v1" })).toBe(0);
  expect(configSet({ nemaHome: home, out: o.out, key: "byokBaseUrl", value: "http://localhost/v1" })).toBe(0);
  expect(loadConfig(home)).toMatchObject({ authMode: "byok", byokBaseUrl: "http://localhost/v1" });
});

test.each([
  "http://evil.example",
  "http://127.0.0.1.evil.example",
  "https://user:pass@api.example",
  "https://api.example/v1?query=x",
  "https://api.example/v1#fragment",
])("config set rejects invalid BYOK URL %s without changing the file", (value) => {
  const seeded = saveConfig(home, { model: "keep" });
  const before = readFileSync(join(home, "config.json"), "utf8");
  const o = out();
  expect(configSet({ nemaHome: home, out: o.out, key: "byokBaseUrl", value })).toBe(1);
  expect(readFileSync(join(home, "config.json"), "utf8")).toBe(before);
  expect(loadConfig(home)).toEqual(seeded);
});

test("config set rejects unknown keys and invalid values without writing", () => {
  const o = out();
  expect(configSet({ nemaHome: home, out: o.out, key: "bogus", value: "x" })).toBe(1);
  expect(configSet({ nemaHome: home, out: o.out, key: "adapter", value: "claude" })).toBe(1);
  expect(configSet({ nemaHome: home, out: o.out, key: "reasoningEffort", value: "max" })).toBe(1);
  expect(configSet({ nemaHome: home, out: o.out, key: "authMode", value: "x" })).toBe(1);
  expect(configSet({ nemaHome: home, out: o.out, key: "model", value: "" })).toBe(1);
  expect(o.errors.length).toBe(5);
  expect(readdirSync(home)).toEqual([]);
});

test("the daemon's runner registers both adapters, direct first, and defaults to codex-direct", () => {
  const runner = createRunner({ nemaHome: home, userCodexHome: join(home, "codex"), version: "1.2.3", cliEntry: join(home, "index.js") });
  expect(runner.adapterNames).toEqual(["codex-direct", "claude-code"]);
  const t: TaskAssign = { type: "task.assign", taskId: "t", workspaceId: "w", adapter: "auto", confidential: true, prompt: "p", runToken: "r", hubUrl: "http://127.0.0.1:1", pluginTools: [] };
  // no login in the temp home -> the direct adapter answers (and never falls back to codex-cli)
  return new Promise<void>((done) =>
    runner.enqueue(t, () => {}, (r) => {
      expect(r).toEqual({ ok: false, error: "未登录直连 Codex，请在终端运行 nema auth login" });
      done();
    }),
  );
});

test("a corrupt config.json gives a Chinese message for config set and auth login (no stack/zod noise)", async () => {
  writeFileSync(join(home, "config.json"), "{not json");
  const o = out();
  expect(configSet({ nemaHome: home, out: o.out, key: "model", value: "m" })).toBe(1);
  expect(o.errors.join("\n")).toMatch(/^配置文件 ~\/\.nema\/config\.json 无法读取：/);
  const { authLogin } = await import("../src/direct/authCommands.js");
  const o2 = out();
  expect(await authLogin({ nemaHome: home, out: o2.out })).toBe(1);
  expect(o2.errors.join("\n")).toMatch(/^配置文件 ~\/\.nema\/config\.json 无法读取：/);
});
