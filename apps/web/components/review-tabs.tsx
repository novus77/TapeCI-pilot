"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";

/** Links, rather than local-only tabs, retain deep links and browser history. */
export function ReviewTabs({ items, label }: {
  readonly items: readonly { readonly href: string; readonly label: string; readonly active?: boolean }[];
  readonly label: string;
}) {
  const id = useId();
  const reduce = useReducedMotion();
  const [hash, setHash] = useState("");
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return <nav className="section-nav review-tabs" aria-label={label}>
    {items.map(item => {
      const active = item.active ?? (item.href.startsWith("#") && item.href === hash);
      return <Link key={item.href} href={item.href} aria-current={active ? item.href.startsWith("#") ? "location" : "page" : undefined} onClick={() => { if (item.href.startsWith("#")) setHash(item.href); }}>
        {item.label}
        {active ? <motion.span className="tab-indicator" layoutId={`review-tab-${id}`} transition={{ duration: reduce ? 0 : .18, ease: "easeOut" }} aria-hidden="true" /> : null}
      </Link>;
    })}
  </nav>;
}
