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

test("task.assign takes the optional skill fields", () => {
  const base = { type: "task.assign", taskId: "t1", workspaceId: "w1", adapter: "codex", confidential: false, prompt: "p", runToken: "rt", hubUrl: "http://localhost:1", pluginTools: [] };
  const plain = parseHubToDaemon(base);
  expect(plain).not.toHaveProperty("projectSkills");
  expect(plain).not.toHaveProperty("retainedSkills");
  expect(plain).not.toHaveProperty("manualSkill");
  const full = parseHubToDaemon({
    ...base,
    projectSkills: [{ repoId: "r1", label: "web", path: "/src/web", mainBranch: "main" }],
    retainedSkills: ["tdd", "web:deploy"],
    manualSkill: { skillId: "tdd", arguments: "x" },
  });
  expect(full).toMatchObject({ projectSkills: [{ repoId: "r1", label: "web", path: "/src/web", mainBranch: "main" }], retainedSkills: ["tdd", "web:deploy"], manualSkill: { skillId: "tdd", arguments: "x" } });
  expect(() => parseHubToDaemon({ ...base, manualSkill: { skillId: 1, arguments: "" } })).toThrow(ZodError);
  expect(() => parseHubToDaemon({ ...base, projectSkills: [{ repoId: "r1" }] })).toThrow(ZodError);
});

// ---- multi-account routing (spec 2026-10-31 §5.4) --------------------------------------------------------

const assignBase = { type: "task.assign", taskId: "t1", workspaceId: "w1", adapter: "auto", confidential: false, prompt: "p", runToken: "rt", hubUrl: "http://localhost:1", pluginTools: [] };

test("task.assign takes the optional account choice, auto routing and thread id", () => {
  const plain = parseHubToDaemon(assignBase);
  expect(plain).not.toHaveProperty("accountId");
  expect(plain).not.toHaveProperty("routing");
  expect(plain).not.toHaveProperty("threadId");
  const full = parseHubToDaemon({ ...assignBase, accountId: "acct_abc1234567", routing: "auto", threadId: "m_1" });
  expect(full).toMatchObject({ accountId: "acct_abc1234567", routing: "auto", threadId: "m_1" });
});

test("task.assign refuses an account id that is not one of ours", () => {
  // The id names a credential directory on the daemon, so a free string must never reach it.
  for (const bad of ["../x", "acct_ABC1234567", "acct_abc12345", "acct_abc12345678", "", 7]) {
    expect(() => parseHubToDaemon({ ...assignBase, accountId: bad }), String(bad)).toThrow(ZodError);
  }
});

test("task.assign accepts routing only as auto, and a thread id only when non-empty", () => {
  expect(() => parseHubToDaemon({ ...assignBase, routing: "manual" })).toThrow(ZodError);
  expect(() => parseHubToDaemon({ ...assignBase, threadId: "" })).toThrow(ZodError);
});

const route = {
  accountId: "acct_abc1234567",
  accountName: "Personal",
  model: "gpt-5.5",
  mode: "manual" as const,
  reason: "user_message" as const,
};

test("task.finished success carries an optional route decision and round-trips it", () => {
  expect(parseDaemonToHub({ type: "task.finished", taskId: "t1", ok: true, reply: "r" })).not.toHaveProperty("route");
  const parsed = parseDaemonToHub({ type: "task.finished", taskId: "t1", ok: true, reply: "r", route });
  expect(parsed).toMatchObject({ route });
  // A failed task carries the route too: there is no reply to hang it on, and the hub names the account in
  // the failure line instead.
  expect(parseDaemonToHub({ type: "task.finished", taskId: "t1", ok: false, error: "e", route })).toMatchObject({ ok: false, error: "e", route });
});

test("a route decision with attempts and usage round-trips", () => {
  const full = {
    ...route,
    mode: "auto" as const,
    reason: "auto_failover" as const,
    attempts: [{ accountId: "acct_0000000001", accountName: "Free", model: "m", failure: "rate_limit" }],
    usage: { inputTokens: 12, outputTokens: 34 },
  };
  expect(parseDaemonToHub({ type: "task.finished", taskId: "t1", ok: true, reply: "r", route: full })).toMatchObject({ route: full });
});

test("a route decision with an unknown reason is refused rather than stored", () => {
  expect(() => parseDaemonToHub({ type: "task.finished", taskId: "t1", ok: true, reply: "r", route: { ...route, reason: "because" } })).toThrow(ZodError);
});

test("a route decision refuses keys outside the agreed shape", () => {
  // The metadata is exported and shown; a stray field (a base URL, a key someone pasted) must not ride along.
  expect(() => parseDaemonToHub({ type: "task.finished", taskId: "t1", ok: true, reply: "r", route: { ...route, baseUrl: "https://example.test" } })).toThrow(ZodError);
  // task.assign drops unknown keys rather than refusing them (spec §5.4): an old daemon reading a newer
  // hub's message ignores what it does not know. Only the route record, which is stored and exported, is strict.
  expect(parseHubToDaemon({ ...assignBase, accountId: "acct_abc1234567", key: "sk-x" })).not.toHaveProperty("key");
});
