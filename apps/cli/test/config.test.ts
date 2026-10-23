import { mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DEFAULT_BYOK_BASE_URL, DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "nema-config-test-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

test("missing file yields defaults (codex-direct is the default adapter)", () => {
  expect(loadConfig(home)).toEqual({ adapter: "codex-direct", reasoningEffort: "medium", authMode: "siwc" });
  expect(loadConfig(home)).not.toHaveProperty("byokBaseUrl");
  expect(DEFAULT_CONFIG).toEqual({ adapter: "codex-direct", reasoningEffort: "medium", authMode: "siwc" });
});
test("the default BYOK base URL targets OpenAI Responses", () => {
  expect(DEFAULT_BYOK_BASE_URL).toBe("https://api.openai.com/v1");
});
test("loadConfig returns a copy of DEFAULT_CONFIG", () => {
  loadConfig(home).reasoningEffort = "high";
  expect(DEFAULT_CONFIG.reasoningEffort).toBe("medium");
});
test("loadConfig accepts BYOK and removes one trailing slash from its base URL", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ authMode: "byok", byokBaseUrl: "https://api.example/v1/" }));
  expect(loadConfig(home)).toEqual({
    adapter: "codex-direct",
    reasoningEffort: "medium",
    authMode: "byok",
    byokBaseUrl: "https://api.example/v1",
  });
});
test.each([
  "https://api.example/v1?",
  "https://api.example/v1#",
  " https://api.example/v1",
  "https://api.example/v1 ",
])("loadConfig rejects malformed BYOK URL %j", (byokBaseUrl) => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ byokBaseUrl }));
  expect(() => loadConfig(home)).toThrow("byokBaseUrl 只允许 https，或 http://127.0.0.1 与 http://localhost（可带端口）");
});
test.each(["http://127.0.0.1:8080/v1", "http://localhost/v1"])("saveConfig accepts local HTTP BYOK URL %s", (byokBaseUrl) => {
  expect(saveConfig(home, { byokBaseUrl }).byokBaseUrl).toBe(byokBaseUrl);
});
test("loadConfig rejects non-local HTTP BYOK URLs", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ byokBaseUrl: "http://evil.example" }));
  expect(() => loadConfig(home)).toThrow("byokBaseUrl 只允许 https，或 http://127.0.0.1 与 http://localhost（可带端口）");
});
test("loadConfig accepts the claude-code adapter", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ adapter: "claude-code" }));
  expect(loadConfig(home).adapter).toBe("claude-code");
});
test("a stored codex adapter loads as direct mode using the Codex login file", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ adapter: "codex" }));
  expect(loadConfig(home)).toMatchObject({ adapter: "codex-direct", authMode: "compat" });
});
test("a stored codex-cli adapter loads as direct mode using the Codex login file", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ adapter: "codex-cli", authMode: "byok", model: "m1" }));
  expect(loadConfig(home)).toEqual({ adapter: "codex-direct", model: "m1", reasoningEffort: "medium", authMode: "compat" });
});
test("saveConfig merges, persists with 0600, leaves no temp files", () => {
  const c = saveConfig(home, { model: "m1" });
  expect(c).toEqual({ adapter: "codex-direct", model: "m1", reasoningEffort: "medium", authMode: "siwc" });
  expect(loadConfig(home)).toEqual(c);
  expect(statSync(join(home, "config.json")).mode & 0o777).toBe(0o600);
  expect(readdirSync(home)).toEqual(["config.json"]);
});
test("saveConfig rejects unknown keys and invalid values", () => {
  expect(() => saveConfig(home, { bogus: 1 } as never)).toThrow();
  expect(() => saveConfig(home, { adapter: "x" } as never)).toThrow();
  expect(readdirSync(home)).toEqual([]);
});
test("loadConfig rejects a corrupt file instead of silently defaulting", () => {
  writeFileSync(join(home, "config.json"), "{not json");
  expect(() => loadConfig(home)).toThrow();
});
