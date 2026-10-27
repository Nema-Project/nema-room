import { afterEach, describe, expect, test, vi } from "vitest";
import { runtimeHubUrl } from "../lib/runtimeHubUrl";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runtimeHubUrl", () => {
  test("defaults to the published loopback origin", () => {
    vi.stubEnv("NEMA_HUB_URL", "");
    vi.stubEnv("NEXT_PUBLIC_HUB_URL", "");
    expect(runtimeHubUrl()).toBe("http://127.0.0.1:4400");
  });

  test("reads NEMA_HUB_URL at call time and keeps only the origin", () => {
    vi.stubEnv("NEMA_HUB_URL", "http://127.0.0.1:4410/ignored");
    expect(runtimeHubUrl()).toBe("http://127.0.0.1:4410");
  });

  test("rejects non-http values and credentials", () => {
    vi.stubEnv("NEMA_HUB_URL", "javascript:alert(1)");
    expect(runtimeHubUrl()).toBe("http://127.0.0.1:4400");
    vi.stubEnv("NEMA_HUB_URL", "http://user:pass@127.0.0.1:4400");
    expect(runtimeHubUrl()).toBe("http://127.0.0.1:4400");
  });
});
