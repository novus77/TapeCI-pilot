import { FeedbackButton } from "@/components/motion-feedback";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { MemberTable } from "@/components/member-table";
import { SectionNav } from "@/components/section-nav";
import { UnsavedGuard } from "@/components/unsaved-guard";
import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import {
  addProjectMember,
  createNotificationChannel,
  deleteNotificationChannel,
  getApprovalPolicy,
  getProject,
  getProjectBudget,
  listNotificationChannels,
  listOrganizations,
  testNotificationChannels,
  updateApprovalPolicy,
  updateProjectBudget,
  listProjectMembers,
  removeProjectMember,
  updateProjectMemberRole,
  updateProjectSettings,
} from "@/lib/api";
import { describeError, isNotFound } from "@/lib/errors";
import { getServerT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Project settings" };

export default async function ProjectSettingsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { t } = await getServerT();
  let project;
  let members: Awaited<ReturnType<typeof listProjectMembers>> = { members: [], canManage: false };
  let budget: Awaited<ReturnType<typeof getProjectBudget>> = { monthlyCapWei: null, spentThisMonthWei: "0" };
  let policy: Awaited<ReturnType<typeof getApprovalPolicy>> = { requiredRole: "owner", maxCostCapWei: null, expiresInSeconds: 900 };
  let channels: Awaited<ReturnType<typeof listNotificationChannels>> = [];
  let organizations: Awaited<ReturnType<typeof listOrganizations>> = [];
  try {
    project = await getProject(id);
    members = await listProjectMembers(id);
    organizations = await listOrganizations();
    [budget, policy, channels] = await Promise.all([
      getProjectBudget(id),
      getApprovalPolicy(id),
      listNotificationChannels(id),
    ]);
  } catch (error) {
    if (isNotFound(error)) notFound();
    return (
      <>
        <PageHeader eyebrow={t("project.eyebrow")} title={t("settings.title")} />
        <ErrorNotice title={t("settings.loadError")} message={describeError(error)} />
      </>
    );
  }

  async function saveSettings(formData: FormData): Promise<void> {
    "use server";
    try {
      await updateProjectSettings(id, {
        buildCommand: String(formData.get("buildCommand") ?? ""),
        installCommand: String(formData.get("installCommand") ?? ""),
        outputDirectory: String(formData.get("outputDirectory") ?? ""),
        isArchived: formData.get("isArchived") === "on",
        pathMode: formData.get("pathMode") === "root" ? "root" : "versioned",
        organizationId: String(formData.get("organizationId") ?? "") === "" ? null : String(formData.get("organizationId")),
      });
      revalidatePath(`/projects/${id}/settings`);
    } catch (error) {
      redirect(`/projects/${id}/settings?error=${encodeURIComponent(describeError(error))}`);
    }
    redirect(`/projects/${id}/settings?saved=1`);
  }

  async function addMember(formData: FormData): Promise<void> {
    "use server";
    try {
      await addProjectMember(
        id,
        String(formData.get("githubLogin") ?? ""),
        formData.get("role") === "owner" ? "owner" : "member",
      );
      revalidatePath(`/projects/${id}/settings`);
    } catch (error) {
      redirect(`/projects/${id}/settings?error=${encodeURIComponent(describeError(error))}`);
    }
    redirect(`/projects/${id}/settings?saved=member`);
  }

  async function changeMemberRole(userId: string, role: "owner" | "admin" | "member"): Promise<void> {
    "use server";
    if (role === "admin") throw new Error("Unsupported project role");
    await updateProjectMemberRole(id, userId, role);
    revalidatePath(`/projects/${id}/settings`);
  }

  async function removeMember(userId: string): Promise<void> {
    "use server";
    await removeProjectMember(id, userId);
    revalidatePath(`/projects/${id}/settings`);
  }

  async function saveBudget(formData: FormData): Promise<void> {
    "use server";
    try {
      const raw = String(formData.get("monthlyCapWei") ?? "").trim();
      await updateProjectBudget(id, raw === "" ? null : raw);
    } catch (error) {
      redirect(`/projects/${id}/settings?error=${encodeURIComponent(describeError(error))}`);
    }
    redirect(`/projects/${id}/settings?saved=budget`);
  }

  async function savePolicy(formData: FormData): Promise<void> {
    "use server";
    try {
      const raw = String(formData.get("maxCostCapWei") ?? "").trim();
      await updateApprovalPolicy(id, {
        requiredRole: (formData.get("requiredRole") as "owner" | "maintainer" | "member") ?? "owner",
        maxCostCapWei: raw === "" ? null : raw,
        expiresInSeconds: Number(formData.get("expiresInSeconds") ?? 900),
      });
    } catch (error) {
      redirect(`/projects/${id}/settings?error=${encodeURIComponent(describeError(error))}`);
    }
    redirect(`/projects/${id}/settings?saved=policy`);
  }

  async function addChannel(formData: FormData): Promise<void> {
    "use server";
    try {
      await createNotificationChannel(
        id,
        formData.get("kind") === "email" ? "email" : "slack",
        String(formData.get("target") ?? ""),
      );
    } catch (error) {
      redirect(`/projects/${id}/settings?error=${encodeURIComponent(describeError(error))}`);
    }
    redirect(`/projects/${id}/settings?saved=channel`);
  }

  async function removeChannel(formData: FormData): Promise<void> {
    "use server";
    try {
      await deleteNotificationChannel(id, String(formData.get("channelId") ?? ""));
    } catch (error) {
      redirect(`/projects/${id}/settings?error=${encodeURIComponent(describeError(error))}`);
    }
    redirect(`/projects/${id}/settings?saved=channel`);
  }

  async function testChannels(): Promise<void> {
    "use server";
    try {
      await testNotificationChannels(id);
    } catch (error) {
      redirect(`/projects/${id}/settings?error=${encodeURIComponent(describeError(error))}`);
    }
    redirect(`/projects/${id}/settings?saved=tested`);
  }

  return (
    <div className="console-page page--settings">
      <PageHeader
        eyebrow={
          <>
            <Link href={`/projects/${project.id}`}>{project.repoFullName}</Link> / {t("settings.title")}
          </>
        }
        title={t("settings.title")}
        lede={t("console.settingsLede")}
        actions={<Link className="button button-ghost" href={`/projects/${project.id}`}>{t("settings.back")}</Link>}
      />
      {query.error === undefined ? null : <ErrorNotice title={t("settings.changeRefused")} message={query.error} />}
      {query.saved === undefined ? null : <p className="filter-summary" role="status">{t("settings.saved")}.</p>}
      <UnsavedGuard formSelector=".settings-grid form" />
      <div className="settings-grid">
        <SectionNav
          label={t("settings.sections")}
          items={[
            { id: "build-settings-heading", label: t("settings.buildConfig") },
            { id: "members-heading", label: t("settings.members") },
            { id: "budget-heading", label: t("settings.costBudget") },
            { id: "policy-heading", label: t("settings.approvalPolicy") },
            { id: "danger-heading", label: t("settings.dangerZone") },
            { id: "channels-heading", label: t("settings.channels") },
          ]}
        />
      <section className="panel" aria-labelledby="build-settings-heading">
        <div className="panel-head"><h2 id="build-settings-heading">{t("settings.buildConfig")}</h2></div>
        <form className="stack-form" action={saveSettings}>
          <div className="field">
            <label htmlFor="buildCommand">{t("settings.buildCommand")}</label>
            <input id="buildCommand" name="buildCommand" defaultValue={project.buildCommand} required />
          </div>
          <div className="field">
            <label htmlFor="installCommand">{t("settings.installCommand")}</label>
            <input id="installCommand" name="installCommand" defaultValue={project.installCommand} required />
          </div>
          <div className="field">
            <label htmlFor="outputDirectory">{t("settings.outputDirectory")}</label>
            <input id="outputDirectory" name="outputDirectory" defaultValue={project.outputDirectory} required />
          </div>
          <div className="field">
            <label htmlFor="pathMode">{t("settings.pathMode")}</label>
            <select id="pathMode" name="pathMode" defaultValue={project.pathMode}>
              <option value="versioned">{t("settings.pathModeVersioned")}</option>
              <option value="root">{t("settings.pathModeRoot")}</option>
            </select>
            <p className="field-hint">{t("settings.pathModeHint")}</p><p className="field-hint">{t("console.pathHandoff")}</p>
          </div>
          <div className="field">
            <label htmlFor="organizationId">{t("settings.organization")}</label>
            <select id="organizationId" name="organizationId" defaultValue={project.organizationId ?? ""}>
              <option value="">{t("settings.noOrganization")}</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>{organization.name}</option>
              ))}
            </select>
          </div>
          <FeedbackButton className="button button-primary" type="submit" pendingLabel={t("common.loading")}>{t("settings.save")}</FeedbackButton>
        </form>
      </section>

      <section className="panel" aria-labelledby="members-heading">
        <div className="panel-head">
          <h2 id="members-heading">{t("settings.members")}</h2>
          <span className="panel-meta">{t("console.memberCount", { count: members.members.length })}</span>
        </div>
        <MemberTable members={members.members} canManage={members.canManage} currentUserId={null}
          scope="project" protectedUserId={members.protectedUserId}
          onChangeRole={changeMemberRole} onRemove={removeMember} />
        {members.canManage ? (
          <form className="filter-form" action={addMember}>
            <div className="field">
              <label htmlFor="githubLogin">{t("settings.githubLogin")}</label>
              <input id="githubLogin" name="githubLogin" placeholder="octocat" required />
            </div>
            <div className="field">
              <label htmlFor="new-member-role">{t("settings.role")}</label>
              <select id="new-member-role" name="role" defaultValue="member">
                <option value="member">{t("org.memberRole")}</option>
                <option value="owner">{t("org.owner")}</option>
              </select>
            </div>
            <div className="filter-actions"><FeedbackButton className="button button-primary" type="submit" pendingLabel={t("common.loading")}>{t("settings.addMember")}</FeedbackButton></div>
          </form>
        ) : (
          <p className="field-hint">{t("settings.onlyOwners")}</p>
        )}
      </section>

      <section className="panel" aria-labelledby="budget-heading">
        <div className="panel-head"><h2 id="budget-heading">{t("settings.costBudget")}</h2></div>
        <p className="field-hint">{t("org.spent")}: <strong>{budget.spentThisMonthWei}</strong> wei ({t("console.estimated")}).</p>
        <form className="filter-form" action={saveBudget}>
          <div className="field">
            <label htmlFor="monthlyCapWei">{t("org.monthlyCap")}</label>
            <input id="monthlyCapWei" name="monthlyCapWei" defaultValue={budget.monthlyCapWei ?? ""} inputMode="numeric" />
          </div>
          <div className="filter-actions"><FeedbackButton className="button button-primary" type="submit" pendingLabel={t("common.loading")}>{t("org.saveBudget")}</FeedbackButton></div>
        </form>
      </section>

      <section className="panel" aria-labelledby="policy-heading">
        <div className="panel-head"><h2 id="policy-heading">{t("settings.approvalPolicy")}</h2></div>
        <form className="filter-form fields-grid" action={savePolicy}>
          <div className="field">
            <label htmlFor="requiredRole">{t("settings.role")}</label>
            <select id="requiredRole" name="requiredRole" defaultValue={policy.requiredRole}>
              <option value="owner">{t("org.owner")}</option>
              <option value="maintainer">{t("settings.maintainerOwner")}</option>
              <option value="member">{t("settings.anyMember")}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="maxCostCapWei">{t("settings.maxCostCap")}</label>
            <input id="maxCostCapWei" name="maxCostCapWei" defaultValue={policy.maxCostCapWei ?? ""} inputMode="numeric" />
          </div>
          <div className="field">
            <label htmlFor="expiresInSeconds">{t("settings.approvalTtl")}</label>
            <input id="expiresInSeconds" name="expiresInSeconds" type="number" min={60} max={86400} defaultValue={policy.expiresInSeconds} />
          </div>
          <div className="filter-actions"><FeedbackButton className="button button-primary" type="submit" pendingLabel={t("common.loading")}>{t("settings.save")}</FeedbackButton></div>
        </form>
      </section>

      <section className="panel danger-zone" aria-labelledby="danger-heading">
        <div className="panel-head">
          <h2 id="danger-heading">{t("settings.dangerZone")}</h2>
          <span className="panel-meta">{t("settings.dangerZoneHint")}</span>
        </div>
        <form className="stack-form" action={saveSettings}>
          <input type="hidden" name="buildCommand" value={project.buildCommand} />
          <input type="hidden" name="installCommand" value={project.installCommand} />
          <input type="hidden" name="outputDirectory" value={project.outputDirectory} />
          <input type="hidden" name="organizationId" value={project.organizationId ?? ""} />
          <input type="hidden" name="pathMode" value={project.pathMode} />
          <p className="field-hint">{t("settings.archiveHint")}</p>
          <label className="checkbox-field">
            <input type="checkbox" name="isArchived" defaultChecked={project.isArchived} /> {t("console.archive")}
          </label>
          <FeedbackButton className="button button-danger" type="submit" pendingLabel={t("common.loading")}>{t("settings.archiveSave")}</FeedbackButton>
        </form>
      </section>

      <section className="panel" aria-labelledby="channels-heading">
        <div className="panel-head">
          <h2 id="channels-heading">{t("settings.channels")}</h2>
          <form action={testChannels}><FeedbackButton className="button button-ghost" type="submit" pendingLabel={t("common.loading")}>{t("settings.test")}</FeedbackButton></form>
        </div>
        <div className="table-wrap" role="region" aria-label={t("settings.channels")} tabIndex={0}>
          <table className="table">
            <caption className="visually-hidden">{t("settings.channels")}</caption>
            <thead><tr><th scope="col">{t("console.kind")}</th><th scope="col">{t("settings.target")}</th><th scope="col">{t("settings.enabled")}</th><th scope="col">{t("settings.action")}</th></tr></thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.id}>
                  <td>{channel.kind}</td>
                  <td className="mono">{channel.target}</td>
                  <td>{channel.enabled ? t("common.yes") : t("common.no")}</td>
                  <td>
                    <form action={removeChannel}>
                      <input type="hidden" name="channelId" value={channel.id} />
                      <FeedbackButton className="button button-ghost" type="submit" pendingLabel={t("common.loading")}>{t("settings.remove")}</FeedbackButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="filter-form" action={addChannel}>
          <div className="field">
            <label htmlFor="channel-kind">{t("console.kind")}</label>
            <select id="channel-kind" name="kind" defaultValue="slack">
              <option value="slack">{t("settings.slack")}</option>
              <option value="email">{t("settings.email")}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="channel-target">{t("settings.target")}</label>
            <input id="channel-target" name="target" placeholder="https://hooks.slack.com/… or ops@example.com" required />
          </div>
          <div className="filter-actions"><FeedbackButton className="button button-primary" type="submit" pendingLabel={t("common.loading")}>{t("settings.addChannel")}</FeedbackButton></div>
        </form>
      </section>
      </div>
    </div>
  );
}
