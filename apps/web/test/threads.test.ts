import { afterEach, describe, expect, it, vi } from "vitest";
import { openThread, threadUrl } from "@/lib/threads";

describe("openThread", () => {
  afterEach(() => { delete (window as Window & { nemaWindowControls?: unknown }).nemaWindowControls; vi.restoreAllMocks(); });
  it("uses window.open on desktop", () => {
    Object.defineProperty(window, "nemaWindowControls", { configurable: true, value: {} });
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const host = { open: vi.fn() };
    openThread("w 1", "t/2", host);
    expect(opened).toHaveBeenCalledWith(threadUrl("w 1", "t/2"), "_blank");
    expect(host.open).not.toHaveBeenCalled();
  });
  it("uses the floating host on web", () => {
    const host = { open: vi.fn() };
    openThread("w1", "t1", host);
    expect(host.open).toHaveBeenCalledWith("w1", "t1");
  });
});
