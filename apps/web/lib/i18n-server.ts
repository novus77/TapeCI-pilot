import { translate, type Locale, type MessageKey } from "./i18n";
import { getLocale } from "./locale-server";

export type ServerT = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Server-component translator: reads the locale cookie once per request. */
export async function getServerT(): Promise<{ locale: Locale; t: ServerT }> {
  const locale = await getLocale();
  return { locale, t: (key, vars) => translate(locale, key, vars) };
}
