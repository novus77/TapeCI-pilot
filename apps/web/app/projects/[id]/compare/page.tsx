import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { compareProjectReleases, getProject, listProjectReleases } from "@/lib/api";
import { describeError, isNotFound } from "@/lib/errors";
import { getServerT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compare releases" };

export default async function ComparePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ base?: string; target?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { t } = await getServerT();
  let project;
  let releases: Awaited<ReturnType<typeof listProjectReleases>> = [];
  try {
    project = await getProject(id);
    releases = await listProjectReleases(id);
  } catch (error) {
    if (isNotFound(error)) notFound();
    return (
      <>
        <PageHeader eyebrow={t("project.eyebrow")} title={t("compare.title")} />
        <ErrorNotice title={t("compare.loadError")} message={describeError(error)} />
      </>
    );
  }
  const base = query.base ?? releases[0]?.releaseId ?? "";
  const target = query.target ?? releases[1]?.releaseId ?? "";
  let comparison: Awaited<ReturnType<typeof compareProjectReleases>> | null = null;
  let error: string | null = null;
  if (base !== "" && target !== "" && base !== target) {
    try {
      comparison = await compareProjectReleases(id, base, target);
    } catch (caught) {
      error = describeError(caught);
    }
  }
  return (
    <div className="console-page page--compare">
      <PageHeader
        eyebrow={<><Link href={`/projects/${project.id}`}>{project.repoFullName}</Link> / {t("project.compare")}</>}
        title={t("compare.title")}
        lede={t("compare.lede")}
      />
      {error === null ? null : <ErrorNotice title={t("compare.compareError")} message={error} />}
      <form className="filter-form panel" action={`/projects/${id}/compare`} method="get">
        <div className="field">
          <label htmlFor="compare-base">{t("compare.base")}</label>
          <select id="compare-base" name="base" defaultValue={base}>
            {releases.map((release) => <option key={release.id} value={release.releaseId}>{release.releaseId} · {release.commitSha.slice(0, 8)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="compare-target">{t("compare.target")}</label>
          <select id="compare-target" name="target" defaultValue={target}>
            {releases.map((release) => <option key={release.id} value={release.releaseId}>{release.releaseId} · {release.commitSha.slice(0, 8)}</option>)}
          </select>
        </div>
        <div className="filter-actions"><button className="button button-primary" type="submit">{t("project.compare")}</button></div>
      </form>
      {comparison === null ? <p className="field-hint">{t("compare.pickTwo")}</p> : (
        <section className="panel" aria-labelledby="compare-heading">
          <div className="panel-head">
            <h2 id="compare-heading">{t("compare.differences")}</h2>
            <span className="panel-meta">{t("console.changedCount", { count: comparison.changes.filter((change) => change.status !== "unchanged").length })}</span>
          </div>
          <div className="table-wrap" role="region" aria-label={t("compare.comparison")} tabIndex={0}>
            <table className="table">
              <caption className="visually-hidden">{t("compare.comparison")}</caption>
              <thead><tr><th scope="col">{t("console.path")}</th><th scope="col">{t("compare.status")}</th><th scope="col">{t("compare.baseSha")}</th><th scope="col">{t("compare.targetSha")}</th></tr></thead>
              <tbody>
                {comparison.changes.map((change) => (
                  <tr key={change.path}>
                    <td className="mono">{change.path}</td>
                    <td>{t(`console.${change.status}`)}</td>
                    <td className="mono">{change.baseSha256 ?? "—"}</td>
                    <td className="mono">{change.targetSha256 ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
