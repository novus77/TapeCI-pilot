"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";

import { useT } from "./locale-provider";
import type { NotificationRow } from "@/lib/types";

/** In-app attention inbox: pending approvals and failed/interrupted deployments. */
export function NotificationBell() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<readonly NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/notifications", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ notifications?: NotificationRow[]; unread?: number; error?: string }>)
      .then((body) => {
        if (cancelled) return;
        if (body.error !== undefined) setError(body.error);
        else {
          setRows(body.notifications ?? []);
          setUnread(body.unread ?? 0);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="notification-wrap">
      <button
        type="button"
        className="notification-button"
        aria-label={unread > 0 ? t("topbar.unread", { count: unread }) : t("topbar.notifications")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={15} aria-hidden="true" />
        {unread > 0 ? <span className="notification-badge">{unread}</span> : null}
      </button>
      {open ? (
        <div className="notification-panel" role="dialog" aria-label={t("topbar.notifications")}>
          <div className="notification-head">
            <p className="notification-title">{t("notify.needsAttention")}</p>
            {unread > 0 ? (
              <button
                type="button"
                className="button button-ghost"
                onClick={() => {
                  void fetch("/api/notifications/read", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ deploymentIds: [] }),
                  }).then(() => {
                    setRows((current) => current.map((row) => ({ ...row, readAt: row.readAt ?? new Date().toISOString() })));
                    setUnread(0);
                  });
                }}
              >
                {t("notify.markAll")}
              </button>
            ) : null}
          </div>
          {error === null ? null : <p className="field-hint">{error}</p>}
          {rows.length === 0 ? <p className="field-hint">{t("notify.nothing")}</p> : null}
          <ul className="notification-list">
            {rows.map((row) => (
              <li key={row.deploymentId} data-unread={row.readAt === null ? "true" : undefined}>
                <Link href={`/deployments/${row.deploymentId}`} onClick={() => setOpen(false)}>
                  <strong>{row.repoFullName}</strong>
                  <span>{row.state.replaceAll("_", " ").toLowerCase()}</span>
                  <code>{row.commitSha.slice(0, 8)}</code>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
