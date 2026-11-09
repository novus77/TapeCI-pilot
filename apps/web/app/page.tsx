import { Disclosure } from "@/components/disclosure";
import type { Metadata } from "next";
import Link from "next/link";

import { DeploymentTable } from "@/components/deployment-table";
import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { ReleaseLegend } from "@/components/release-legend";
import { WorkbenchPipeline } from "@/components/workbench-pipeline";
import { WorkbenchPending, WorkbenchRail } from "@/components/workbench-rail";
import { isMockMode, listDeploymentPage, listProjectReleases, listProjects } from "@/lib/api";
import { filterDeploymentSnapshot, OVERVIEW_DEPLOYMENT_LIMIT } from "@/lib/console-views";
import { describeError } from "@/lib/errors";
import { getServerT } from "@/lib/i18n-server";
import type { DeploymentSummary, Project } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Next metadata is static, so the document title stays English. */
export const metadata: Metadata = { title: "Overview" };

/**
 * The workbench (Precision Console).
 *
 * Main column: the selected project's pipeline, then the recent deployment records.
 * Rail: what needs a human, then the wallet's resource state.
 *
 * The summary numbers keep their original meanings and destinations — they are a compact row
 * now, not four cards, but "projects", "deployment records", "completed" and "needs attention"
 * still mean exactly what they meant before and still link to the same filtered lists.
 */
export default async function DashboardPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ project?: string }>;
}) {
  const { locale, t } = await getServerT();
  const query = await searchParams;

  let projects: readonly Project[] = [];
  let deployments: readonly DeploymentSummary[] = [];
  let deploymentTotal = 0;
  let loadError: string | null = null;

  try {
    const [loadedProjects, page] = await Promise.all([
      listProjects(),
      listDeploymentPage({ pageSize: OVERVIEW_DEPLOYMENT_LIMIT, page: 1 }),
    ]);
    projects = loadedProjects;
    deployments = page.deployments;
    deploymentTotal = page.total;
  } catch (error) {
    loadError = describeError(error);
  }

  if (loadError !== null) {
    return (
      <>
        <PageHeader eyebrow={t("home.eyebrow")} title={t("home.title")} lede={t("home.lede")} />
        <ErrorNotice
          title={t("home.loadErrorTitle")}
          message={loadError}
          hint={isMockMode() ? t("home.loadErrorMockHint") : t("home.loadErrorHint")}
        />
      </>
    );
  }

  // The selected project comes from the URL so the choice survives a refresh and a deep link.
  const selected = projects.find((project) => project.id === query.project) ?? projects[0] ?? null;

  let currentReleaseId: string | null = null;
  let projectDeployment: DeploymentSummary | null = null;
  let releaseUnavailable = false;
  let deploymentUnavailable = false;
  if (selected !== null) {
    const [releases, latest] = await Promise.allSettled([
      listProjectReleases(selected.id),
      listDeploymentPage({ projectId: selected.id, pageSize: 1, page: 1, sort: "requestedAt", dir: "desc" }),
    ]);
    releaseUnavailable = releases.status === "rejected";
    deploymentUnavailable = latest.status === "rejected";
    currentReleaseId = releases.status === "fulfilled" ? releases.value.find(release => release.isCurrent)?.releaseId ?? null : null;
    projectDeployment = latest.status === "fulfilled" ? latest.value.deployments[0] ?? null : null;
  }

  const live = filterDeploymentSnapshot(deployments, { scope: "completed" }).length;
  const attention = filterDeploymentSnapshot(deployments, { scope: "attention" }).length;
  // Approvals are a distinct fact from "attention": only this state has a signature to give.
  const pending = filterDeploymentSnapshot(deployments, { scope: "approval" });

  return (
    <>
      <PageHeader
        eyebrow={t("home.eyebrow")}
        title={t("home.title")}
        lede={t("home.ledeLong")}
        actions={
          <Link className="button button-primary" href="/projects/new">
            {t("nav.newProject")}
          </Link>
        }
      />


      <div className="workbench-meta">
        <div className="workbench-counts">
          <Link href="/projects">
            <strong>{projects.length}</strong> {t("home.kpi.projects")}
          </Link>
          <Link href="/deployments?limit=10">
            <strong>{deploymentTotal}</strong> {t("home.kpi.deployments")}
          </Link>
          <Link href="/deployments?scope=attention&limit=10">
            <strong>{attention}</strong> {t("home.kpi.attention")}
          </Link>
          <Link href="/deployments?scope=completed&limit=10">
            <strong>{live}</strong> {t("console.completed")}
          </Link>
        </div>
        <span className="workbench-snapshot">
          {t("workbench.snapshot", { count: deployments.length })}
        </span>
      </div>

      {projects.length > 1 ? (
        <nav className="project-switcher" aria-label={t("workbench.projectSwitcher")}>
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/?project=${encodeURIComponent(project.id)}`}
              aria-current={project.id === selected?.id ? "page" : undefined}
              data-testid={`project-switch-${project.id}`}
            >
              {project.repoFullName.split("/")[1] ?? project.repoFullName}
            </Link>
          ))}
        </nav>
      ) : null}

      <div className="workbench-grid">
        <WorkbenchPending pending={pending} locale={locale} />
        <div className="workbench-main">
          {selected === null ? (
            <section className="panel empty-state">
              <h2>{t("home.noProjects")}</h2>
              <p>{t("home.noProjectsBody")}</p>
              <Link className="button button-primary" href="/projects/new">
                {t("nav.newProject")}
              </Link>
            </section>
          ) : (
            <WorkbenchPipeline
              project={selected}
              deployment={projectDeployment}
              currentReleaseId={currentReleaseId}
              releaseUnavailable={releaseUnavailable}
              deploymentUnavailable={deploymentUnavailable}
              locale={locale}
            />
          )}

          <section aria-labelledby="recent-heading">
            <div className="section-heading">
              <h2 id="recent-heading">
                {t("home.recent")}
                <span className="small-count">
                  {deployments.length} / {deploymentTotal}
                </span>
              </h2>
              <Link className="section-link" href="/deployments">
                {t("home.viewAll")}
              </Link>
            </div>
            <DeploymentTable
              deployments={deployments}
              caption={t("home.recent")}
              locale={locale}
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
          </section>

          <Disclosure title={t("home.statesTitle")}>
            <p className="section-copy">
              {t("home.statesCopy", { buildSuccess: t("home.buildSuccess") })}
            </p>
            <ReleaseLegend />
          </Disclosure>
        </div>

        <WorkbenchRail locale={locale} snapshotSize={deployments.length} />
      </div>
    </>
  );
}
