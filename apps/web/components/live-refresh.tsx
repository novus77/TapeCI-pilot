"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useT } from "./locale-provider";

/** Subscribe to /api/events and refresh the server-rendered page on changes. */
export function LiveRefresh({ active }: { readonly active: boolean }) {
  const router = useRouter();
  const { t } = useT();
  const lastRefresh = useRef(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!active) return;
    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = () => {
      const now = Date.now();
      if (now - lastRefresh.current < 2_000) return;
      lastRefresh.current = now;
      router.refresh();
    };
    return () => {
      source.close();
      setConnected(false);
    };
  }, [active, router]);

  if (!active) return null;
  return (
    <span className="auto-refresh" role="status" aria-live="polite">
      <span className="auto-refresh-dot" aria-hidden="true" />
      {connected ? t("console.liveConnected") : t("console.liveReconnecting")}
    </span>
  );
}
