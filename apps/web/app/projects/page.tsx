import type { Metadata } from "next";
import Link from "next/link";

import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { ProjectList } from "@/components/project-list";
import { listProjects } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { getServerT } from "@/lib/i18n-server";
import type { Project } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage() {
  const { locale, t } = await getServerT();
  let projects: readonly Project[] = [];
  let error: string | null = null;
  try {
    projects = await listProjects();
  } catch (caught) {
    error = describeError(caught);
  }

  return (
    <div className="console-page page--projects">
      <PageHeader
        title={t("nav.projects")}
        lede={t("console.projectsLede")}
        actions={
          <Link className="button button-primary" href="/projects/new">
            {t("nav.newProject")}
          </Link>
        }
      />
      {error === null ? (
        <ProjectList projects={projects} locale={locale} />
      ) : (
        <ErrorNotice title={t("console.projectsError")} message={error} />
      )}
    </div>
  );
}
