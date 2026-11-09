"use client";

import { createContext, useContext, type ReactNode } from "react";

import { DEFAULT_LOCALE, translate, type Locale, type MessageKey } from "@/lib/i18n";

interface LocaleContextValue {
  readonly locale: Locale;
  readonly t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  t: (key, vars) => translate(DEFAULT_LOCALE, key, vars),
});

/** Server layout passes the cookie locale; client components read it through `useT`. */
export function LocaleProvider({
  locale,
  children,
}: {
  readonly locale: Locale;
  readonly children: ReactNode;
}) {
  return (
    <LocaleContext.Provider value={{ locale, t: (key, vars) => translate(locale, key, vars) }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useT(): LocaleContextValue {
  return useContext(LocaleContext);
}
