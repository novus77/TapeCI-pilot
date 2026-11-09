"use client";

import { useEffect } from "react";

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * `/` focuses the top-bar search field, `Escape` blurs it.
 *
 * Deliberately conservative: it does nothing while the user is typing in a field,
 * nothing with a modifier held (so `/` stays usable in every browser shortcut),
 * and nothing when a dialog is open.
 */
export function SearchShortcut() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const commandSearch = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !event.altKey;
      if ((event.metaKey || event.ctrlKey || event.altKey) && !commandSearch) return;
      const target = event.target as HTMLElement | null;
      const input = document.querySelector<HTMLInputElement>("[data-console-search] input");

      // Escape releases the search field even though focus is inside an input, so
      // this check must come before the editable bail-out.
      if (event.key === "Escape" && input !== null && document.activeElement === input) {
        event.preventDefault();
        input.blur();
        return;
      }

      if (target !== null) {
        if (!commandSearch && (EDITABLE.has(target.tagName) || target.isContentEditable)) return;
      }
      // A drawer or dialog owns the keyboard while it is open.
      if (document.querySelector('[role="dialog"][aria-modal="true"]') !== null) return;

      if (input === null) return;

      if (event.key === "/" || commandSearch) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return null;
}
