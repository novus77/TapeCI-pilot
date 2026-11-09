import { cookies } from "next/headers";

import { LOCALE_COOKIE, parseLocale, type Locale } from "./i18n";

/** Read the locale cookie on the server (layout, server components, metadata). */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  return parseLocale(store.get(LOCALE_COOKIE)?.value);
}
