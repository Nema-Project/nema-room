import { describe, expect, test, vi } from "vitest";
import { compareSemver, fetchLatestRelease, LATEST_RELEASE_URL, parseSemver, releaseOffer } from "../src/releaseCheck.js";

function release(tag: string, extra: Record<string, unknown> = {}) {
  return { tag_name: tag, draft: false, prerelease: false, ...extra };
}

describe("compareSemver", () => {
  test("orders stable versions, prereleases, and equal strings", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3+build.4", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("1.3.0", "1.2.9")).toBe(1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.beta", "1.0.0-beta")).toBe(-1);
    expect(compareSemver("1.0.0-beta", "1.0.0-beta.2")).toBe(-1);
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
    expect(compareSemver("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
  });

  test("returns null for malformed versions", () => {
    for (const value of ["", "1.2", "1.2.3.4", "latest", "01.2.3", "1.02.3", "1.2.03", "v", "1.2.3-"]) {
      expect(parseSemver(value)).toBeNull();
      expect(compareSemver(value, "1.2.3")).toBeNull();
      expect(compareSemver("1.2.3", value)).toBeNull();
    }
  });
});

describe("releaseOffer", () => {
  test("offers only a newer stable tag and builds the release page itself", () => {
    expect(releaseOffer("0.1.3", release("v0.2.0", { html_url: "https://evil.example/drop" }))).toEqual({
      version: "0.2.0",
      tag: "v0.2.0",
      url: "https://github.com/Nema-Project/nema-room/releases/tag/v0.2.0",
    });
    expect(releaseOffer("0.2.0", release("v0.2.0"))).toBeNull();
    expect(releaseOffer("0.2.1", release("v0.2.0"))).toBeNull();
    expect(releaseOffer("0.1.3", release("v0.2.0", { draft: true }))).toBeNull();
    expect(releaseOffer("0.1.3", release("v0.2.0", { prerelease: true }))).toBeNull();
    expect(releaseOffer("0.1.3", release("v9.0.0-rc.1"))).toBeNull();
    expect(releaseOffer("0.1.3", release("latest"))).toBeNull();
    expect(releaseOffer("0.1.3", release("not a version"))).toBeNull();
    expect(releaseOffer("nope", release("v0.2.0"))).toBeNull();
    expect(releaseOffer("0.1.3", null)).toBeNull();
  });
});

describe("fetchLatestRelease", () => {
  test("returns a newer stable release and sends no credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(release("v0.2.0")), { status: 200 }));
    const result = await fetchLatestRelease("0.1.3", { enabled: true, fetchImpl });
    expect(result).toEqual({
      state: "newer",
      offer: { version: "0.2.0", tag: "v0.2.0", url: "https://github.com/Nema-Project/nema-room/releases/tag/v0.2.0" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LATEST_RELEASE_URL);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("user-agent")).toBe("Nema-Room");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("reports current for an older release and error for a failed response", async () => {
    const older = vi.fn(async () => new Response(JSON.stringify(release("v0.1.0")), { status: 200 }));
    expect(await fetchLatestRelease("0.1.3", { enabled: true, fetchImpl: older })).toEqual({ state: "current" });
    const failed = vi.fn(async () => new Response("no", { status: 403 }));
    expect(await fetchLatestRelease("0.1.3", { enabled: true, fetchImpl: failed })).toEqual({ state: "error" });
    const thrown = vi.fn(async () => { throw new Error("offline"); });
    expect(await fetchLatestRelease("0.1.3", { enabled: true, fetchImpl: thrown })).toEqual({ state: "error" });
  });

  test("turns a timeout into a silent error", async () => {
    const fetchImpl: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    await expect(fetchLatestRelease("0.1.3", { enabled: true, fetchImpl, timeoutMs: 5 })).resolves.toEqual({ state: "error" });
  });

  test("does not fetch when automatic checks are disabled, unless the check is manual", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await fetchLatestRelease("0.1.3", { enabled: false, fetchImpl })).toEqual({ state: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(release("v0.2.0")), { status: 200 }));
    expect(await fetchLatestRelease("0.1.3", { enabled: false, manual: true, fetchImpl })).toMatchObject({ state: "newer" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
