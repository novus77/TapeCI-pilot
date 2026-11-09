import type { Metadata } from "next";
import Link from "next/link";

import { NewProjectForm } from "@/components/new-project-form";
import { PageHeader } from "@/components/page-header";
import { apiBaseUrl, isMockMode, listGithubInstallations } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import type { GithubInstallationSummary } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "New project" };

export default async function NewProjectPage() {
  const { t } = await getServerT();
  const demo = isMockMode();
  let installations: readonly GithubInstallationSummary[] = [];
  if (!demo) {
    try {
      installations = await listGithubInstallations();
    } catch {
      installations = [];
    }
  }
  return (
    <div className="console-page page--new-project">
      <PageHeader
        eyebrow={
          <>
            <Link href="/">{t("nav.overview")}</Link> / {t("new.title")}
          </>
        }
        title={t("new.title")}
        lede={t("new.lede")}
      />
      <div className="detail-grid">
        <NewProjectForm
          demoMode={demo}
          installations={installations}
          installUrl={`${apiBaseUrl()}/v1/github/install`}
        />
        <aside className="panel" aria-labelledby="what-next-heading">
          <h2 id="what-next-heading">{t("new.what")}</h2>
          <ol className="plain-list ordered">
            <li>
              {t("new.buildStep")}
            </li>
            <li>
              {t("new.scanStep")}
            </li>
            <li>
              {t("new.planStep")}
            </li>
            <li>
              {t("new.releaseStep")}
            </li>
          </ol>
          <p className="panel-copy">
            {t("new.keySafety")}
          </p>
          <p className="panel-copy">
            {t("new.openRequired")}
          </p>
        </aside>
      </div>
    </div>
  );
}
