import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { severityLabel } from "@/lib/format";

export type NoticeTone = "info" | "warning" | "critical" | "success";

/**
 * Risk notices always carry a severity word and a title; colour is only a
 * secondary cue. Critical notices are announced as alerts.
 */
export function RiskNotice({
  tone,
  title,
  children,
}: {
  readonly tone: NoticeTone;
  readonly title: string;
  readonly children?: ReactNode;
}) {
  const Icon = tone === "critical" ? CircleAlert : tone === "warning" ? TriangleAlert : tone === "success" ? CircleCheck : Info;
  return (
    <div
      className={`notice notice-${tone}`}
      data-tone={tone}
      role={tone === "critical" ? "alert" : "note"}
    >
      <span className="notice-symbol" aria-hidden="true">
        <Icon size={17} strokeWidth={1.7} />
      </span>
      <div className="notice-content">
        <p className="notice-title">
          <span className="notice-severity">{severityLabel(tone)}</span> {title}
        </p>
        {children === undefined ? null : <div className="notice-body">{children}</div>}
      </div>
    </div>
  );
}

/**
 * Empty state with a line illustration.
 *
 * The drawing is inline SVG using `currentColor`, so it inherits the text colour in
 * both themes and costs no request. It depicts an empty shelf of records rather than
 * the usual rounded-square icon tile, which is one of the tells the design rules
 * warn about.
 */
export function EmptyState({ title, message }: { readonly title: string; readonly message: string }) {
  return (
    <div className="empty-state">
      <svg
        className="empty-art"
        viewBox="0 0 120 64"
        role="presentation"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* Two stacked, empty record rows on a baseline. */}
        <rect x="18" y="12" width="84" height="14" rx="3" opacity="0.55" />
        <rect x="18" y="32" width="84" height="14" rx="3" opacity="0.35" strokeDasharray="4 4" />
        <path d="M12 54h96" opacity="0.5" />
        <path d="M30 19h28M30 39h20" opacity="0.45" />
      </svg>
      <p className="empty-title">{title}</p>
      <p className="empty-copy">{message}</p>
    </div>
  );
}
