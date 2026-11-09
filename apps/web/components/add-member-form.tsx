"use client";

import { useEffect, useRef, useState } from "react";

import { useT } from "./locale-provider";

interface Suggestion {
  readonly id: string;
  readonly githubLogin: string;
}

/**
 * Add-member form with a login picker.
 *
 * A bare text field made the user guess an exact GitHub login; the API now answers
 * `/v1/users?q=`, so this offers matches while still accepting a typed login
 * verbatim (the form submits the text either way).
 *
 * Suggestions come from a request per keystroke burst, not per key: the timer keeps
 * a fast typist from firing a request for every character.
 */
export function AddMemberForm({
  action,
  roles,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly roles: readonly { readonly value: string; readonly label: string }[];
}) {
  const { t } = useT();
  const [login, setLogin] = useState("");
  const [suggestions, setSuggestions] = useState<readonly Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    const term = login.trim();
    if (term.length < 2) {
      setSuggestions([]);
      return;
    }
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/users?q=${encodeURIComponent(term)}`);
          if (!response.ok) return;
          const body = (await response.json()) as { users?: Suggestion[] };
          setSuggestions(Array.isArray(body.users) ? body.users.slice(0, 8) : []);
        } catch {
          // A failed suggestion lookup must not block typing a login by hand.
          setSuggestions([]);
        }
      })();
    }, 250);
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [login]);

  return (
    <form className="filter-form" action={action}>
      <div className="field member-picker">
        <label htmlFor="org-login">{t("org.githubLogin")}</label>
        <input
          id="org-login"
          name="githubLogin"
          value={login}
          required
          autoComplete="off"
          role="combobox"
          aria-expanded={open && suggestions.length > 0}
          aria-controls="member-picker-list"
          aria-autocomplete="list"
          onChange={(event) => {
            setLogin(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        />
        {open && suggestions.length > 0 ? (
          <ul className="member-picker-list" id="member-picker-list" role="listbox">
            {suggestions.map((suggestion) => (
              <li key={suggestion.id} role="option" aria-selected={suggestion.githubLogin === login}>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    // mousedown, not click: blur fires first and would close the list.
                    event.preventDefault();
                    setLogin(suggestion.githubLogin);
                    setOpen(false);
                  }}
                >
                  {suggestion.githubLogin}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="org-role">{t("org.role")}</label>
        <select id="org-role" name="role" defaultValue="member">
          {roles.map((role) => (
            <option key={role.value} value={role.value}>
              {role.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="org-expires">{t("members.expiresOn")}</label>
        <input id="org-expires" name="expiresAt" type="date" />
      </div>
      <div className="filter-actions">
        <button className="button button-primary" type="submit">
          {t("org.addMember")}
        </button>
      </div>
    </form>
  );
}
