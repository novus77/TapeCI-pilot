"use client";

import { useEffect, useState } from "react";

export interface SectionNavItem {
  readonly id: string;
  readonly label: string;
}

/**
 * In-page section rail for long settings pages.
 *
 * Uses scroll position rather than an IntersectionObserver: the observer's
 * trigger band made the highlight lag one section behind, and "which heading is
 * the last one above the fold" is exactly what a reader means by "where am I".
 * The rail is sticky on wide screens and scrolls away on narrow ones.
 */
export function SectionNav({ items, label }: { readonly items: readonly SectionNavItem[]; readonly label: string }) {
  const [active, setActive] = useState<string>(items[0]?.id ?? "");

  useEffect(() => {
    // Resolve the headings on every update rather than once: they are rendered by a
    // sibling server component, so on the first effect run they may not be in the
    // document yet, and a captured empty list would leave the rail frozen forever.
    const resolve = (): { id: string; element: HTMLElement }[] =>
      items
        .map((item) => ({ id: item.id, element: document.getElementById(item.id) }))
        .filter((entry): entry is { id: string; element: HTMLElement } => entry.element !== null);

    const update = (): void => {
      const targets = resolve();
      if (targets.length === 0) return;
      // At the bottom of the page the last sections can never reach the top, so
      // pick the last one whose heading is inside the viewport instead of
      // leaving the rail stuck on an earlier section.
      const atBottom =
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      if (atBottom) {
        let last = targets[0]?.id ?? "";
        for (const { id, element } of targets) {
          if (element.getBoundingClientRect().top < window.innerHeight) last = id;
        }
        setActive(last);
        return;
      }

      // The current section is the last heading that has passed the top.
      //
      // The probe must agree with `scroll-margin-top` on the headings: an anchor
      // click parks a heading at exactly that offset, so a smaller probe would
      // never count it and the rail would lag one section behind. Deriving it
      // from the computed style keeps the two from drifting apart again.
      const first = targets[0]?.element;
      const margin = first === undefined ? 0 : Number.parseFloat(getComputedStyle(first).scrollMarginTop) || 0;
      const probe = Math.max(margin, 1) + 1;

      // Two sections can share a row (the settings grid is two columns), so both
      // can be past the probe at once. Take the FIRST in document order that has
      // passed it: that is the one the reader scrolled past most recently, and it
      // keeps the rail stable instead of flickering between two headings at the
      // same offset.
      const passed = targets.filter(({ element }) => element.getBoundingClientRect().top <= probe);
      if (passed.length === 0) {
        setActive(targets[0]?.id ?? "");
        return;
      }
      // The current section is the heading CLOSEST to the probe from above, i.e. the
      // largest top that still satisfies `top <= probe`. Two sections can share a
      // row (the grid is two columns), in which case their tops are equal and the
      // first in document order wins.
      const deepest = passed.reduce<number>((max, { element }) => {
        const top = element.getBoundingClientRect().top;
        return Math.max(max, top);
      }, Number.NEGATIVE_INFINITY);
      const tied = passed.filter(({ element }) => Math.abs(element.getBoundingClientRect().top - deepest) < 2);
      setActive(tied[0]?.id ?? targets[0]?.id ?? "");
    };

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
    // Depend on the ids, not the array identity: callers build the items array
    // inline, so a new reference every render would tear down and rebuild the
    // listener continuously.
  }, [items.map((item) => item.id).join("|")]);

  return (
    <nav className="section-nav" aria-label={label}>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={active === item.id ? "true" : undefined}
              onClick={() => setActive(item.id)}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
