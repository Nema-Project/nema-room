"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import en from "../messages/en.json";
import ja from "../messages/ja.json";
import zh from "../messages/zh.json";

export type Locale = "en" | "ja" | "zh";
export const LOCALES: readonly Locale[] = ["en", "ja", "zh"];
export const LOCALE_STORAGE_KEY = "nema.locale";

export type Messages = Record<string, string>;
export type MessageSet = Record<Locale, Messages>;

const BUNDLED: MessageSet = { en, ja, zh };

const isLocale = (v: unknown): v is Locale => v === "en" || v === "ja" || v === "zh";

export function detectLocale(languages: readonly string[]): Locale {
  for (const raw of languages) {
    const l = raw.toLowerCase();
    if (l.startsWith("ja")) return "ja";
    if (l.startsWith("zh")) return "zh";
    if (l.startsWith("en")) return "en";
  }
  return "en";
}

type Ctx = { locale: Locale; setLocale: (l: Locale) => void; messages: MessageSet };
const I18nContext = createContext<Ctx>({ locale: "en", setLocale: () => {}, messages: BUNDLED });

export function I18nProvider({ children, messages = BUNDLED }: { children: ReactNode; messages?: Partial<Record<Locale, Messages>> }) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const full = useMemo<MessageSet>(() => ({ en: {}, ja: {}, zh: {}, ...messages }), [messages]);

  // The server renders "en"; the real locale is only known on the client (storage, then browser language).
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the server renders "en"; storage and navigator exist only after hydration
    setLocaleState(isLocale(stored) ? stored : detectLocale(navigator.languages?.length ? navigator.languages : [navigator.language ?? "en"]));
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, l);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const value = useMemo(() => ({ locale, setLocale, messages: full }), [locale, setLocale, full]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useLocale(): [Locale, (l: Locale) => void] {
  const { locale, setLocale } = useContext(I18nContext);
  return [locale, setLocale];
}

export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const { locale, messages } = useContext(I18nContext);
  return useCallback(
    (key, vars) => {
      const text = messages[locale][key] ?? messages.en[key] ?? key;
      return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
    },
    [locale, messages],
  );
}
