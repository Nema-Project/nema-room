import { describe, expect, it } from "vitest";
import { validateLaunchUrl } from "../src/browser.js";

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
