import { describe, expect, it } from "vitest";
import { LOCALES, messages, parseLocale, translate } from "../../apps/web/lib/i18n.js";

describe("i18n dictionary", () => {
  it("has exactly the same keys in every locale", () => {
    const base = Object.keys(messages.en).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(messages[locale]).sort(), locale).toEqual(base);
    }
  });

  it("has no empty strings", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(messages[locale])) {
        expect(value.trim().length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("translates and interpolates variables", () => {
    expect(translate("en", "topbar.signedInAs", { login: "novus77" })).toBe("Signed in as novus77");
    expect(translate("zh", "topbar.signedInAs", { login: "novus77" })).toBe("已登录：novus77");
    expect(translate("zh", "topbar.unread", { count: 3 })).toContain("3");
  });

  it("keeps unknown placeholders visible instead of printing undefined", () => {
    expect(translate("en", "topbar.signedInAs", {})).toBe("Signed in as {login}");
  });

  it("parses only supported locales", () => {
    expect(parseLocale("zh")).toBe("zh");
    expect(parseLocale("en")).toBe("en");
    expect(parseLocale("fr")).toBe("en");
    expect(parseLocale(undefined)).toBe("en");
  });
});
