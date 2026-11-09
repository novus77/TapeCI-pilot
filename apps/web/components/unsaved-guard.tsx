"use client";

import { useEffect } from "react";

/**
 * Warns before leaving a form with unsaved edits. Listens for `input` events on
 * the wrapped form rather than diffing values, so a re-typed identical value also
 * counts as dirty — refusing to save is the user's choice, not ours to guess.
 */
export function UnsavedGuard({ formSelector }: { readonly formSelector: string }) {
  useEffect(() => {
    let dirty = false;
    const forms = Array.from(document.querySelectorAll<HTMLFormElement>(formSelector));
    if (forms.length === 0) return;

    const markDirty = (): void => {
      dirty = true;
    };
    const clear = (): void => {
      dirty = false;
    };

    for (const form of forms) {
      form.addEventListener("input", markDirty);
      form.addEventListener("submit", clear);
    }
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirty) return;
      // Browsers ignore custom text and show their own prompt; returning a value
      // is what triggers it.
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      for (const form of forms) {
        form.removeEventListener("input", markDirty);
        form.removeEventListener("submit", clear);
      }
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [formSelector]);

  return null;
}
