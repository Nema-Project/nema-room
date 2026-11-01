import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TaskAssign } from "@nema/shared";
import { CodexDirectAdapter } from "../../src/direct/adapter.js";
import { saveConfig } from "../../src/config.js";
import { json, sse, startFakeResponsesServer, type FakeResponsesServer } from "../fixtures/fake-responses-server.js";

/**
 * The S3 acceptance criteria, run through the real adapter against two fake endpoints and a fake hub.
 *
 * Nothing here calls a model: the endpoints are local servers that record what arrived. The point is that a
 * choice made in the app ends up as a different credential and a different endpoint on the wire, and that a
 * broken choice fails before anything is sent.
 */

const b64u = (s: string) => Buffer.from(s).toString("base64url");
const jwt = (p: Record<string, unknown>) => `${b64u(JSON.stringify({ alg: "none" }))}.${b64u(JSON.stringify(p))}.sig`;

let root: string;
let home: string;
let one: FakeResponsesServer;
let two: FakeResponsesServer;
let hub: Server;
let hubUrl: string;
let hubCalls: { method?: string; url?: string }[];

const account = (p: Record<string, unknown>) => ({
  name: "A", enabled: true, adapter: "codex-direct", authMode: "byok", model: "model-a",
  costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z", ...p,
});
const ONE = account({ id: "acct_aaaaaaaaaa", name: "First", baseUrl: "", model: "model-a", order: 0 });
const TWO = account({ id: "acct_bbbbbbbbbb", name: "Second", baseUrl: "", model: "model-b", order: 1 });

function setAccounts(accounts: unknown[] = [ONE, TWO], bindings: Record<string, string> = {}) {
  writeFileSync(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts, bindings }, null, 2) + "\n", { mode: 0o600 });
}
function setKey(id: string, value: string) {
  const dir = join(home, "secrets", "accounts", id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "key"), value, { mode: 0o600 });
}

const task = (p: Partial<TaskAssign> = {}): TaskAssign => ({
  type: "task.assign", taskId: "t1", workspaceId: "w1", adapter: "auto", confidential: false,
  prompt: "p", runToken: "rt", hubUrl, pluginTools: [], ...p,
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nema-s3-accept-"));
  home = join(root, "nema");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  one = await startFakeResponsesServer();
  two = await startFakeResponsesServer();
  const first = { ...ONE, baseUrl: one.baseUrl };
  const second = { ...TWO, baseUrl: two.baseUrl };
  setAccounts([first, second]);
  setKey(first.id, "key-one");
  setKey(second.id, "key-two");
  saveConfig(home, { authMode: "byok", model: "model-a", byokBaseUrl: one.baseUrl });
  hubCalls = [];
  hub = createServer((req, res) => {
    hubCalls.push({ method: req.method, url: req.url });
    req.resume();
    req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end('{"entries":[]}'));
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await one.close();
  await two.close();
  hub.closeAllConnections();
  await new Promise<void>((r) => hub.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

const reply = (text: string) =>
  sse([
    { type: "response.created", response: { id: "resp" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
    { type: "response.completed", response: { id: "resp", status: "completed", output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] } },
  ]);
const adapter = () => new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", refresher: async () => { throw new Error("no refresh in these tests"); } });

describe("S3 acceptance", () => {
  test("criterion 1: two byok accounts on two endpoints — picking B reaches B's endpoint with B's key", async () => {
    two.responses(reply("from two"));
    const result = await adapter().run(task({ accountId: TWO.id }), () => {});
    expect(result).toMatchObject({ ok: true, reply: "from two" });
    expect(two.requests).toHaveLength(1);
    expect(one.requests).toHaveLength(0);
    expect(two.requests[0]!.headers.authorization).toBe("Bearer key-two");
    expect(two.requests[0]!.url.startsWith("/v1/responses")).toBe(true);
  });

  test("criterion 2: message beats thread beats workspace", async () => {
    setAccounts([{ ...ONE, baseUrl: one.baseUrl }, { ...TWO, baseUrl: two.baseUrl }], { "ws:w1": ONE.id, "thread:m_t": TWO.id });
    two.responses(reply("thread wins"));
    const viaThread = await adapter().run(task({ threadId: "m_t" }), () => {});
    expect((viaThread as { route?: { reason?: string; accountId?: string } }).route).toMatchObject({ reason: "user_thread", accountId: TWO.id });

    one.responses(reply("message wins"));
    const viaMessage = await adapter().run(task({ threadId: "m_t", accountId: ONE.id }), () => {});
    expect((viaMessage as { route?: { reason?: string; accountId?: string } }).route).toMatchObject({ reason: "user_message", accountId: ONE.id });
    expect(one.requests).toHaveLength(1);

    // Only a workspace binding: it applies when the message names nothing and the thread has no binding.
    const viaWorkspace = await adapter().run(task({ threadId: "m_other" }), () => {});
    expect((viaWorkspace as { route?: { reason?: string; accountId?: string } }).route).toMatchObject({ reason: "user_workspace", accountId: ONE.id });
  });

  test("criterion 3: a missing or unknown account fails and sends nothing", async () => {
    const missing = await adapter().run(task({ accountId: "acct_zzzzzzzzzz" }), () => {});
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { error: string }).error).toBeTruthy();
    expect(one.requests).toEqual([]);
    expect(two.requests).toEqual([]);

    // A real account with no key file.
    rmSync(join(home, "secrets", "accounts", TWO.id), { recursive: true, force: true });
    const noCredential = await adapter().run(task({ accountId: TWO.id }), () => {});
    expect(noCredential).toMatchObject({ ok: false });
    expect((noCredential as { error: string }).error).toContain("Second");
    expect(one.requests).toEqual([]);
    expect(two.requests).toEqual([]);
  });

  test("criterion 5: the route record has no endpoint, no key and no credential", async () => {
    one.responses(reply("ok"));
    const result = await adapter().run(task(), () => {});
    const record = JSON.stringify((result as { route?: unknown }).route);
    for (const secret of ["key-one", "key-two", "127.0.0.1", "example.test", "baseUrl"]) {
      expect(record, secret).not.toContain(secret);
    }
  });

  test("criterion 6: automatic routing fails with a sentence and does not run on the default", async () => {
    const result = await adapter().run(task({ routing: "auto" }), () => {});
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("后续版本");
    expect(one.requests).toEqual([]);
    expect(two.requests).toEqual([]);
  });
});
