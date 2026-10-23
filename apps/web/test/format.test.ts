import { describe, expect, it } from "vitest";
import { formatDay, formatTime, type Locale } from "@/lib/format";

const d = new Date("2026-10-21T05:00:00Z");
const tags: Record<Locale, string> = { zh: "zh-CN", ja: "ja-JP", en: "en-US" };

describe("format", () => {
  for (const l of ["ja", "zh", "en"] as const) {
    it(`formatDay ${l}`, () => {
      expect(formatDay(d, l)).toBe(new Intl.DateTimeFormat(tags[l], { month: "long", day: "numeric", weekday: "short" }).format(d));
    });
    it(`formatTime ${l}`, () => {
      expect(formatTime(d, l)).toBe(new Intl.DateTimeFormat(tags[l], { hour: "2-digit", minute: "2-digit" }).format(d));
    });
  }
});
