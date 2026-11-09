import type { Metadata } from "next";
import Link from "next/link";

import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { getCurrentUser, listAuditEvents } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { shortValue } from "@/lib/format";
import { getServerT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audit log" };

interface AuditSearchParams {
  readonly status?: string;
  readonly scope?: string;
  readonly projectId?: string;
}

export default async function AuditPage({
  searchParams,
}: {
  readonly searchParams: Promise<AuditSearchParams>;
}) {
  const query = await searchParams;
  const { t } = await getServerT();
  const user = await getCurrentUser();
  const scope = query.scope === "all" && user?.isAdmin === true ? "all" : "self";
  const status = query.status === undefined ? undefined : Number(query.status);
  const projectId =
    typeof query.projectId === "string" && query.projectId.length > 0
      ? query.projectId
      : undefined;
  let events: Awaited<ReturnType<typeof listAuditEvents>> = [];
  let error: string | null = null;
  try {
    events = await listAuditEvents({
      status: Number.isFinite(status) ? status : undefined,
      scope,
      projectId,
      limit: 200,
    });
  } catch (caught) {
    error = describeError(caught);
  }

  // The scope toggle must keep the project filter (and vice versa) so switching
  // views never silently drops a filter the user is looking at.
  const scopeToggle = new URLSearchParams();
  if (projectId !== undefined) scopeToggle.set("projectId", projectId);
  if (scope !== "all") scopeToggle.set("scope", "all");
  const scopeToggleQuery = scopeToggle.toString();
  const scopeToggleHref = scopeToggleQuery === "" ? "/audit" : `/audit?${scopeToggleQuery}`;

  return (
    <div className="console-page page--audit">
      <PageHeader
        eyebrow={t("console.operations")}
        title={t("audit.title")}
        lede={t("audit.lede")}
        actions={
          user?.isAdmin === true ? (
            <Link className="button button-ghost" href={scopeToggleHref}>
              {scope === "all" ? t("audit.scopeMine") : t("audit.scopeAll")}
            </Link>
          ) : undefined
        }
      />
      {error === null ? null : <ErrorNotice title={t("audit.loadError")} message={error} />}
      <form className="filter-form panel" action="/audit" method="get">
        <div className="field">
          <label htmlFor="audit-status">{t("audit.httpStatus")}</label>
          <select id="audit-status" name="status" defaultValue={query.status ?? ""}>
            <option value="">{t("audit.allStatuses")}</option>
            <option value="200">200</option>
            <option value="201">201</option>
            <option value="202">202</option>
            <option value="400">400</option>
            <option value="401">401</option>
            <option value="403">403</option>
            <option value="409">409</option>
            <option value="422">422</option>
            <option value="500">500</option>
          </select>
        </div>
        {projectId === undefined ? null : (
          <input type="hidden" name="projectId" value={projectId} />
        )}
        {scope === "all" ? <input type="hidden" name="scope" value="all" /> : null}
        <div className="filter-actions">
          <button className="button button-primary" type="submit">
            {t("console.apply")}
          </button>
          <Link className="button button-ghost" href={scope === "all" ? "/audit?scope=all" : "/audit"}>
            {t("console.reset")}
          </Link>
        </div>
      </form>
      {projectId === undefined ? null : (
        <p className="filter-active">
          {t("console.projectFilter")} <code className="mono">{shortValue(projectId, 8, 4)}</code>.{" "}
          <Link href={scope === "all" ? "/audit?scope=all" : "/audit"}>{t("audit.clear")}</Link>
        </p>
      )}
      <div className="table-wrap" role="region" aria-label={t("audit.events")} tabIndex={0}>
        <table className="table">
          <caption className="visually-hidden">{t("audit.events")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("audit.time")}</th>
              <th scope="col">{t("audit.actor")}</th>
              <th scope="col">{t("audit.event")}</th>
              <th scope="col">{t("audit.route")}</th>
              <th scope="col">{t("audit.project")}</th>
              <th scope="col">{t("audit.organization")}</th>
              <th scope="col">{t("audit.status")}</th>
              <th scope="col">{t("audit.request")}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{new Date(event.createdAt).toISOString()}</td>
                <td>{event.actorLogin ?? "—"}</td>
                <td>{event.event}</td>
                <td>
                  <code>
                    {event.method} {event.route}
                  </code>
                </td>
                <td>
                  {event.projectId === undefined || event.projectId === null ? (
                    "—"
                  ) : (
                    <Link className="mono" href={`/projects/${event.projectId}`} title={event.projectId}>
                      {shortValue(event.projectId, 8, 4)}
                    </Link>
                  )}
                </td>
                <td className="mono" title={event.organizationId ?? undefined}>
                  {shortValue(event.organizationId ?? null, 8, 4)}
                </td>
                <td>{event.status}</td>
                <td className="mono">{event.requestId ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {events.length === 0 && error === null ? (
        // The project-scoped empty state has no dictionary key and its exact
        // English wording is pinned by apps/web/e2e/console.spec.ts.
        <p className="field-hint">
          {projectId === undefined
            ? t("audit.empty")
            : t("console.auditEmptyProject")}
        </p>
      ) : null}
    </div>
  );
}
