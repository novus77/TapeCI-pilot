import { ReviewTabs } from "@/components/review-tabs";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DeploymentTable } from "@/components/deployment-table";
import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { EmptyState, RiskNotice } from "@/components/risk-notice";
import { StageBadge, StatusChip } from "@/components/stage-badge";
import {
  getProject,
  getProjectPublication,
  listDeployments,
  listOrganizations,
  listProjectReleases,
} from "@/lib/api";
import { describeError, isNotFound } from "@/lib/errors";
import { formatUtcDateTime, shortValue } from "@/lib/format";
import { getServerT } from "@/lib/i18n-server";
import { deploymentStage } from "@/lib/states";
import type { DeploymentSummary, Project, PublicationSummary, Release } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Project" };

export default async function ProjectPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { locale, t } = await getServerT();
  let project: Project;
  try {
    project = await getProject(id);
  } catch (error) {
    if (isNotFound(error)) notFound();
    return (
      <>
        <PageHeader eyebrow={t("project.eyebrow")} title={t("project.eyebrow")} />
        <ErrorNotice title={t("project.loadError")} message={describeError(error)} />
      </>
    );
  }

  let publication: PublicationSummary | null = null;
  let publicationError: string | null = null;
  let releases: readonly Release[] = [];
  const organizations = await listOrganizations().catch(() => []);
  const organization = organizations.find((candidate) => candidate.id === project.organizationId);
  let deployments: readonly DeploymentSummary[] = [];
  let loadError: string | null = null;
  try {
    const [loadedReleases, loadedDeployments] = await Promise.all([
      listProjectReleases(project.id),
      listDeployments({ projectId: project.id, limit: 20 }),
    ]);
    releases = loadedReleases;
    deployments = loadedDeployments;
    try {
      publication = await getProjectPublication(project.id);
    } catch (error) {
      publicationError = describeError(error);
    }
  } catch (error) {
    loadError = describeError(error);
  }

  const currentRelease = releases.find((release) => release.isCurrent);
  const latestDeployment = deployments[0];

  return (
    <div className="console-page page--project">
      {project.isArchived ? (
        <RiskNotice tone="warning" title={t("console.archived")}>
          <p>{t("console.archivedBody")}</p>
        </RiskNotice>
      ) : null}
      <PageHeader
        eyebrow={
          <>
            <Link href="/projects">{t("nav.projects")}</Link> / {t("project.eyebrow")}
          </>
        }
        title={project.repoFullName}
        lede={
          <>
            {t("console.projectLede", { branch: project.defaultBranch })}
          </>
        }
        actions={
          <>
            {organization === undefined ? null : (
              <Link className="button button-ghost" href={`/organizations/${organization.id}`}>
                {organization.name}
              </Link>
            )}
            <Link className="button button-ghost" href={`/projects/${project.id}/settings`}>
              {t("project.settings")}
            </Link>
            <Link className="button button-ghost" href={`/projects/${project.id}/compare`}>
              {t("project.compare")}
            </Link>
            <Link className="button button-ghost" href={`/audit?projectId=${project.id}`}>
              {t("nav.audit")}
            </Link>

          </>
        }
      />

      {project.isArchived ? (
        <p className="filter-active" role="status">
          {t("console.archivedBody")}
        </p>
      ) : null}

      {loadError === null ? null : (
        <ErrorNotice title={t("console.partialError")} message={loadError} />
      )}

      <div className="project-health-grid">
      <section className="panel release-summary" aria-label={t("console.currentRelease")}>
        <dl className="meta-grid">
          <div className="meta-item"><dt>{t("console.currentRelease")}</dt><dd>{loadError !== null ? t("console.releaseUnavailable") : currentRelease === undefined ? t("console.noCurrentRelease") : <Link href="#releases-heading"><code>{currentRelease.releaseId}</code> · <code>{shortValue(currentRelease.commitSha, 8, 6)}</code></Link>}</dd></div>
          <div className="meta-item"><dt>{t("console.latestDeployment")}</dt><dd>{loadError !== null ? t("console.latestUnavailable") : latestDeployment === undefined ? t("home.noDeployment") : <Link href={`/deployments/${latestDeployment.id}`}><StageBadge stage={deploymentStage(latestDeployment.state, { releaseVerified: latestDeployment.releaseVerified })} state={latestDeployment.state} locale={locale} currentState /></Link>}</dd></div>
        </dl>
        <p className="panel-copy">{t("console.activationBody")}</p>
        <Link href={`/containers/${project.container.address}`}>{t("console.checkActivation")}</Link>
      </section>
      {/*
        SPEC §12.4: the four facts stay separate. A verified release with an expired
        binding is exactly the case a single "LIVE" badge would misreport, so each row
        states its own fact and its own reason.
      */}
      <section className="panel" aria-labelledby="publication-heading" data-testid="publication">
        <div className="panel-head">
          <h2 id="publication-heading">{t("publication.heading")}</h2>
          <span className="panel-meta">
            {publication?.checkedAt === null || publication?.checkedAt === undefined
              ? t("publication.neverChecked")
              : t("publication.checkedAt", { at: publication.checkedAt })}
          </span>
        </div>
        {publicationError === null ? null : (
          <p className="panel-copy" data-testid="publication-error">
            {t("publication.unavailable")} — {publicationError}
          </p>
        )}
        {publication === null ? null : (
          <dl className="meta-grid">
            <div className="meta-item">
              <dt>{t("publication.release")}</dt>
              <dd data-testid="publication-release">
                {publication.release === null
                  ? t("publication.noRelease")
                  : publication.release.verified === null
                    ? t("publication.releaseUnread")
                    : publication.release.verified
                      ? t("publication.releaseVerified", {
                          block: publication.release.verifiedBlockNumber ?? "—",
                        })
                      : t("publication.releaseUnverified")}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("publication.binding")}</dt>
              <dd data-testid="publication-binding">
                {publication.binding === null
                  ? t("publication.noBinding")
                  : publication.binding.state === "unknown"
                    ? t("publication.bindingUnknown")
                    : publication.binding.state === "active"
                      ? t("publication.bindingActive", {
                          name: publication.binding.name,
                          paidUntil: publication.binding.paidUntil ?? "—",
                        })
                      : t("publication.bindingExpired", {
                          name: publication.binding.name,
                          paidUntil: publication.binding.paidUntil ?? "—",
                        })}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("publication.gateway")}</dt>
              <dd data-testid="publication-gateway">{t(`publication.gateway.${publication.gatewayCheck}`)}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("publication.url")}</dt>
              <dd data-testid="publication-url">
                {publication.publicUrl === null
                  ? t("publication.noUrl")
                  : /* The URL is server-derived; never rendered as a probe target. */
                    publication.gatewayCheck === "reachable" ? (
                      <a href={publication.publicUrl} rel="noreferrer noopener" target="_blank">
                        {publication.publicUrl}
                      </a>
                    ) : (
                      <code>{publication.publicUrl}</code>
                    )}
              </dd>
            </div>
          </dl>
        )}
        {publication !== null && publication.missing.length > 0 ? (
          <p className="panel-copy" data-testid="publication-missing">
            {publication.missing.join(" · ")}
          </p>
        ) : null}
      </section>

      </div>

      <ReviewTabs label={t("nav.projects")} items={[
        { href: "#project-deployments-heading", label: t("deployments.title") },
        { href: "#releases-heading", label: t("project.releases") },
        { href: `/containers/${project.container.address}`, label: t("project.container") },
        { href: `/projects/${project.id}/settings`, label: t("project.settings") },
      ]} />

      <div className="detail-grid">
        <section className="panel" aria-labelledby="project-config-heading">
          <div className="panel-head">
            <h2 id="project-config-heading">{t("project.buildConfig")}</h2>
            <span className="panel-meta">{project.strictDewebMode ? t("project.strict") : t("console.relaxed")}</span>
          </div>
          <dl className="meta-grid">
            <div className="meta-item">
              <dt>{t("project.repository")}</dt>
              <dd>{project.repoFullName}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("project.defaultBranch")}</dt>
              <dd>
                <code>{project.defaultBranch}</code>
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("project.installCommand")}</dt>
              <dd>
                <code>{project.installCommand}</code>
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("project.buildCommand")}</dt>
              <dd>
                <code>{project.buildCommand}</code>
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("project.outputDirectory")}</dt>
              <dd>
                <code>{project.outputDirectory}</code>
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("project.created")}</dt>
              <dd>{formatUtcDateTime(project.createdAt)}</dd>
            </div>
          </dl>
          <h3>{t("project.installations")}</h3>
          {project.installations === undefined ? (
            <p className="panel-copy">
              {t("console.installationsMissing")}
            </p>
          ) : project.installations.length === 0 ? (
            <p className="panel-copy">{t("project.noInstallation")}</p>
          ) : (
            <ul className="plain-list">
              {project.installations.map((installation) => (
                <li key={installation.id}>
                  <code>{installation.accountLogin}</code> · installation{" "}
                  {installation.installationId}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="container-heading">
          <div className="panel-head">
            <h2 id="container-heading">{t("project.container")}</h2>
            <span className="panel-meta">{t("deployment.chain")} {project.container.chainId}</span>
          </div>
          <dl className="meta-grid">
            <div className="meta-item">
              <dt>{t("project.address")}</dt>
              <dd>
                <Link className="mono" href={`/containers/${project.container.address}`}>
                  {project.container.address}
                </Link>
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("project.owner")}</dt>
              <dd className="mono" title={project.container.ownerAddress ?? undefined}>
                {shortValue(project.container.ownerAddress, 12, 8)}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("project.registry")}</dt>
              <dd className="mono" title={project.container.registryAddress}>
                {shortValue(project.container.registryAddress, 12, 8)}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("project.opened")}</dt>
              <dd>
                <StatusChip
                  label={
                    project.container.opened === null
                      ? t("console.unknown")
                      : project.container.opened
                        ? t("container.opened")
                        : t("console.notOpened")
                  }
                  tone={
                    project.container.opened === null
                      ? "neutral"
                      : project.container.opened
                        ? "success"
                        : "danger"
                  }
                />
              </dd>
            </div>
          </dl>
          <p className="panel-copy">
            {t("console.containerChecks")}
          </p>
          <Link className="section-link" href={`/containers/${project.container.address}`}>
            {t("console.containerSettings")}
          </Link>
        </section>
      </div>

      <section className="section" aria-labelledby="releases-heading">
        <div className="section-head">
          <h2 id="releases-heading">{t("project.releases")}</h2>
          <span className="section-meta">
            {t("console.storedReleases", { count: releases.length })}
          </span>
        </div>
        {releases.length === 0 ? (
          <EmptyState
            title={t("project.noReleases")}
            message={t("project.noReleasesBody")}
          />
        ) : (
          <div className="table-wrap" role="region" aria-label={t("project.releases")} tabIndex={0}>
            <table className="table">
              <caption className="visually-hidden">{t("project.storedReleases")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("project.releaseId")}</th>
                  <th scope="col">{t("project.commit")}</th>
                  <th scope="col">{t("project.entrySha")}</th>
                  <th scope="col">{t("project.verifiedAt")}</th>
                  <th scope="col">{t("project.activatedAt")}</th>
                  <th scope="col">{t("project.current")}</th>
                </tr>
              </thead>
              <tbody>
                {releases.map((release) => (
                  <tr key={release.id}>
                    <td className="mono">{release.releaseId}</td>
                    <td>
                      <code title={release.commitSha}>
                        {shortValue(release.commitSha, 8, 6)}
                      </code>
                    </td>
                    <td className="mono" title={release.entrySha256}>
                      {shortValue(release.entrySha256, 10, 6)}
                    </td>
                    <td>{release.verifiedBlockNumber}</td>
                    <td>
                      <time dateTime={release.activatedAt}>
                        {formatUtcDateTime(release.activatedAt)}
                      </time>
                    </td>
                    <td>
                      <StatusChip
                        label={release.isCurrent ? t("project.current") : t("console.superseded")}
                        tone={release.isCurrent ? "success" : "neutral"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="project-deployments-heading">
        <div className="section-head">
          <h2 id="project-deployments-heading">{t("deployments.title")}</h2>
          <Link className="section-link" href={`/deployments?projectId=${project.id}`}>
            {t("console.filterProject")}
          </Link>
        </div>
        <DeploymentTable
          deployments={deployments}
          caption={t("deployments.caption")}
          showProject={false}
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
    </div>
  );
}
