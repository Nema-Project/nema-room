import { afterEach, describe, expect, it, vi } from "vitest";

describe("managed desktop Next config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("ships images unoptimized and traces sharp out of the standalone build", async () => {
    vi.stubEnv("NEMA_MANAGED_LOCAL_BUILD", "1");
    vi.resetModules();
    const { default: config } = await import("../next.config");
    expect(config.output).toBe("standalone");
    expect(config.images).toEqual({ unoptimized: true });
    expect(config.outputFileTracingExcludes).toEqual({
      "*": ["node_modules/sharp/**", "node_modules/@img/**"],
    });
  });
});
