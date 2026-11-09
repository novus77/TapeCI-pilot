import type { Metadata } from "next";
import Link from "next/link";

import { DeploymentTable } from "@/components/deployment-table";
import { Pager } from "@/components/pager";
import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { listDeploymentPage, listProjects } from "@/lib/api";
import { filterDeploymentSnapshot } from "@/lib/console-views";
import { describeError } from "@/lib/errors";
import { getServerT } from "@/lib/i18n-server";
import { STATE_FILTER_GROUPS, isDeploymentState } from "@/lib/states";
import type { DeploymentState, DeploymentSummary, Project } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Deployments" };

type SortKey = "requestedAt" | "state" | "project";

/**
 * Builds a `/deployments` URL from the current state. Shared by the sort headers
 * and the pager so both keep every other parameter intact.
 */
function deploymentQuery(input: {
  readonly projectId?: string;
  readonly state?: DeploymentState;
  readonly scope?: string;
  readonly q?: string;
  readonly limit: number;
  readonly sort: string;
  readonly dir: string;
  readonly page: number;
}): string {
  const search = new URLSearchParams();
  if (input.projectId !== undefined) search.set("projectId", input.projectId);
  if (input.state !== undefined) search.set("state", input.state);
  if (input.scope !== undefined) search.set("scope", input.scope);
  if (input.q !== undefined) search.set("q", input.q);
  if (input.limit !== 50) search.set("limit", String(input.limit));
  if (input.sort !== "requestedAt") search.set("sort", input.sort);
  if (input.dir !== "desc") search.set("dir", input.dir);
  if (input.page > 1) search.set("page", String(input.page));
  const query = search.toString();
  return query.length === 0 ? "/deployments" : `/deployments?${query}`;
}

interface DeploymentsSearchParams {
  readonly projectId?: string;
  readonly state?: string;
  readonly limit?: string;
  readonly q?: string;
  readonly scope?: string;
  readonly sort?: string;
  readonly dir?: string;
  readonly page?: string;
}

export default async function DeploymentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<DeploymentsSearchParams>;
}) {
  const params = await searchParams;
  const { locale, t } = await getServerT();
  const projectId =
    typeof params.projectId === "string" && params.projectId.length > 0
      ? params.projectId
      : undefined;
  const rawState =
    typeof params.state === "string" && params.state.length > 0 ? params.state : undefined;
  const state: DeploymentState | undefined = isDeploymentState(rawState) ? rawState : undefined;
  const q = typeof params.q === "string" && params.q.trim().length > 0 ? params.q.trim() : undefined;
  const scope = ["attention", "completed", "approval"].includes(params.scope ?? "") ? params.scope : undefined;
  const limitParam = typeof params.limit === "string" ? Number.parseInt(params.limit, 10) : NaN;
  const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 50;
  // Allowlisted so a crafted URL cannot reach SQL as raw text.
  const sort: SortKey =
    params.sort === "state" || params.sort === "project" || params.sort === "requestedAt"
      ? params.sort
      : "requestedAt";
  const dir: "asc" | "desc" = params.dir === "asc" ? "asc" : "desc";
  const pageParam = typeof params.page === "string" ? Number.parseInt(params.page, 10) : NaN;
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  let projects: readonly Project[] = [];
  let deployments: readonly DeploymentSummary[] = [];
  let loadError: string | null = null;
  let result: Awaited<ReturnType<typeof listDeploymentPage>> = {
    deployments: [],
    page: 1,
    pageSize: limit,
    total: 0,
    totalPages: 1,
  };

  try {
    const [loadedProjects, loadedPage] = await Promise.all([
      listProjects(),
      listDeploymentPage({
        projectId,
        state: scope === undefined ? state : undefined,
        pageSize: limit,
        page,
        sort,
        dir,
      }),
    ]);
    projects = loadedProjects;
    result = loadedPage;
    deployments = loadedPage.deployments;
  } catch (error) {
    loadError = describeError(error);
  }

  if (loadError !== null) {
    return (
      <>
        <PageHeader
          eyebrow={t("deployments.eyebrow")}
          title={t("deployments.title")}
          lede={t("deployments.lede")}
        />
        <ErrorNotice title={t("deployments.loadError")} message={loadError} />
      </>
    );
  }

  const visibleDeployments = filterDeploymentSnapshot(deployments, { scope, state, q });
  // Search and the grouped views run over the page that was fetched, while the
  // pager walks the whole server result set. Say both, so a filtered page cannot
  // be mistaken for a filtered history.
  const filterActive =
    q !== undefined || scope !== undefined || state !== undefined || projectId !== undefined;
  const activeProject = projects.find((project) => project.id === projectId);
  const activeStateLabel = state === undefined ? null : t(`state.${state}`);
  // `deployments.filteredBy` names both filters, so it is only used when both are set.
  const filteredBy =
    activeProject !== undefined && activeStateLabel !== null
      ? t("deployments.filteredBy", {
          project: activeProject.repoFullName,
          state: activeStateLabel,
        })
      : (activeProject?.repoFullName ?? activeStateLabel);

  return (
    <div className="console-page page--deployments">
      <PageHeader
        eyebrow={t("deployments.eyebrow")}
        title={t("deployments.title")}
        lede={t("deployments.lede")}
      />

      <form
        className="filter-form panel"
        action="/deployments"
        method="get"
        aria-labelledby="filter-heading"
      >
        <h2 id="filter-heading" className="visually-hidden">
          {t("deployments.filters")}
        </h2>
        <div className="field"><label htmlFor="filter-q">{t("deployments.search")}</label><input id="filter-q" type="search" name="q" defaultValue={q ?? ""} /></div>
        <div className="field"><label htmlFor="filter-scope">{t("console.scope")}</label><select id="filter-scope" name="scope" defaultValue={scope ?? ""}>
          <option value="">{t("console.all")}</option><option value="attention">{t("console.attention")}</option><option value="approval">{t("console.approval")}</option><option value="completed">{t("console.completed")}</option>
        </select></div>
        <div className="field">
          <label htmlFor="filter-state">{t("deployments.state")}</label>
          <select id="filter-state" name="state" defaultValue={state ?? ""}>
            <option value="">{t("deployments.allStates")}</option>
            {STATE_FILTER_GROUPS.map((group) => (
              <optgroup key={group.label} label={t(group.labelKey)}>
                {group.states.map((groupState) => (
                  <option key={groupState} value={groupState}>
                    {t(`state.${groupState}`)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="filter-project">{t("table.project")}</label>
          <select id="filter-project" name="projectId" defaultValue={projectId ?? ""}>
            <option value="">{t("deployments.allProjects")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.repoFullName}
              </option>
            ))}
          </select>
        </div>
        <div className="field"><label htmlFor="filter-limit">{t("console.limit")}</label><select id="filter-limit" name="limit" defaultValue={limit}>{Array.from(new Set([10, 50, 100, 200, limit])).sort((a, b) => a - b).map(value => <option key={value} value={value}>{value}</option>)}</select></div>
        <div className="filter-actions">
          <button className="button button-primary" type="submit">
            {t("deployments.apply")}
          </button>
          <Link className="button button-ghost" href="/deployments">
            {t("deployments.clear")}
          </Link>
        </div>
      </form>

      <p className="section-copy">{t("console.searchScope", { count: deployments.length, limit })}</p>
      {filterActive ? <p className="section-copy">{t("deployments.pageScope")}</p> : null}
      <p className="filter-summary" role="status">
        {t("deployments.showing", { count: visibleDeployments.length })}
        {filteredBy === null ? "" : ` · ${filteredBy}`}
        {q === undefined ? "" : ` · ${t("deployments.search")}: “${q}”`}.
      </p>

      {state === undefined && projectId === undefined && q === undefined && scope === undefined ? null : (
        <p className="filter-active">
          <Link href="/deployments">{t("deployments.clear")}</Link>
        </p>
      )}

      <DeploymentTable
        deployments={visibleDeployments}
        caption={t("deployments.caption")}
        locale={locale}
        outOfRange={page > result.totalPages}
        sort={{
          key: sort,
          dir,
          href: (key, nextDir) =>
            deploymentQuery({ projectId, state, scope, q, limit, sort: key, dir: nextDir, page: 1 }),
        }}
        labels={{
          project: t("table.project"),
          commit: t("table.commit"),
          state: t("table.state"),
          trigger: t("table.trigger"),
          requested: t("table.requested"),
          open: t("table.open"),
          region: t("table.region"),
          emptyTitle: t("table.emptyTitle"),
          emptyBody: t("table.emptyBody"),
        }}
      />
      <Pager
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        pageSize={result.pageSize}
        href={(target) =>
          deploymentQuery({ projectId, state, scope, q, limit, sort, dir, page: target })
        }
        labels={{
          region: t("pager.region"),
          previous: t("pager.previous"),
          next: t("pager.next"),
          first: t("pager.first"),
          last: t("pager.last"),
          summary: t("pager.summary"),
          emptyPage: t("pager.emptyPage"),
          position: t("pager.position"),
        }}
      />
    </div>
  );
}
