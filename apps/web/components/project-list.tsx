import Link from "next/link";
import type { ReactNode } from "react";

import { listDeployments, listProjectReleases } from "@/lib/api";
import { shortValue } from "@/lib/format";
import { translate, type Locale } from "@/lib/i18n";
import { deploymentStage } from "@/lib/states";
import type { Project } from "@/lib/types";

import { EmptyState } from "./risk-notice";
import { StageBadge } from "./stage-badge";

export async function ProjectList({
  projects,
  locale,
}: {
  readonly projects: readonly Project[];
  readonly locale: Locale;
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  if (projects.length === 0) {
    return <EmptyState title={t("home.noProjects")} message={t("home.noProjectsBody")} />;
  }

  const summaries = await Promise.all(
    projects.map(async (project) => {
      const [releases, deployments] = await Promise.allSettled([
        listProjectReleases(project.id),
        listDeployments({ projectId: project.id, limit: 1 }),
      ]);
      return { project, releases, deployments };
    }),
  );

  return (
    <div className="project-list">
      {summaries.map(({ project, releases, deployments }) => {
        let releaseContent: ReactNode = t("console.releaseUnavailable");
        if (releases.status === "fulfilled") {
          const current = releases.value.find((release) => release.isCurrent);
          releaseContent = current === undefined ? t("console.noCurrentRelease") : (
            <Link href={`/projects/${project.id}#releases-heading`}>
              <code>{current.releaseId}</code>
            </Link>
          );
        }

        let deploymentContent: ReactNode = t("console.latestUnavailable");
        if (deployments.status === "fulfilled") {
          const latest = deployments.value[0];
          deploymentContent = latest === undefined ? t("home.noDeployment") : (
            <Link href={`/deployments/${latest.id}`}>
              <StageBadge
                stage={deploymentStage(latest.state, { releaseVerified: latest.releaseVerified })}
                state={latest.state}
                locale={locale}
                currentState
              />
            </Link>
          );
        }

        return (
          <article className="panel project-card" key={project.id}>
            <div className="section-head project-row-heading">
              <div className="project-identity">
                <span className="project-mark" aria-hidden="true">{(project.repoFullName.split("/").at(-1) ?? project.repoFullName).slice(0, 1).toUpperCase()}</span>
                <div>
                <h3 className="card-title">
                  <Link href={`/projects/${project.id}`}>{project.repoFullName}</Link>
                </h3>
                <p className="card-sub">
                  <code>{project.defaultBranch}</code> · <code>{project.outputDirectory}</code>
                  {project.isArchived ? ` · ${t("console.archived")}` : ""}
                </p>
                </div>
              </div>
              <Link className="button button-ghost" href={`/projects/${project.id}`}>
                {t("home.openProject")}
              </Link>
            </div>
            <dl className="meta-grid compact">
              <div className="meta-item">
                <dt>{t("console.currentRelease")}</dt>
                <dd>{releaseContent}</dd>
              </div>
              <div className="meta-item">
                <dt>{t("console.latestDeployment")}</dt>
                <dd>{deploymentContent}</dd>
              </div>
              <div className="meta-item">
                <dt>{t("home.container")}</dt>
                <dd>
                  <Link
                    className="mono"
                    href={`/containers/${project.container.address}`}
                    title={project.container.address}
                  >
                    {shortValue(project.container.address, 8, 6)}
                  </Link>
                </dd>
              </div>
              <div className="meta-item">
                <dt>{t("home.strict")}</dt>
                <dd>{project.strictDewebMode ? t("home.strictOn") : t("home.strictOff")}</dd>
              </div>
            </dl>
            <p className="card-foot">
              <Link href={`/containers/${project.container.address}`}>
                {t("console.checkActivation")}
              </Link>
            </p>
          </article>
        );
      })}
    </div>
  );
}
