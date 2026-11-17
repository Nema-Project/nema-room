import { afterEach, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcpServer } from "../src/mcp/server.js";

afterEach(() => vi.unstubAllGlobals());

test.each([{ tags: undefined }, { tags: [] }])("MCP exposes tags and reports old hubs (%j)", async ({ tags }) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith("/plugins") ? { tools: [] } : { entry: { id: "R-1", ...(tags === undefined ? {} : { tags }) } },
  ), { status: 200 })));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await startMcpServer({ hubUrl: "http://fake-hub", runToken: "fake-token" }, serverTransport);
  const client = new Client({ name: "tag-test", version: "0" });
  await client.connect(clientTransport);
  try {
    const upsert = (await client.listTools()).tools.find(tool => tool.name === "upsert_entry")!;
    expect(upsert.inputSchema.properties?.tags).toMatchObject({ type: "array", maxItems: 8, items: { type: "string" } });
    const result = await client.callTool({ name: "upsert_entry", arguments: { tags: ["api"] } });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result).includes("hub 不支持 tags，tags 未写入")).toBe(tags === undefined);
  } finally {
    await client.close();
  }
});
