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
  test("roomTools declares the 3 room functions plus each plugin tool", () => {
    const tools = roomTools([codeRead]);
    expect(tools.map((t) => t.name)).toEqual(["list_entries", "read_entry", "upsert_entry", "code__read"]);
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(t.strict).toBe(false);
    }
    expect(tools[3]).toMatchObject({
      description: codeRead.description,
      parameters: codeRead.parameters,
    });
  });

  test("upsert_entry parameters list basis as required", () => {
    const upsert = roomTools([]).find((t) => t.name === "upsert_entry");
    expect((upsert?.parameters as { required?: string[] }).required).toContain("basis");
  });
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
    expect(error).toContain("只能使用 list_entries、read_entry、upsert_entry、code__read");
    expect(calls).toEqual([{ name: "code__read", args: { repo: "r", path: "a.ts" } }]);
  });
});
