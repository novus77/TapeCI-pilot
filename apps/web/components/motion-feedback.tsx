"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useFormStatus } from "react-dom";
import type { ComponentProps, ReactNode } from "react";

/** Leaf-only motion adapters; status and action eligibility remain owned by callers. */
export function MotionBadge({ label, symbol, ...props }: ComponentProps<"span"> & {
  readonly label: string;
  readonly symbol: ReactNode;
}) {
  const reduce = useReducedMotion();
  return <span {...props}>
    <AnimatePresence initial={false} mode="wait">
      <motion.span className="badge-content" key={label} initial={reduce ? false : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -3 }} transition={{ duration: reduce ? 0 : .14 }}>
        <span className="badge-symbol" aria-hidden="true">{symbol}</span>
        <span className="badge-label">{label}</span>
      </motion.span>
    </AnimatePresence>
  </span>;
}

export function FeedbackButton({ busy = false, pendingLabel, children, disabled, type = "button", className = "button", feedbackKey, ...props }: ComponentProps<"button"> & {
  readonly busy?: boolean;
  readonly pendingLabel?: string;
  readonly feedbackKey?: string;
}) {
  const form = useFormStatus();
  const reduce = useReducedMotion();
  const pending = busy || (type === "submit" && form.pending);
  const content = pending && pendingLabel !== undefined ? pendingLabel : children;
  const key = feedbackKey ?? (typeof content === "string" ? content : String(pending));
  return <button {...props} type={type} className={`${className} feedback-button`} disabled={disabled || pending} aria-busy={pending || undefined}>
    {pending ? <span className="button-spinner" aria-hidden="true" /> : null}
    <AnimatePresence initial={false} mode="wait">
      <motion.span className="button-label" key={key} initial={reduce ? false : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={reduce ? undefined : { opacity: 0, y: -3 }} transition={{ duration: reduce ? 0 : .12 }}>{content}</motion.span>
    </AnimatePresence>
  </button>;
}
