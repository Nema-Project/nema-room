import { expect, test } from "vitest";
import { ZodError } from "zod";
import { WORKPACKAGE_LIMITS, parseDaemonToHub, parseHubToDaemon } from "../src/index.js";

test("valid task.assign parses", () => {
  const m = parseHubToDaemon({ type: "task.assign", taskId: "t1", workspaceId: "w1", adapter: "codex", confidential: false, prompt: "p", runToken: "rt", hubUrl: "http://localhost:1", pluginTools: [] });
  expect(m.type).toBe("task.assign");
});
test("task.assign accepts adapter auto + confidential, requires confidential", () => {
  const base = { type: "task.assign", taskId: "t1", workspaceId: "w1", adapter: "auto", prompt: "p", runToken: "rt", hubUrl: "http://localhost:1", pluginTools: [] };
  expect(parseHubToDaemon({ ...base, confidential: true })).toMatchObject({ adapter: "auto", confidential: true });
  expect(() => parseHubToDaemon(base)).toThrow(ZodError);
});
test("task.finished ok:true without reply throws", () => {
  expect(() => parseDaemonToHub({ type: "task.finished", taskId: "t1", ok: true })).toThrow(ZodError);
});
test("task.finished variants and hello parse", () => {
  expect(parseDaemonToHub({ type: "task.finished", taskId: "t1", ok: false, error: "x" }).type).toBe("task.finished");
  expect(parseDaemonToHub({ type: "hello", token: "t", version: "1", adapters: ["codex"] }).type).toBe("hello");
});
test("unknown type throws", () => {
  expect(() => parseDaemonToHub({ type: "nope" })).toThrow(ZodError);
  expect(() => parseHubToDaemon({ type: "nope" })).toThrow(ZodError);
});
test("welcome parses with and without the workspace id list", () => {
  expect(parseHubToDaemon({ type: "welcome" })).toEqual({ type: "welcome" });
  expect(parseHubToDaemon({ type: "welcome", workspaceIds: ["ws_a", "ws_b"] })).toEqual({ type: "welcome", workspaceIds: ["ws_a", "ws_b"] });
  expect(() => parseHubToDaemon({ type: "welcome", workspaceIds: [1] })).toThrow(ZodError);
});
test("workspace.deleted parses and requires a workspace id", () => {
  expect(parseHubToDaemon({ type: "workspace.deleted", workspaceId: "ws_a" })).toEqual({ type: "workspace.deleted", workspaceId: "ws_a" });
  expect(() => parseHubToDaemon({ type: "workspace.deleted" })).toThrow(ZodError);
});
test("task.assign without pluginTools fails to parse; with [] parses", () => {
  const base = { type: "task.assign", taskId: "t1", workspaceId: "w1", adapter: "codex", confidential: false, prompt: "p", runToken: "rt", hubUrl: "http://localhost:1" };
  expect(() => parseHubToDaemon(base)).toThrow(ZodError);
  expect(parseHubToDaemon({ ...base, pluginTools: [] })).toMatchObject({ type: "task.assign", pluginTools: [] });
  const tool = { name: "code__read", description: "Read a file.", parameters: { type: "object", properties: { repo: { type: "string" } } } };
  expect(parseHubToDaemon({ ...base, pluginTools: [tool] })).toMatchObject({ pluginTools: [tool] });
  expect(() => parseHubToDaemon({ ...base, pluginTools: [{ name: "code__read" }] })).toThrow(ZodError);
});
test("repo.fetched round-trips through the parser", () => {
  const ok = { type: "repo.fetched" as const, repoId: "r1", ok: true as const, at: "2026-10-23T00:00:00.000Z" };
  expect(parseDaemonToHub(ok)).toEqual(ok);
  const failed = { type: "repo.fetched" as const, repoId: "r1", ok: false as const, error: "fetch failed", at: "2026-10-23T00:00:00.000Z" };
  expect(parseDaemonToHub(failed)).toEqual(failed);
});
test("rpc.request / rpc.response / repo.moved round-trip through the parsers", () => {
  const req = { type: "rpc.request" as const, id: "1", method: "code__read", params: { repo: "r", path: "a.ts" } };
  expect(parseHubToDaemon(req)).toEqual(req);
  const ok = { type: "rpc.response" as const, id: "1", ok: true as const, result: { text: "hi" } };
  expect(parseDaemonToHub(ok)).toEqual(ok);
  const err = { type: "rpc.response" as const, id: "1", ok: false as const, error: "nope" };
  expect(parseDaemonToHub(err)).toEqual(err);
  expect(() => parseDaemonToHub({ type: "rpc.response", id: "1", ok: true })).toThrow(ZodError);
  expect(() => parseDaemonToHub({ type: "rpc.response", id: "1", ok: false })).toThrow(ZodError);
  const moved = { type: "repo.moved" as const, repoId: "r1", mainRef: "main", from: null, to: "abc" };
  expect(parseDaemonToHub(moved)).toEqual(moved);
  const movedFrom = { type: "repo.moved" as const, repoId: "r1", mainRef: "main", from: "old", to: "abc" };
  expect(parseDaemonToHub(movedFrom)).toEqual(movedFrom);
});

test("task.assign with limits parses; without limits parses", () => {
  const base = { type: "task.assign", taskId: "t1", workspaceId: "w1", adapter: "codex", confidential: false, prompt: "p", runToken: "rt", hubUrl: "http://localhost:1", pluginTools: [] };
  expect(parseHubToDaemon(base)).toMatchObject({ type: "task.assign" });
  expect(parseHubToDaemon({ ...base, limits: WORKPACKAGE_LIMITS })).toMatchObject({ limits: { maxModelCalls: 48, maxToolCalls: 120, timeoutMs: 1_200_000 } });
  expect(() => parseHubToDaemon({ ...base, limits: { maxModelCalls: 1 } })).toThrow();
});

test("hello accepts an optional features list", () => {
  const hello = { type: "hello" as const, token: "t", version: "1", adapters: ["codex"], features: ["attachments"] };
  expect(parseDaemonToHub(hello)).toEqual(hello);
  expect(() => parseDaemonToHub({ ...hello, features: [1] })).toThrow(ZodError);
});
test("task.assign carries optional attachment refs with a hex sha256", () => {
  const base = { type: "task.assign", taskId: "t1", workspaceId: "w1", adapter: "auto", confidential: false, prompt: "p", runToken: "rt", hubUrl: "http://localhost:1", pluginTools: [] };
  const ref = { id: "att_1", kind: "pdf", mime: "application/pdf", name: "a.pdf", size: 3, sha256: "0".repeat(64), messageId: "m1" };
  expect(parseHubToDaemon({ ...base, attachments: [ref] })).toMatchObject({ attachments: [ref] });
  expect(parseHubToDaemon(base)).not.toHaveProperty("attachments");
  expect(() => parseHubToDaemon({ ...base, attachments: [{ ...ref, sha256: "xyz" }] })).toThrow(ZodError);
});
