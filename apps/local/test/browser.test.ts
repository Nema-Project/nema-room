import { describe, expect, it } from "vitest";
import { parseBrowserArgs, validateLaunchUrl } from "../src/browser.js";

describe("managed browser launch URL", () => {
  it("accepts only an authenticated loopback launch ticket URL", () => {
    expect(validateLaunchUrl("http://127.0.0.1:44001/_nema/launch?ticket=" + "a".repeat(64))).toBe(true);
  });

  it.each([
    "https://127.0.0.1:44001/_nema/launch?ticket=" + "a".repeat(64),
    "http://localhost:44001/_nema/launch?ticket=" + "a".repeat(64),
    "http://127.0.0.1:44001/other?ticket=" + "a".repeat(64),
    "http://127.0.0.1:44001/_nema/launch?ticket=not-a-ticket",
    "http://127.0.0.1:44001/_nema/launch?ticket=" + "a".repeat(64) + "&url=https://example.com",
  ])("rejects an untrusted launch URL: %s", (url) => {
    expect(() => validateLaunchUrl(url)).toThrow(/verified loopback launch URL/i);
  });
});

describe("managed browser launcher options", () => {
  it("accepts exactly one assets directory with an optional quit operation", () => {
    expect(parseBrowserArgs(["--assetsDir", "C:/Nema/resources/payload", "--quit"])).toEqual({
      assetsDir: "C:/Nema/resources/payload", noOpen: false, quit: true,
    });
  });

  it.each([
    { args: ["--quit"] },
    { args: ["--assetsDir", "payload", "--assetsDir", "other"] },
    { args: ["--assetsDir", "payload", "--quit", "--quit"] },
    { args: ["--assetsDir", "payload", "--unknown"] },
  ])("rejects unsupported or duplicate options: %o", ({ args }) => {
    expect(() => parseBrowserArgs(args)).toThrow(/usage/i);
  });
});
