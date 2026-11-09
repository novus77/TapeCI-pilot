"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Mobile navigation drawer.
 *
 * Below 860px the sidebar used to be a horizontally scrolling strip, which hid
 * destinations past the fold with no affordance. It now opens as a drawer:
 * focus moves in, Escape and the overlay close it, focus returns to the trigger,
 * and it is untouched by Tab while closed.
 *
 * The drawer content is the caller's existing nav markup — this component only
 * owns the mechanics, so the link list is never duplicated.
 */
export function NavDrawer({
  labels,
  children,
}: {
  readonly labels: { readonly open: string; readonly close: string; readonly title: string };
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // A client-side navigation does not unmount this component, so the drawer would
  // stay open over the new page. Close it whenever the route changes.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const focusable = panel.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    // The page behind the drawer must not scroll.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="nav-drawer-trigger"
        aria-expanded={open}
        aria-controls="nav-drawer"
        onClick={() => setOpen(true)}
      >
        <span className="nav-drawer-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
          </svg>
        </span>
        <span className="visually-hidden">{labels.open}</span>
      </button>

      {open ? (
        <div className="nav-drawer-layer">
          <button
            type="button"
            className="nav-drawer-overlay"
            aria-label={labels.close}
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus();
            }}
          />
          <div
            id="nav-drawer"
            ref={panelRef}
            className="nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={labels.title}
          >
            <div className="nav-drawer-head">
              <p className="nav-drawer-title">{labels.title}</p>
              <button
                type="button"
                className="nav-drawer-close"
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <span aria-hidden="true">×</span>
                <span className="visually-hidden">{labels.close}</span>
              </button>
            </div>
            <div onClick={() => setOpen(false)}>{children}</div>
          </div>
        </div>
      ) : null}
    </>
  );
}
