import { formatUtcDateTime, summarizePayload } from "@/lib/format";
import { getServerT } from "@/lib/i18n-server";
import type { DeploymentEvent } from "@/lib/types";

import { EmptyState } from "./risk-notice";

/**
 * Ordered audit trail from `deployment_events`. Rendered as a semantic list so
 * screen readers announce event order.
 */
export async function EventTimeline({ events }: { readonly events: readonly DeploymentEvent[] }) {
  const { t } = await getServerT();
  if (events.length === 0) {
    return (
      <EmptyState
        title={t("timeline.empty")}
        message={t("console.timelineEmptyBody")}
      />
    );
  }
  return (
    <ol className="timeline" data-testid="event-timeline">
      {events.map((event) => {
        const summary = summarizePayload(event.payload);
        const transition =
          event.oldState === null
            ? event.newState === null
              ? t("console.noStateChange")
              : `→ ${t(`state.${event.newState}`)}`
            : event.newState === null
              ? `${t(`state.${event.oldState}`)} →`
              : `${t(`state.${event.oldState}`)} → ${t(`state.${event.newState}`)}`;
        return (
          <li key={event.id} className="timeline-item">
            <span className="timeline-marker" aria-hidden="true" />
            <div className="timeline-content">
              <div className="timeline-head">
                <code className="timeline-type">{event.eventType}</code>
                <time dateTime={event.createdAt}>{formatUtcDateTime(event.createdAt)}</time>
              </div>
              <p className="timeline-transition">{transition}</p>
              <p className="timeline-actor">
                {t("audit.actor")}: {event.actorKind}
                {event.actorId === null ? "" : ` (${event.actorId})`}
              </p>
              {summary.length === 0 ? null : <p className="timeline-detail mono">{summary}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
