import { describe, expect, test } from "vitest";
import type { PluginToolSpec } from "@nema/shared";
import { dispatchTool, roomTools } from "../../src/direct/tools.js";
import type { RoomResult } from "../../src/room/client.js";

const codeRead: PluginToolSpec = {
  name: "code__read",
  description: "Read a file from the repository, optionally limited to a line range.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      path: { type: "string" },
    },
    required: ["repo", "path"],
    additionalProperties: false,
  },
};

describe("roomTools", () => {
  test("roomTools lists open_thread and each plugin tool", () => {
    const tools = roomTools([codeRead]);
    expect(tools.map((t) => t.name)).toEqual(["list_entries", "read_entry", "upsert_entry", "open_thread", "offer_skill_install", "code__read"]);
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(t.strict).toBe(false);
    }
    expect(tools[5]).toMatchObject({
      description: codeRead.description,
      parameters: codeRead.parameters,
    });
    expect(tools[3]).toMatchObject({
      name: "open_thread",
      description: "Move this conversation into a thread anchored on the current message. When the user asks to compare options or weigh tradeoffs and has not decided, call this first and discuss inside the thread. Your reply will be posted in the thread.",
      parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
    });
  });

  test("upsert_entry parameters list basis as required", () => {
    const upsert = roomTools([]).find((t) => t.name === "upsert_entry");
    expect((upsert?.parameters as { required?: string[] }).required).toContain("basis");
  });

  test("upsert_entry leaves the hub-kept implementation evidence keys optional", () => {
    const upsert = roomTools([]).find((t) => t.name === "upsert_entry");
    type Schema = { properties: Record<string, Schema>; required?: string[] };
    const evidence = (upsert?.parameters as Schema).properties.implementation!.properties.evidence!;
    expect(Object.keys(evidence.properties)).toEqual(expect.arrayContaining(["acceptanceReview", "reportEvidence"]));
    expect(evidence.required).toEqual(["reportMessageId", "commits", "inferred", "note", "confirmedBy"]);
  });
});

test("offer_skill_install takes a source and an optional path, and says it only offers", () => {
  const offer = roomTools([]).find((t) => t.name === "offer_skill_install")!;
  expect(offer.parameters).toEqual({
    type: "object",
    properties: { source: { type: "string" }, path: { type: "string" } },
    required: ["source"],
    additionalProperties: false,
  });
  // The model has to know pressing Install is the user's step, not something it already did.
  expect(offer.description).toMatch(/does not install/i);
});

test("dispatchTool offer_skill_install calls room.offerSkillInstall with the arguments", async () => {
  const calls: unknown[] = [];
  const ok = async (): Promise<RoomResult> => ({ ok: true, json: {} });
  const room = {
    listEntries: ok,
    readEntry: ok,
    upsertEntry: ok,
    openThread: ok,
    callPlugin: ok,
    offerSkillInstall: async (args: unknown): Promise<RoomResult> => { calls.push(args); return { ok: true, json: { offer: { id: "pdf" } } }; },
  };
  expect(await dispatchTool("offer_skill_install", '{"source":"acme/skills","path":"skills/pdf"}', room)).toEqual({ output: '{"offer":{"id":"pdf"}}', known: true, wrote: true });
  expect(calls).toEqual([{ source: "acme/skills", path: "skills/pdf" }]);
  expect((await dispatchTool("offer_skill_install", "[1]", room)).known).toBe(false);
});

test("dispatchTool open_thread calls room.openThread", async () => {
  const calls: unknown[] = [];
  const room = {
    listEntries: async (): Promise<RoomResult> => ({ ok: true, json: [] }),
    readEntry: async (): Promise<RoomResult> => ({ ok: true, json: {} }),
    upsertEntry: async (): Promise<RoomResult> => ({ ok: true, json: {} }),
    openThread: async (args: unknown): Promise<RoomResult> => { calls.push(args); return { ok: true, json: { threadId: "m1" } }; },
    callPlugin: async (): Promise<RoomResult> => ({ ok: true, json: {} }),
    offerSkillInstall: async (): Promise<RoomResult> => ({ ok: true, json: {} }),
  };
  const result = await dispatchTool("open_thread", '{"title":"Long topic"}', room);
  expect(result).toEqual({ output: '{"threadId":"m1"}', known: true, wrote: true });
  expect(calls).toEqual([{ title: "Long topic" }]);
});

describe("dispatchTool plugin tools", () => {
  test("dispatchTool routes a listed plugin tool to callPlugin and treats an unlisted one as unknown", async () => {
    const calls: { name: string; args: unknown }[] = [];
    const room = {
      listEntries: async (): Promise<RoomResult> => {
        throw new Error("listEntries");
      },
      readEntry: async (): Promise<RoomResult> => {
        throw new Error("readEntry");
      },
      upsertEntry: async (): Promise<RoomResult> => {
        throw new Error("upsertEntry");
      },
      openThread: async (): Promise<RoomResult> => {
        throw new Error("openThread");
      },
      callPlugin: async (name: string, args: unknown): Promise<RoomResult> => {
        calls.push({ name, args });
        return { ok: true, json: { text: "body" } };
      },
      offerSkillInstall: async (): Promise<RoomResult> => {
        throw new Error("offerSkillInstall");
      },
    };

    const listed = await dispatchTool("code__read", '{"repo":"r","path":"a.ts"}', room, [codeRead]);
    expect(listed).toEqual({ output: '{"text":"body"}', known: true, wrote: true });
    expect(calls).toEqual([{ name: "code__read", args: { repo: "r", path: "a.ts" } }]);

    const unknown = await dispatchTool("code__search", "{}", room, [codeRead]);
    expect(unknown.known).toBe(false);
    const error = (JSON.parse(unknown.output) as { error: string }).error;
    expect(error).toContain("只能使用 list_entries、read_entry、upsert_entry、open_thread、offer_skill_install、code__read");
    expect(calls).toEqual([{ name: "code__read", args: { repo: "r", path: "a.ts" } }]);
  });
});

test("read_skill is only known when the task has a Skill reader", async () => {
  const { dispatchTool } = await import("../../src/direct/tools.js");
  const room = {} as never;
  expect(await dispatchTool("read_skill", '{"name":"x"}', room, [])).toMatchObject({ known: false });
  const reader = { read: async (args: string) => `read ${args}` } as never;
  expect(await dispatchTool("read_skill", '{"name":"x"}', room, [], reader)).toEqual({ output: 'read {"name":"x"}', known: true, wrote: false });
});
