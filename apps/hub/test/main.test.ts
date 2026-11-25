import { expect, test } from "vitest";
import { parseAllowedHosts, resolvePublicHubUrl } from "../src/main.js";

test("resolvePublicHubUrl ignores the remote-only value when remote auth is off", () => {
  // A schemeless value must not fail local startup.
  expect(resolvePublicHubUrl(false, "hub.example.lan")).toBeUndefined();
  expect(resolvePublicHubUrl(false, "https://hub.example.lan")).toBeUndefined();
  expect(resolvePublicHubUrl(false, undefined)).toBeUndefined();
});

test("resolvePublicHubUrl still rejects an invalid value when remote auth is on", () => {
  expect(() => resolvePublicHubUrl(true, "hub.example.lan")).toThrow(/NEMA_HUB_PUBLIC_URL/);
  expect(resolvePublicHubUrl(true, "https://hub.example.lan")).toBe("https://hub.example.lan");
  expect(resolvePublicHubUrl(true, "")).toBeUndefined();
  expect(resolvePublicHubUrl(true, undefined)).toBeUndefined();
});

test("parseAllowedHosts splits on commas, trims, and drops empties", () => {
  expect(parseAllowedHosts(undefined)).toEqual([]);
  expect(parseAllowedHosts("")).toEqual([]);
});
