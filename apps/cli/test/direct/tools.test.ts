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
    expect(tools.map((t) => t.name)).toEqual(["list_entries", "read_entry", "upsert_entry", "open_thread", "code__read"]);
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(t.strict).toBe(false);
    }
    expect(tools[4]).toMatchObject({
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
});

test("dispatchTool open_thread calls room.openThread", async () => {
  const calls: unknown[] = [];
  const room = {
    listEntries: async (): Promise<RoomResult> => ({ ok: true, json: [] }),
    readEntry: async (): Promise<RoomResult> => ({ ok: true, json: {} }),
    upsertEntry: async (): Promise<RoomResult> => ({ ok: true, json: {} }),
    openThread: async (args: unknown): Promise<RoomResult> => { calls.push(args); return { ok: true, json: { threadId: "m1" } }; },
    callPlugin: async (): Promise<RoomResult> => ({ ok: true, json: {} }),
  };
  const result = await dispatchTool("open_thread", '{"title":"Long topic"}', room);
  expect(result).toEqual({ output: '{"threadId":"m1"}', known: true });
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
    };

    const listed = await dispatchTool("code__read", '{"repo":"r","path":"a.ts"}', room, [codeRead]);
    expect(listed).toEqual({ output: '{"text":"body"}', known: true });
    expect(calls).toEqual([{ name: "code__read", args: { repo: "r", path: "a.ts" } }]);

    const unknown = await dispatchTool("code__search", "{}", room, [codeRead]);
    expect(unknown.known).toBe(false);
    const error = (JSON.parse(unknown.output) as { error: string }).error;
    expect(error).toContain("只能使用 list_entries、read_entry、upsert_entry、open_thread、code__read");
    expect(calls).toEqual([{ name: "code__read", args: { repo: "r", path: "a.ts" } }]);
  });
});
