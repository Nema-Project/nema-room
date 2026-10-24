import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("local same-origin hub URLs", () => {
  test("uses relative API, diagram, and event URLs in managed local mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_NEMA_LOCAL", "1");
    vi.stubEnv("NEXT_PUBLIC_HUB_URL", "http://127.0.0.1:4400");
    const hub = await import("../lib/hub");
    expect(hub.diagramHtmlUrl("w/1", "G 1")).toBe("/api/workspaces/w%2F1/diagrams/G%201.html");
    expect(hub.eventsUrl("w/1")).toBe("/api/workspaces/w%2F1/events");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await hub.listWorkspaces();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/workspaces");
  });

  test("keeps explicit legacy hub URL mode available", async () => {
    vi.stubEnv("NEXT_PUBLIC_NEMA_LOCAL", "0");
    vi.stubEnv("NEXT_PUBLIC_HUB_URL", "http://127.0.0.1:4400");
    const hub = await import("../lib/hub");
    expect(hub.diagramHtmlUrl("w1", "G1")).toBe("http://127.0.0.1:4400/api/workspaces/w1/diagrams/G1.html");
    expect(hub.eventsUrl("w1")).toBe("http://127.0.0.1:4400/api/workspaces/w1/events");
  });
});
