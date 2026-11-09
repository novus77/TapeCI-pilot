import { FeedbackButton } from "@/components/motion-feedback";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { createOrganization, listOrganizations } from "@/lib/api";
import { describeError } from "@/lib/errors";
import type { MessageKey } from "@/lib/i18n";
import { getServerT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Organizations" };

/** Known API roles have a label key; anything else is shown raw. */
const ROLE_KEYS: Readonly<Record<string, MessageKey>> = {
  owner: "org.owner",
  admin: "org.admin",
  maintainer: "org.maintainer",
  member: "org.memberRole",
};

export default async function OrganizationsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const query = await searchParams;
  const { t } = await getServerT();
  const roleLabel = (role: string): string => {
    const key = ROLE_KEYS[role];
    return key === undefined ? role : t(key);
  };
  let organizations: Awaited<ReturnType<typeof listOrganizations>> = [];
  let error: string | null = query.error ?? null;
  try {
    organizations = await listOrganizations();
  } catch (caught) {
    error = describeError(caught);
  }

  async function create(formData: FormData): Promise<void> {
    "use server";
    try {
      await createOrganization(String(formData.get("name") ?? ""));
    } catch (caught) {
      redirect(`/organizations?error=${encodeURIComponent(describeError(caught))}`);
    }
    redirect("/organizations?saved=1");
  }

  return (
    <div className="console-page page--organizations">
      <PageHeader eyebrow={t("console.operations")} title={t("orgs.title")} lede={t("orgs.lede")} />
      {error === null ? null : <ErrorNotice title={t("orgs.loadError")} message={error} />}
      {query.saved === undefined ? null : <p className="filter-summary" role="status">{t("settings.saved")}.</p>}
      <section className="panel" aria-labelledby="org-list-heading">
        <div className="panel-head"><h2 id="org-list-heading">{t("orgs.yours")}</h2><span className="panel-meta">{organizations.length}</span></div>
        <div className="table-wrap" role="region" aria-label={t("orgs.title")} tabIndex={0}>
          <table className="table">
            <caption className="visually-hidden">{t("orgs.title")}</caption>
            <thead><tr><th scope="col">{t("orgs.name")}</th><th scope="col">{t("console.slug")}</th><th scope="col">{t("org.role")}</th></tr></thead>
            <tbody>
              {organizations.map((org) => (
                <tr key={org.id}>
                  <td><Link href={`/organizations/${org.id}`}>{org.name}</Link></td>
                  <td className="mono">{org.slug}</td>
                  <td>{roleLabel(org.role)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {organizations.length === 0 ? <p className="field-hint">{t("orgs.empty")}</p> : null}
      </section>
      <section className="panel" aria-labelledby="org-create-heading">
        <div className="panel-head"><h2 id="org-create-heading">{t("orgs.create")}</h2></div>
        <form className="filter-form" action={create}>
          <div className="field"><label htmlFor="org-name">{t("orgs.name")}</label><input id="org-name" name="name" required minLength={2} /></div>
          <div className="filter-actions"><FeedbackButton className="button button-primary" type="submit" pendingLabel={t("common.loading")}>{t("orgs.createAction")}</FeedbackButton></div>
        </form>
      </section>
    </div>
  );
}
