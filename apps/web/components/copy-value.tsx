"use client";

import { FeedbackButton } from "./motion-feedback";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

interface CopyValueProps {
  readonly value: string;
  readonly label: string;
  readonly display?: string;
  /** Optional explorer link (X Layer OKLink). */
  readonly href?: string;
}

/** Monospace value with copy-to-clipboard and an optional block-explorer link. */
export function CopyValue({ value, label, display, href }: CopyValueProps) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const text = display === "" ? null : <code className="mono">{display ?? value}</code>;

  return (
    <span className="copy-value">
      {href === undefined ? (
        <span title={value}>{text}</span>
      ) : (
        <a href={href} target="_blank" rel="noreferrer noopener" title={`Open ${label} in X Layer explorer`}>
          {text}
        </a>
      )}
      <FeedbackButton
        feedbackKey={copied ? "copied" : "copy"}
        type="button"
        className="copy-button"
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        onClick={() => {
          void copy();
        }}
      >
        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        <span className="visually-hidden" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </FeedbackButton>
    </span>
  );
}
