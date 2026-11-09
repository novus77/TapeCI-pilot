import { FeedbackButton } from "@/components/motion-feedback";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { ErrorNotice } from "@/components/error-notice";
import { AddMemberForm } from "@/components/add-member-form";
import { MemberTable } from "@/components/member-table";
import { PageHeader } from "@/components/page-header";
import {
  addOrganizationMember,
  getCurrentUser,
  getOrganization,
  getOrganizationAudit,
  getOrganizationBudget,
  removeOrganizationMember,
  updateOrganizationMemberRole,
  updateOrganizationBudget,
} from "@/lib/api";
import { describeError, isNotFound } from "@/lib/errors";
import { shortValue } from "@/lib/format";
import type { MessageKey } from "@/lib/i18n";
import { getServerT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Organization" };

/** Known API roles have a label key; anything else is shown raw. */
const ROLE_KEYS: Readonly<Record<string, MessageKey>> = {
  owner: "org.owner",
  admin: "org.admin",
  maintainer: "org.maintainer",
  member: "org.memberRole",
};

export default async function OrganizationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { t } = await getServerT();
  const roleLabel = (role: string): string => {
    const key = ROLE_KEYS[role];
    return key === undefined ? role : t(key);
  };
  let org: Awaited<ReturnType<typeof getOrganization>>;
  let budget: Awaited<ReturnType<typeof getOrganizationBudget>> = { monthlyCapWei: null, spentThisMonthWei: "0", projectCount: 0 };
  let audit: Awaited<ReturnType<typeof getOrganizationAudit>> = [];
  let currentUserId: string | null = null;
  try {
    const me = await getCurrentUser();
    currentUserId = me?.id ?? null;
  } catch {
    currentUserId = null;
  }
  try {
    org = await getOrganization(id);
    budget = await getOrganizationBudget(id);
    audit = await getOrganizationAudit(id).catch(() => []);
  } catch (error) {
    if (isNotFound(error)) notFound();
    return (
      <>
        <PageHeader eyebrow={t("org.title")} title={t("org.title")} />
        <ErrorNotice title={t("org.loadError")} message={describeError(error)} />
      </>
    );
  }

  async function changeMemberRole(userId: string, role: "owner" | "admin" | "member"): Promise<void> {
    "use server";
    try {
      await updateOrganizationMemberRole(id, userId, role);
      revalidatePath(`/organizations/${id}`);
    } catch (error) {
      throw new Error(describeError(error));
    }
  }

  async function removeMember(userId: string): Promise<void> {
    "use server";
    try {
      await removeOrganizationMember(id, userId);
      revalidatePath(`/organizations/${id}`);
    } catch (error) {
      throw new Error(describeError(error));
    }
  }

  async function add(formData: FormData): Promise<void> {
    "use server";
    try {
      await addOrganizationMember(
        id,
        String(formData.get("githubLogin") ?? ""),
        formData.get("role") === "admin" ? "admin" : "member",
      );
      revalidatePath(`/organizations/${id}`);
    } catch (error) {
      redirect(`/organizations/${id}?error=${encodeURIComponent(describeError(error))}`);
    }
    redirect(`/organizations/${id}?saved=1`);
  }

  async function saveBudget(formData: FormData): Promise<void> {
    "use server";
    try {
      const raw = String(formData.get("monthlyCapWei") ?? "").trim();
      await updateOrganizationBudget(id, raw === "" ? null : raw);
      revalidatePath(`/organizations/${id}`);
    } catch (error) {
      redirect(`/organizations/${id}?error=${encodeURIComponent(describeError(error))}`);
    }
    redirect(`/organizations/${id}?saved=budget`);
  }

  return (
    <div className="console-page page--organization">
      <PageHeader
        eyebrow={<><Link href="/organizations">{t("orgs.title")}</Link> / {org.organization.slug}</>}
        title={org.organization.name}
        lede={`${t("console.memberCount", { count: org.members.length })} · ${t("console.projectCount", { count: org.projectCount })}`}
        actions={<Link className="button button-ghost" href="/organizations">{t("org.allOrganizations")}</Link>}
      />
      {query.error === undefined ? null : <ErrorNotice title={t("org.changeRefused")} message={query.error} />}
      {query.saved === undefined ? null : <p className="filter-summary" role="status">{t("settings.saved")}.</p>}
      <section className="panel" aria-labelledby="org-members-heading">
        <div className="panel-head"><h2 id="org-members-heading">{t("org.members")}</h2><span className="panel-meta">{t("org.role")}: {roleLabel(org.role)}</span></div>
        <MemberTable
          members={org.members}
          canManage={org.canManage}
          currentUserId={currentUserId}
          protectedUserId={org.protectedUserId}
          onChangeRole={changeMemberRole}
          onRemove={removeMember}
        />
        {org.canManage ? (
          <AddMemberForm
            action={add}
            roles={[
              { value: "member", label: t("org.memberRole") },
              { value: "admin", label: t("org.admin") },
            ]}
          />
        ) : <p className="field-hint">{t("org.onlyManagers")}</p>}
      </section>
      <section className="panel" aria-labelledby="org-budget-heading">
        <div className="panel-head"><h2 id="org-budget-heading">{t("org.budget")}</h2><span className="panel-meta">{t("console.projectCount", { count: budget.projectCount })}</span></div>
        <p className="field-hint">{t("org.spent")}: <strong>{budget.spentThisMonthWei}</strong> wei ({t("console.estimated")}).</p>
        {org.canManage ? (
          <form className="filter-form" action={saveBudget}>
            <div className="field">
              <label htmlFor="org-monthlyCapWei">{t("org.monthlyCap")}</label>
              <input id="org-monthlyCapWei" name="monthlyCapWei" defaultValue={budget.monthlyCapWei ?? ""} inputMode="numeric" />
            </div>
            <div className="filter-actions"><FeedbackButton className="button button-primary" type="submit" pendingLabel={t("common.loading")}>{t("org.saveBudget")}</FeedbackButton></div>
          </form>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="org-audit-heading">
        <div className="panel-head"><h2 id="org-audit-heading">{t("org.audit")}</h2><span className="panel-meta">{t("console.eventCount", { count: audit.length })}</span></div>
        {org.canManage ? (
          <div className="table-wrap" role="region" aria-label={t("org.auditEvents")} tabIndex={0}>
            <table className="table">
              <caption className="visually-hidden">{t("org.auditEvents")}</caption>
              <thead><tr><th scope="col">{t("audit.time")}</th><th scope="col">{t("org.actor")}</th><th scope="col">{t("audit.route")}</th><th scope="col">{t("audit.project")}</th><th scope="col">{t("audit.status")}</th></tr></thead>
              <tbody>
                {audit.map((event) => (
                  <tr key={event.id}>
                    <td>{new Date(event.createdAt).toISOString()}</td>
                    <td>{event.actorLogin ?? "—"}</td>
                    <td><code>{event.method} {event.route}</code></td>
                    <td>
                      {event.projectId === undefined || event.projectId === null ? "—" : (
                        <Link className="mono" href={`/projects/${event.projectId}`} title={event.projectId}>
                          {shortValue(event.projectId, 8, 4)}
                        </Link>
                      )}
                    </td>
                    <td>{event.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="field-hint">{t("org.onlyAudit")}</p>}
      </section>

      <section className="panel" aria-labelledby="org-projects-heading">
        <div className="panel-head"><h2 id="org-projects-heading">{t("org.projects")}</h2><span className="panel-meta">{org.projectCount}</span></div>
        {org.projects.length === 0 ? <p className="field-hint">{t("org.noProjects")}</p> : (
          <ul className="plain-list">
            {org.projects.map((project) => (
              <li key={project.id}><Link href={`/projects/${project.id}`}>{project.repoFullName}</Link> <span className="field-hint">{project.defaultBranch}</span></li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
