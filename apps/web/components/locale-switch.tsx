"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { useT } from "./locale-provider";
import { LOCALE_COOKIE, LOCALES, type Locale } from "@/lib/i18n";

/**
 * Cookie-backed switch: the server re-renders with the new locale, so there is no
 * client-only translation state to drift from the rendered HTML.
 */
export function LocaleSwitch() {
  const { locale, t } = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function select(next: Locale): void {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    startTransition(() => router.refresh());
  }

  return (
    <div className="locale-switch" role="group" aria-label={t("topbar.locale")}>
      {LOCALES.map((candidate) => (
        <button
          key={candidate}
          type="button"
          className={`locale-option${candidate === locale ? " is-active" : ""}`}
          aria-pressed={candidate === locale}
          disabled={pending}
          onClick={() => select(candidate)}
        >
          <span className="locale-full">{t(candidate === "en" ? "topbar.locale.en" : "topbar.locale.zh")}</span>
          {/* Not aria-hidden: below 640px `.locale-full` is display:none, and an
              aria-hidden short label would leave the button with no accessible
              name at all (axe button-name). The short text is the visible label
              in that band, so it must stay in the a11y tree. */}
          <span className="locale-short">{candidate === "en" ? "EN" : "中"}</span>
        </button>
      ))}
    </div>
  );
}
