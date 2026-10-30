import { expect, test } from "vitest";
import { isCheckTime } from "../src/extensions.js";

test("a check time is an ISO 8601 UTC instant that names a real calendar date", () => {
  expect(isCheckTime("2026-10-30T03:00:00.000Z")).toBe(true);
  expect(isCheckTime("2024-02-29T23:59:59.999Z")).toBe(true);
  for (const value of ["2026-02-30T00:00:00.000Z", "2025-02-29T00:00:00.000Z", "2026-04-31T00:00:00.000Z", "2026-10-30T24:00:00.000Z", "2026-10-30T03:60:00.000Z", "yesterday", "2026-10-30", 7, null, undefined]) {
    expect(isCheckTime(value), String(value)).toBe(false);
  }
});
