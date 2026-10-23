import type { Locale } from "./i18n";

export type { Locale };

const TAGS: Record<Locale, string> = { zh: "zh-CN", ja: "ja-JP", en: "en-US" };

export function formatDay(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(TAGS[locale], { month: "long", day: "numeric", weekday: "short" }).format(date);
}

export function formatTime(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(TAGS[locale], { hour: "2-digit", minute: "2-digit" }).format(date);
}
