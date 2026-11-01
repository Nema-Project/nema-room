import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { runToolLoop } from "../../src/direct/loop.js";
import { dispatchTool, ROOM_TOOLS } from "../../src/direct/tools.js";
import type { RoomClient, RoomResult } from "../../src/room/client.js";
import type { CollectedResponse, InputItem, OutputItem } from "../../src/direct/transport.js";

type RoomCall = { op: string; arg?: unknown };
function stubRoom(result: RoomResult = { ok: true, json: { entries: [] } }) {
  const calls: RoomCall[] = [];
  const room = {
    listEntries: async () => (calls.push({ op: "list" }), result),
    readEntry: async (id: string) => (calls.push({ op: "read", arg: id }), result),
    upsertEntry: async (input: unknown) => (calls.push({ op: "upsert", arg: input }), result),
    callPlugin: async (name: string, args: unknown) => (calls.push({ op: "plugin", arg: { name, args } }), result),
  } as unknown as RoomClient;
  return { room, calls };
}

const fc = (name: string, args: unknown, call_id = `call_${name}`): OutputItem => ({
  type: "function_call",
  id: `fc_${call_id}`,
  call_id,
  name,
  arguments: typeof args === "string" ? args : JSON.stringify(args),
  status: "completed",
});
const msg = (text: string): OutputItem => ({ type: "message", id: "msg_x", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const done = (...items: OutputItem[]): CollectedResponse => ({ status: "completed", items });
const incomplete = (...items: OutputItem[]): CollectedResponse => ({ status: "incomplete", items, incompleteReason: "max_output_tokens" });

/** A fake model: returns the scripted responses in order and records a deep copy of each input. */
function script(...responses: CollectedResponse[] | [(n: number) => CollectedResponse]) {
  const inputs: InputItem[][] = [];
  const call = async (input: InputItem[]) => {
    inputs.push(JSON.parse(JSON.stringify(input)) as InputItem[]);
    const r = typeof responses[0] === "function" ? (responses[0] as (n: number) => CollectedResponse)(inputs.length) : (responses as CollectedResponse[])[inputs.length - 1];
    if (!r) throw new Error("unexpected model call");
    return r;
  };
  return { call, inputs };
}

const USER = "请按上面的指令处理本次用户消息，并只通过提供的函数读写项目知识。";
const base = (call: (i: InputItem[]) => Promise<CollectedResponse>, room: RoomClient, progress: string[] = []) => ({
  instructions: "HUB PROMPT",
  userText: USER,
  call,
  room,
  onProgress: (t: string) => void progress.push(t),
});

describe("tool output cap (64 KB)", () => {
  const MAX = 64 * 1024;
  test("a huge successful result is truncated with a marker, within 64 KB of UTF-8", async () => {
    const big = "中".repeat(100_000); // 300_000 bytes of JSON string content
    const { room } = stubRoom({ ok: true, json: { body: big } });
    const r = await dispatchTool("list_entries", "{}", room);
    const original = Buffer.byteLength(JSON.stringify({ body: big }));
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(MAX);
    expect(r.output).toContain(`…[已截断：原始 ${original} 字节，仅保留前 64KB]`);
    expect(r.output).not.toContain("\uFFFD");
  });
  test("a huge non-JSON hub error body is truncated too", async () => {
    const { room } = stubRoom({ ok: false, status: 502, error: "x".repeat(200_000) });
    const r = await dispatchTool("read_entry", '{"id":"a"}', room);
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(MAX);
    expect(r.output).toContain("已截断");
  });
  test("outputs at or under the cap are untouched", async () => {
    const { room } = stubRoom({ ok: true, json: { a: "y".repeat(1000) } });
    const r = await dispatchTool("list_entries", "{}", room);
    expect(r.output).toBe(JSON.stringify({ a: "y".repeat(1000) }));
  });
});

describe("ROOM_TOOLS / dispatchTool", () => {
  test("Room functions are non-strict with JSON-schema parameters", () => {
    expect(ROOM_TOOLS.map((t) => t.name)).toEqual(["list_entries", "read_entry", "upsert_entry", "open_thread", "offer_skill_install"]);
    for (const t of ROOM_TOOLS) {
      expect(t.type).toBe("function");
      expect(t.strict).toBe(false);
      expect(t.parameters.type).toBe("object");
      expect(t.parameters).not.toHaveProperty("$schema");
    }
    expect(ROOM_TOOLS[1]!.parameters).toMatchObject({ properties: { id: { type: "string" } }, required: ["id"] });
    const up = ROOM_TOOLS[2]!.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(up.properties)).toEqual(expect.arrayContaining(["id", "kind", "title", "body", "reason", "sourceMessages", "basis", "quotes", "confirmed"]));
    expect(up.required).toEqual(expect.arrayContaining(["kind", "title", "body", "reason"]));
  });

  test("an unknown function name is echoed capped, so the output stays far below 64 KB", async () => {
    const { room } = stubRoom({ ok: true, json: {} });
    const r = await dispatchTool("x".repeat(200_000), "{}", room);
    expect(r.known).toBe(false);
    expect(Buffer.byteLength(r.output)).toBeLessThan(1000);
  });

  test("routes known tools to the Room client", async () => {
    const { room, calls } = stubRoom({ ok: true, json: { id: "R-1" } });
    expect(await dispatchTool("list_entries", "", room)).toEqual({ output: '{"id":"R-1"}', known: true });
    await dispatchTool("read_entry", '{"id":"R-1"}', room);
    await dispatchTool("upsert_entry", '{"kind":"requirement","title":"t"}', room);
    expect(calls).toEqual([{ op: "list" }, { op: "read", arg: "R-1" }, { op: "upsert", arg: { kind: "requirement", title: "t" } }]);
  });

  test("hub errors become an error output (known)", async () => {
    const { room } = stubRoom({ ok: false, status: 400, error: "bad kind" });
    const r = await dispatchTool("upsert_entry", "{}", room);
    expect(r.known).toBe(true);
    expect(JSON.parse(r.output)).toMatchObject({ error: "bad kind", status: 400 });
  });

  test("unknown name or invalid JSON -> known:false and never touches the hub", async () => {
    const { room, calls } = stubRoom();
    for (const [name, args] of [["shell", '{"cmd":"ls"}'], ["read_entry", "{not json"], ["upsert_entry", "[1,2]"], ["__proto__", "{}"]] as const) {
      const r = await dispatchTool(name, args, room);
      expect(r.known).toBe(false);
      expect(JSON.parse(r.output)).toHaveProperty("error");
    }
    expect(calls).toEqual([]);
  });

  test("read_entry without a string id -> error output, no hub call", async () => {
    const { room, calls } = stubRoom();
    const r = await dispatchTool("read_entry", "{}", room);
    expect(JSON.parse(r.output)).toHaveProperty("error");
    expect(calls).toEqual([]);
  });
});

describe("runToolLoop", () => {
  test("one upsert then a final reply; history is replayed statelessly", async () => {
    const { room, calls } = stubRoom({ ok: true, json: { id: "R-1", commit: "abc" } });
    const reasoning: OutputItem = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "ENC" };
    const m = script(done(reasoning, msg("先记录。"), fc("upsert_entry", { kind: "requirement", title: "t" }, "c1")), done(msg("已记录 R-1。")));
    const progress: string[] = [];
    const r = await runToolLoop(base(m.call, room, progress));
    expect(r).toEqual({ reply: "已记录 R-1。" });
    expect(calls).toEqual([{ op: "upsert", arg: { kind: "requirement", title: "t" } }]);
    expect(m.inputs[0]).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: USER }] }]);
    expect(m.inputs[1]).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: USER }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }], encrypted_content: "ENC" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "先记录。" }] },
      { type: "function_call", call_id: "c1", name: "upsert_entry", arguments: '{"kind":"requirement","title":"t"}' },
      { type: "function_call_output", call_id: "c1", output: '{"id":"R-1","commit":"abc"}' },
    ]);
    expect(progress.some((p) => p.includes("upsert_entry"))).toBe(true);
  });

  test("a listed plugin tool is dispatched through the same loop", async () => {
    const { room, calls } = stubRoom({ ok: true, json: { text: "body" } });
    const pluginTools = [{ name: "code__read", description: "Read a file", parameters: { type: "object" } }];
    const m = script(done(fc("code__read", { repo: "r", path: "a.ts" }, "c1")), done(msg("读完了")));
    const r = await runToolLoop({ ...base(m.call, room), pluginTools });
    expect(r).toEqual({ reply: "读完了" });
    expect(calls).toEqual([{ op: "plugin", arg: { name: "code__read", args: { repo: "r", path: "a.ts" } } }]);
  });

  test("several calls in one response are paired by call_id", async () => {
    const { room } = stubRoom({ ok: true, json: "x" });
    const m = script(done(fc("list_entries", {}, "a"), fc("read_entry", { id: "R-2" }, "b")), done(msg("ok")));
    await runToolLoop(base(m.call, room));
    const tail = m.inputs[1]!.slice(1);
    expect(tail.map((i) => `${i.type}:${"call_id" in i ? i.call_id : ""}`)).toEqual(["function_call:a", "function_call:b", "function_call_output:a", "function_call_output:b"]);
  });

  test("over-long call_ids are hashed and duplicates renamed, consistently in call and output", async () => {
    const { room } = stubRoom();
    const long = "x".repeat(80);
    const m = script(done(fc("list_entries", {}, long), fc("list_entries", {}, "dup")), done(fc("list_entries", {}, "dup"), fc("list_entries", {}, "dup")), done(msg("ok")));
    await runToolLoop(base(m.call, room));
    const ids = m.inputs[2]!.filter((i) => i.type === "function_call").map((i) => (i as { call_id: string }).call_id);
    const outs = m.inputs[2]!.filter((i) => i.type === "function_call_output").map((i) => (i as { call_id: string }).call_id);
    const hashed = `call_${createHash("sha256").update(long).digest("hex").slice(0, 32)}`;
    expect(ids).toEqual([hashed, "dup", "dup_dup1", "dup_dup2"]);
    expect(outs).toEqual(ids);
    expect(ids.every((id) => id.length <= 64)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a 64-char id that collides stays within 64 chars", async () => {
    const { room } = stubRoom();
    const id64 = "y".repeat(64);
    const m = script(done(fc("list_entries", {}, id64), fc("list_entries", {}, id64)), done(msg("ok")));
    await runToolLoop(base(m.call, room));
    const ids = m.inputs[1]!.filter((i) => i.type === "function_call").map((i) => (i as { call_id: string }).call_id);
    expect(ids[0]).toBe(id64);
    expect(ids[1]!.length).toBeLessThanOrEqual(64);
    expect(ids[1]).not.toBe(id64);
  });

  test("incomplete output is continued with 「请继续。」 and the parts are joined", async () => {
    const { room } = stubRoom();
    const m = script(incomplete(msg("前半")), done(msg("后半")));
    const r = await runToolLoop(base(m.call, room));
    expect(r.reply).toBe("前半后半");
    expect(m.inputs[1]!.at(-1)).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "请继续。" }] });
  });

  test("still incomplete after 3 continuations -> fails", async () => {
    const { room } = stubRoom();
    const m = script(() => incomplete(msg("…")));
    await expect(runToolLoop(base(m.call, room))).rejects.toThrow(/不完整/);
    expect(m.inputs.length).toBe(4);
  });

  test("completed without any assistant text -> 「Agent 没有返回回复」", async () => {
    const { room } = stubRoom();
    const m = script(done({ type: "message", role: "assistant", content: [] }));
    await expect(runToolLoop(base(m.call, room))).rejects.toThrow("Agent 没有返回回复");
  });

  test("24 model calls max", async () => {
    const { room } = stubRoom();
    const m = script((n) => done(fc("list_entries", {}, `c${n}`)));
    await expect(runToolLoop(base(m.call, room))).rejects.toThrow("Agent 超出单次运行上限（模型调用 24 次）");
    expect(m.inputs.length).toBe(24);
  });

  test("60 tool calls max", async () => {
    const { room, calls } = stubRoom();
    const m = script((n) => done(fc("list_entries", {}, `a${n}`), fc("list_entries", {}, `b${n}`), fc("list_entries", {}, `c${n}`)));
    await expect(runToolLoop(base(m.call, room))).rejects.toThrow("Agent 超出单次运行上限（工具调用 60 次）");
    expect(calls.length).toBe(60);
  });

  test("more than 5 unknown-tool / invalid-JSON requests -> aborts", async () => {
    const { room, calls } = stubRoom();
    const m = script((n) => done(n % 2 ? fc("run_shell", { cmd: "id" }, `c${n}`) : fc("read_entry", "{oops", `c${n}`)));
    await expect(runToolLoop(base(m.call, room))).rejects.toThrow("Agent 多次请求未提供的工具，已中止");
    expect(m.inputs.length).toBe(6);
    expect(calls).toEqual([]);
    // the model is told about each bad call
    const outs = m.inputs[5]!.filter((i) => i.type === "function_call_output");
    expect(outs.length).toBe(5);
    expect(outs.every((o) => "error" in JSON.parse((o as { output: string }).output))).toBe(true);
  });

  test("custom limits are honoured", async () => {
    const { room } = stubRoom();
    const m = script((n) => done(fc("list_entries", {}, `c${n}`)));
    await expect(runToolLoop({ ...base(m.call, room), limits: { maxModelCalls: 2, maxToolCalls: 60, maxUnknownTools: 5, maxContinuations: 3 } })).rejects.toThrow("模型调用 2 次");
  });
});

describe("runToolLoop after abort", () => {
  test("a tool result arriving after the signal fired emits no progress and stops the loop", async () => {
    const ac = new AbortController();
    const progress: string[] = [];
    const room = {
      listEntries: async () => {
        ac.abort(new Error("timeout"));
        return { ok: true, json: {} } as RoomResult;
      },
    } as unknown as RoomClient;
    const m = script((n) => done(fc("list_entries", {}, `c${n}`)));
    await expect(runToolLoop({ ...base(m.call, room, progress), signal: ac.signal })).rejects.toThrow("timeout");
    expect(progress).toEqual([]);
    expect(m.inputs.length).toBe(1);
  });
});

describe("runToolLoop user parts", () => {
  test("the first user message carries the extra parts after the user text, on every model call", async () => {
    const { room } = stubRoom();
    const parts = [
      { type: "input_text" as const, text: "PREAMBLE" },
      { type: "input_image" as const, image_url: "data:image/png;base64,AAAA" },
      { type: "input_file" as const, filename: "spec.pdf", file_data: "data:application/pdf;base64,BBBB" },
    ];
    const { call, inputs } = script(done(fc("list_entries", {})), done(msg("ok")));
    const res = await runToolLoop({ ...base(call, room), userParts: parts });
    expect(res.reply).toBe("ok");
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: USER }, ...parts] });
    }
  });

  test("without parts the first user message is unchanged", async () => {
    const { room } = stubRoom();
    const { call, inputs } = script(done(msg("ok")));
    await runToolLoop(base(call, room));
    expect(inputs[0]![0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: USER }] });
  });
});

describe("onBeforeCall", () => {
  const reasoning = (enc: string): OutputItem => ({ type: "reasoning", id: `rs_${enc}`, summary: [{ type: "summary_text", text: "s" }], encrypted_content: enc }) as OutputItem;

  test("what it returns is what is sent, and the loop keeps its own history", async () => {
    // The hook exists so a caller can change the payload of one request without changing the conversation:
    // automatic routing uses it to drop another account's encrypted reasoning. If it mutated the loop's own
    // history, one filtered call would silently drop it for every later call too.
    const seen: string[][] = [];
    const m = script(done(reasoning("enc-1"), fc("list_entries", {}, "c1")), done(msg("done")));
    const { room } = stubRoom();
    await runToolLoop({
      ...base(m.call, room),
      onBeforeCall: (history) => {
        seen.push(history.map((i) => i.type));
        return history.filter((i) => i.type !== "reasoning");
      },
    });
    // First call has only the user message; the second would carry the reasoning, and the hook removes it.
    expect(seen).toEqual([["message"], ["message", "reasoning", "function_call", "function_call_output"]]);
    expect(m.inputs[1]!.some((i) => i.type === "reasoning")).toBe(false);
    // The loop still holds it, so a hook that changes its mind on the next call sees it again.
    expect(seen[1]).toContain("reasoning");
  });

  test("without the hook the history is sent unchanged", async () => {
    const m = script(done(reasoning("enc-1"), fc("list_entries", {}, "c1")), done(msg("done")));
    const { room } = stubRoom();
    await runToolLoop(base(m.call, room));
    expect(m.inputs[1]!.some((i) => i.type === "reasoning")).toBe(true);
  });
});
