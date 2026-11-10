import { afterEach, describe, expect, it } from "vitest";
import { fetchShare, setShareFetchForTests, type ShareFetch } from "@/lib/shareHub";

const token = "a".repeat(43);
const previous = process.env.NEMA_HUB_INTERNAL_URL;

afterEach(() => {
  setShareFetchForTests(undefined);
  if (previous === undefined) delete process.env.NEMA_HUB_INTERNAL_URL;
  else process.env.NEMA_HUB_INTERNAL_URL = previous;
});

describe("share hub fetch", () => {
  it("requests the compose hub name with a loopback Host and no credentials", async () => {
    process.env.NEMA_HUB_INTERNAL_URL = "http://hub:4400";
    const seen: Parameters<ShareFetch>[0][] = [];
    setShareFetchForTests(async (input) => {
      seen.push(input);
      return { statusCode: 200, body: Buffer.from(JSON.stringify({ workspaceName: "Alpha", entries: [] })) };
    });
    const result = await fetchShare("list", token);
    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ hostname: "hub", port: 4400, path: `/share/${token}` });
    expect(seen[0]?.headers.host).toBe("127.0.0.1:4400");
    expect(seen[0]?.headers.cookie).toBeUndefined();
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("does not connect to a public or https hub URL", async () => {
    let calls = 0;
    setShareFetchForTests(async () => {
      calls += 1;
      return { statusCode: 200, body: Buffer.from("{}") };
    });
    for (const url of ["http://evil.example:4400", "https://hub:4400"]) {
      process.env.NEMA_HUB_INTERNAL_URL = url;
      const result = await fetchShare("list", token);
      expect(result.status).toBe(503);
    }
    expect(calls).toBe(0);
  });

  it("does not connect when the token is the wrong shape", async () => {
    process.env.NEMA_HUB_INTERNAL_URL = "http://127.0.0.1:4400";
    let calls = 0;
    setShareFetchForTests(async () => {
      calls += 1;
      return { statusCode: 200, body: Buffer.from("{}") };
    });
    expect((await fetchShare("list", `${token}/extra`)).status).toBe(404);
    expect((await fetchShare("list", "short")).status).toBe(404);
    expect(calls).toBe(0);
  });

  it("treats a body over 2 MiB as unavailable", async () => {
    process.env.NEMA_HUB_INTERNAL_URL = "http://127.0.0.1:4400";
    setShareFetchForTests(async () => ({ statusCode: 200, body: Buffer.alloc(2 * 1024 * 1024 + 1) }));
    expect((await fetchShare("list", token)).status).toBe(503);
  });
});
