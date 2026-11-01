import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TaskAssign, TaskEvent } from "@nema/shared";
import { CodexDirectAdapter } from "../../src/direct/adapter.js";
import type { Account } from "../../src/accounts/schema.js";
import { writePrivateFile } from "../nativePermissions.js";
import { saveConfig } from "../../src/config.js";
import { Cooldowns } from "../../src/routing/cooldown.js";
import { json, sse, startFakeResponsesServer, type FakeResponsesServer } from "../fixtures/fake-responses-server.js";

/**
 * The S4 acceptance criteria, run through the real adapter against two fake endpoints.
 *
 * Two accounts, two servers, two keys: the point is that a limit on the first really moves the next request to
 * the second's endpoint carrying the second's key, and that everything the criteria say must *not* move stays
 * put. No model is called.
 */

let root: string;
let home: string;
let one: FakeResponsesServer;
let two: FakeResponsesServer;
let hub: Server;

const REFRESHER = async () => { throw new Error("no refresh in these tests"); };

const account = (p: Partial<Account> & { id: string }): Account => ({
  name: p.id, enabled: true, adapter: "codex-direct", authMode: "byok", model: "model-a",
  costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z", ...p,
});
const ONE = account({ id: "acct_aaaaaaaaaa", name: "First", order: 0 });
const TWO = account({ id: "acct_bbbbbbbbbb", name: "Second", model: "model-b", order: 1 });

function setAccounts(autoRouting: boolean, accounts: Account[] = [ONE, TWO]) {
  const rows = accounts.map((a) => ({ ...a, baseUrl: a.id === ONE.id ? one.baseUrl : two.baseUrl }));
  writePrivateFile(join(home, "accounts.json"), JSON.stringify({ version: 1, accounts: rows, bindings: {}, autoRouting }, null, 2) + "\n");
  for (const [id, key] of [[ONE.id, "key-one"], [TWO.id, "key-two"]] as const) {
    const dir = join(home, "secrets", "accounts", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivateFile(join(dir, "key"), key);
  }
}

const task = (p: Partial<TaskAssign> = {}): TaskAssign => ({
  type: "task.assign", taskId: "t1", workspaceId: "w1", adapter: "auto", confidential: false,
  prompt: "p", runToken: "rt", hubUrl: "http://127.0.0.1:1", pluginTools: [], ...p,
});
const adapter = (cooldowns?: Cooldowns) =>
  new CodexDirectAdapter({ nemaHome: home, version: "9.9.9", refresher: REFRESHER, ...(cooldowns ? { cooldowns } : {}) });

const reply = (text: string) =>
  sse([
    { type: "response.created", response: { id: "resp" } },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] } },
    { type: "response.completed", response: { id: "resp", status: "completed", output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }] } },
  ]);
const limited = json(429, { error: { code: "rate_limit_exceeded", message: "slow down" } });

async function run(p: Partial<TaskAssign> = {}, cooldowns?: Cooldowns) {
  const events: TaskEvent[] = [];
  const result = await adapter(cooldowns).run(task(p), (e) => events.push(e));
  return { result, events };
}
type Route = { accountId?: string; accountName?: string; model?: string; mode?: string; reason?: string; attempts?: { accountId: string; failure: string }[] };
const routeOf = (r: unknown) => (r as { route?: Route }).route;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "nema-s4-accept-"));
  home = join(root, "nema");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  one = await startFakeResponsesServer();
  two = await startFakeResponsesServer();
  hub = createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end('{"entries":[]}')); });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  saveConfig(home, { authMode: "byok", model: "model-a", byokBaseUrl: one.baseUrl });
});

afterEach(async () => {
  await one.close();
  await two.close();
  hub.closeAllConnections();
  await new Promise<void>((r) => hub.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

describe("S4 acceptance", () => {
  test("criterion 1: the switch is off by default, so the UI has no automatic option and the request fails", async () => {
    setAccounts(false);
    const { result } = await run({ routing: "auto" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("自动路由未开启");
    expect(one.requests).toEqual([]);
    expect(two.requests).toEqual([]);
  });

  test("criterion 2: 429 on the first account, the task finishes on the second, and the record has one attempt", async () => {
    setAccounts(true);
    one.responses(limited);
    two.responses(reply("answered by two"));
    const { result } = await run({ routing: "auto" });
    expect(result).toMatchObject({ ok: true, reply: "answered by two" });
    // The second endpoint is where the answer came from, with the second account's key.
    expect(two.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(1);
    expect(two.requests[0]!.headers.authorization).toBe("Bearer key-two");
    const route = routeOf(result)!;
    expect(route).toMatchObject({ accountId: TWO.id, accountName: "Second", mode: "auto", reason: "auto_after_limit" });
    expect(route.attempts).toEqual([{ accountId: ONE.id, accountName: "First", model: "model-a", failure: "rate_limit" }]);
  });

  test("criterion 3a: a 401 does not move the task", async () => {
    setAccounts(true);
    one.responses(json(401, { error: { code: "invalid_api_key", message: "bad key" } }));
    const { result } = await run({ routing: "auto" });
    expect(result).toMatchObject({ ok: false });
    // No request ever carried the second account's key.
    expect(two.requests.filter((r) => r.url === "/v1/responses")).toEqual([]);
    expect(routeOf(result)).toMatchObject({ accountId: ONE.id });
  });

  test("criterion 3b: a failure after output started does not move the task", async () => {
    setAccounts(true);
    one.responses(sse([
      { type: "response.created", response: { id: "resp" } },
      { type: "response.output_text.delta", output_index: 0, item_id: "m", delta: "half" },
      { type: "response.failed", response: { error: { code: "server_error", message: "boom" } } },
    ]));
    const { result } = await run({ routing: "auto" });
    expect(result).toMatchObject({ ok: false });
    expect(two.requests.filter((r) => r.url === "/v1/responses")).toEqual([]);
  });

  test("criterion 4: the first request on the new account carries no encrypted reasoning", async () => {
    setAccounts(true);
    const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "t" }], encrypted_content: "FROM-FIRST-KEY" };
    const call = { type: "function_call", id: "fc_1", call_id: "c1", name: "list_entries", arguments: "{}", status: "completed" };
    one.responses(
      sse([
        { type: "response.created", response: { id: "r1" } },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        { type: "response.output_item.done", output_index: 1, item: call },
        { type: "response.completed", response: { id: "r1", status: "completed", output: [reasoning, call] } },
      ]),
      limited,
    );
    two.responses(reply("done"));
    const { result } = await run({ routing: "auto" });
    expect(result).toMatchObject({ ok: true });
    const onTwo = two.requests.filter((r) => r.url === "/v1/responses").map((r) => r.body);
    expect(onTwo).toHaveLength(1);
    expect(onTwo[0]).not.toContain("FROM-FIRST-KEY");
    // Nothing replayed: the request still *asks* for encrypted reasoning (`include`), which is what the next
    // round will produce on this account, but no item in `input` is one.
    const body = JSON.parse(onTwo[0]!) as { input: { type: string }[]; include?: string[] };
    expect(body.input.some((i) => i.type === "reasoning")).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    // The conversation is still there: the tool call and its output are what the next account needs.
    expect(onTwo[0]).toContain("function_call_output");
  });

  test("criterion 5: every account denying the ability fails and sends nothing at all", async () => {
    const noImage = [account({ ...ONE, capabilities: { image: false } }), account({ ...TWO, capabilities: { image: false } })];
    setAccounts(true, noImage);
    const ref = { id: "img", kind: "image" as const, mime: "image/png", name: "shot.png", size: 8, sha256: "0".repeat(64), messageId: "m1" };
    const { result } = await run({ routing: "auto", attachments: [ref] });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("图片");
    expect((result as { error: string }).error).toContain("First");
    expect((result as { error: string }).error).toContain("Second");
    expect(one.requests).toEqual([]);
    expect(two.requests).toEqual([]);
  });

  test("a manual choice with the switch on is never moved by a limit", async () => {
    // The user named an account. Automatic routing is on, but a failover would override their decision.
    setAccounts(true);
    one.responses(limited);
    const { result } = await run({ accountId: ONE.id });
    expect(result).toMatchObject({ ok: false });
    expect(two.requests.filter((r) => r.url === "/v1/responses")).toEqual([]);
    expect(routeOf(result)).toMatchObject({ mode: "manual", accountId: ONE.id });
  });

  test("an adapter that was not given a cooldown table still keeps one for its next task", async () => {
    // Omitting `cooldowns` used to build a new table for candidate selection and another for the failure
    // record, then throw both away. The next task on the same adapter has to see the mark.
    setAccounts(true);
    const kept = adapter();
    one.responses(limited);
    two.responses(reply("first run"));
    await kept.run(task({ routing: "auto" }), () => {});
    two.responses(reply("second run"));
    const second = await kept.run(task({ routing: "auto" }), () => {});
    expect(second).toMatchObject({ ok: true, reply: "second run" });
    expect(one.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(1);
    expect(routeOf(second)).toMatchObject({ accountId: TWO.id });
  });

  test("the cooldown outlives the task, so the next run does not start on the account that just failed", async () => {
    setAccounts(true);
    const cooldowns = new Cooldowns();
    one.responses(limited);
    two.responses(reply("first run"));
    await run({ routing: "auto" }, cooldowns);
    expect(cooldowns.until(ONE.id)).not.toBeNull();

    // A second task: the cooling account is not a candidate, so the first request already goes to the second.
    two.responses(reply("second run"));
    const second = await run({ routing: "auto" }, cooldowns);
    expect(second.result).toMatchObject({ ok: true, reply: "second run" });
    expect(one.requests.filter((r) => r.url === "/v1/responses")).toHaveLength(1);
    expect(routeOf(second.result)).toMatchObject({ reason: "auto_primary", accountId: TWO.id });
  });
});
