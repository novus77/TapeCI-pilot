import Link from "next/link";

import { formatUtcDateTime, shortValue } from "@/lib/format";
import { translate, type Locale } from "@/lib/i18n";
import { deploymentStage, triggerLabel } from "@/lib/states";
import type { DeploymentSummary } from "@/lib/types";

import { StageBadge, StateChip } from "./stage-badge";
import { EmptyState } from "./risk-notice";

/**
 * Localized copy for the shared table. The prop is optional and every field
 * falls back to the current English string, so callers that do not pass labels
 * (the project and container pages) render exactly what they render today.
 */
export interface DeploymentTableLabels {
  readonly project: string;
  readonly commit: string;
  readonly state: string;
  readonly trigger: string;
  readonly requested: string;
  readonly open: string;
  readonly region: string;
  readonly emptyTitle: string;
  readonly emptyBody: string;
}

const DEFAULT_LABELS: DeploymentTableLabels = {
  project: "Project",
  commit: "Commit",
  state: "State",
  trigger: "Trigger",
  requested: "Requested",
  open: "Open",
  region: "Deployments table",
  emptyTitle: "No deployments",
  emptyBody:
    "No deployment matches this view yet. A new deployment appears after a push to the configured branch.",
};

function resolveLabels(labels?: Partial<DeploymentTableLabels>): DeploymentTableLabels {
  return {
    project: labels?.project ?? DEFAULT_LABELS.project,
    commit: labels?.commit ?? DEFAULT_LABELS.commit,
    state: labels?.state ?? DEFAULT_LABELS.state,
    trigger: labels?.trigger ?? DEFAULT_LABELS.trigger,
    requested: labels?.requested ?? DEFAULT_LABELS.requested,
    open: labels?.open ?? DEFAULT_LABELS.open,
    region: labels?.region ?? DEFAULT_LABELS.region,
    emptyTitle: labels?.emptyTitle ?? DEFAULT_LABELS.emptyTitle,
    emptyBody: labels?.emptyBody ?? DEFAULT_LABELS.emptyBody,
  };
}

type SortKey = "requestedAt" | "state" | "project";

export interface DeploymentSort {
  readonly key: SortKey;
  readonly dir: "asc" | "desc";
  /** Builds the href for a given key/dir, preserving the other query params. */
  readonly href: (key: SortKey, dir: "asc" | "desc") => string;
}

export function DeploymentTable({
  deployments,
  caption,
  showProject = true,
  labels,
  locale = "en",
  sort,
  outOfRange = false,
}: {
  readonly deployments: readonly DeploymentSummary[];
  readonly caption: string;
  readonly showProject?: boolean;
  readonly labels?: Partial<DeploymentTableLabels>;
  /** Optional locale for the human state label; the raw enum stays in `.state-chip`. */
  readonly locale?: Locale;
  readonly sort?: DeploymentSort;
  /** True when the requested page is past the end: an empty page is not an empty project. */
  readonly outOfRange?: boolean;
}) {
  const text = resolveLabels(labels);
  if (deployments.length === 0) {
    // A page past the end is not "no deployments"; the pager explains it instead.
    if (outOfRange) return null;
    return <EmptyState title={text.emptyTitle} message={text.emptyBody} />;
  }
  return (
    <div className="table-wrap" role="region" aria-label={text.region} tabIndex={0}>
      {/* At <=720px the same rows render as cards (see globals.css). The markup stays
          a table so the accessible structure and every test selector are unchanged;
          CSS reflows the cells and reveals the per-cell labels. */}
      <table className="table table-responsive" data-testid="deployment-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {showProject ? <SortHeader label={text.project} sortKey="project" sort={sort} /> : null}
            <th scope="col">{text.commit}</th>
            <SortHeader label={text.state} sortKey="state" sort={sort} />
            <th scope="col">{text.trigger}</th>
            <SortHeader label={text.requested} sortKey="requestedAt" sort={sort} />
            <th scope="col">
              <span className="visually-hidden">{text.open}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((deployment) => {
            const stage = deploymentStage(deployment.state, {
              releaseVerified: deployment.releaseVerified,
            });
            return (
              <tr
                key={deployment.id}
                data-testid="deployment-row"
                data-deployment-id={deployment.id}
                data-state={deployment.state}
              >
                {showProject ? (
                  <td data-label={text.project}>
                    <Link href={`/projects/${deployment.projectId}`}>
                      {deployment.project?.repoFullName ?? deployment.projectId}
                    </Link>
                    <span className="cell-sub mono">
                      {deployment.project?.defaultBranch ?? translate(locale, "console.unknown")}
                    </span>
                  </td>
                ) : null}
                <td data-label={text.commit}>
                  <Link className="commit-link" href={`/deployments/${deployment.id}`}>
                    <code title={deployment.commitSha}>
                      {shortValue(deployment.commitSha, 8, 6)}
                    </code>
                  </Link>
                </td>
                <td data-label={text.state}>
                  <span className="state-cell">
                    <StageBadge stage={stage} state={deployment.state} locale={locale} currentState />
                    <details className="state-details"><summary>{translate(locale, "console.technical")}</summary><StateChip state={deployment.state} /></details>
                  </span>
                </td>
                <td data-label={text.trigger}>{triggerLabel(deployment.triggerKind)}</td>
                <td data-label={text.requested}>
                  <time dateTime={deployment.requestedAt}>
                    {formatUtcDateTime(deployment.requestedAt)}
                  </time>
                </td>
                <td className="cell-action">
                  <Link
                    className="link-arrow"
                    href={`/deployments/${deployment.id}`}
                    aria-label={`${text.open} ${shortValue(deployment.id, 8, 4)}`}
                  >
                    {text.open}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A column header that is also the sort control. Rendered as a link so sorting
 * works without JS and the resulting URL is shareable; `aria-sort` goes on the
 * `th`, which is what assistive tech announces.
 */
function SortHeader({
  label,
  sortKey,
  sort,
}: {
  readonly label: string;
  readonly sortKey: SortKey;
  readonly sort?: DeploymentSort;
  /** True when the requested page is past the end: an empty page is not an empty project. */
  readonly outOfRange?: boolean;
}) {
  if (sort === undefined) return <th scope="col">{label}</th>;
  const active = sort.key === sortKey;
  const nextDir: "asc" | "desc" = active && sort.dir === "asc" ? "desc" : "asc";
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <a className={`sort-link${active ? " is-active" : ""}`} href={sort.href(sortKey, nextDir)}>
        <span>{label}</span>
        <span className="sort-arrow" aria-hidden="true">
          {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
        </span>
      </a>
    </th>
  );
}
