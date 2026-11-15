import type { GetServerSidePropsContext } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setShareFetchForTests } from "@/lib/shareHub";
import { loadSharePage } from "@/lib/sharePage";

const token = "a".repeat(43);
const list = { workspaceName: "Alpha", entries: [{ id: "D-1", title: "Decision", status: "active", basis: "decided" }] };
const entry = { ...list.entries[0], body: "Decision text", quotes: [] };

function context(eid?: string, peer: string | undefined = "127.0.0.1") {
  const res = { statusCode: 200, setHeader: vi.fn() };
  return {
    context: { req: { headers: { "x-nema-share-peer": peer }, socket: { remoteAddress: "127.0.0.1" } }, res, params: { token, ...(eid ? { eid } : {}) } } as unknown as GetServerSidePropsContext,
    res,
  };
}

afterEach(() => { setShareFetchForTests(undefined); vi.unstubAllEnvs(); });

describe.each([undefined, "D-1"])("share SSR (%s)", (eid) => {
  it("returns rendered props on success", async () => {
    setShareFetchForTests(async (input) => ({ statusCode: 200, body: Buffer.from(JSON.stringify(input.path.includes("/entries/") ? entry : list)) }));
    const test = context(eid);
    const result = await loadSharePage(test.context);
    expect(test.res.statusCode).toBe(200);
    expect(result).toMatchObject({ props: { workspaceName: "Alpha", entries: list.entries } });
    if (eid) expect(result).toMatchObject({ props: { entry } });
  });

  it.each([401, 429, 500, 503])("sets a real HTTP 503 for hub status %i", async (statusCode) => {
    setShareFetchForTests(async () => ({ statusCode, body: Buffer.from("{}") }));
    const test = context(eid);
    expect(await loadSharePage(test.context)).toMatchObject({ props: { temporary: true } });
    expect(test.res.statusCode).toBe(503);
    expect(test.res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it.each([null, {}, { workspaceName: "Alpha", entries: [null] }, { workspaceName: "Alpha", entries: [{ id: "D-1", title: 42 }] }])("rejects a malformed list body (%j)", async (body) => {
    setShareFetchForTests(async (input) => ({ statusCode: 200, body: Buffer.from(JSON.stringify(input.path.includes("/entries/") ? entry : body)) }));
    const test = context(eid);
    expect(await loadSharePage(test.context)).toMatchObject({ props: { temporary: true } });
    expect(test.res.statusCode).toBe(503);
  });

  it("preserves the 404 path", async () => {
    setShareFetchForTests(async () => ({ statusCode: 404, body: Buffer.from("{}") }));
    expect(await loadSharePage(context(eid).context)).toEqual({ notFound: true });
  });

  it("accepts entries with no recorded basis or confirmation", async () => {
    const nullableEntry = { ...entry, basis: null, confirmedAt: null };
    const nullableList = { ...list, entries: [nullableEntry] };
    setShareFetchForTests(async (input) => ({ statusCode: 200, body: Buffer.from(JSON.stringify(input.path.includes("/entries/") ? nullableEntry : nullableList)) }));
    const test = context(eid);
    expect(await loadSharePage(test.context)).toMatchObject({ props: { entries: nullableList.entries } });
    expect(test.res.statusCode).toBe(200);
  });

  it("fails closed before contacting the hub in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEMA_SHARE_SOURCE_DEV", "1");
    const fetch = vi.fn();
    setShareFetchForTests(fetch);
    const test = context(eid);
    delete test.context.req.headers["x-nema-share-peer"];
    expect(await loadSharePage(test.context)).toEqual({ notFound: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});

it.each([null, {}, { ...entry, quotes: [null] }, { ...entry, workpackage: { taskCount: 1, blockedOn: null, tasks: [{ n: 1, title: "Task", status: "verified", inferred: "yes" }] } }])("returns 503 for a malformed entry (%j)", async (body) => {
  setShareFetchForTests(async (input) => ({ statusCode: 200, body: Buffer.from(JSON.stringify(input.path.includes("/entries/") ? body : list)) }));
  const test = context("D-1");
  expect(await loadSharePage(test.context)).toMatchObject({ props: { temporary: true } });
  expect(test.res.statusCode).toBe(503);
});
