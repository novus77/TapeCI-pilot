"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { ConfirmButton } from "./confirm-button";
import { useT } from "./locale-provider";
import { describeError } from "@/lib/errors";
import {
  avatarColor,
  filterAndSortMembers,
  initials,
  isLastOwner,
  relativeTime,
  type MemberSort,
} from "@/lib/members";
export interface OrganizationMember {
  readonly userId: string;
  readonly githubLogin: string;
  readonly role: string;
  readonly createdAt: string;
  readonly lastActivityAt?: string | null;
  /** NULL/absent means the grant never expires. */
  readonly expiresAt?: string | null;
  readonly source?: "direct" | "inherited";
  readonly directRole?: string | null;
  readonly inheritedRole?: string | null;
}

const ROLE_KEYS = {
  owner: "org.owner",
  admin: "org.admin",
  member: "org.memberRole",
} as const;

export interface MemberTableProps {
  readonly members: readonly OrganizationMember[];
  readonly canManage: boolean;
  readonly currentUserId: string | null;
  readonly scope?: "organization" | "project";
  readonly protectedUserId?: string;
  readonly onChangeRole: (userId: string, role: "owner" | "admin" | "member") => Promise<void>;
  readonly onRemove: (userId: string) => Promise<void>;
}

/**
 * Member table with initials avatar, in-place role change and a client-side
 * filter/sort toolbar. The server stays the authority: every change is a request
 * that the API re-validates, and a failure reverts the control.
 */
export function MemberTable({ members, canManage, currentUserId, scope = "organization", protectedUserId, onChangeRole, onRemove }: MemberTableProps) {
  const { t, locale } = useT();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const [sort, setSort] = useState<MemberSort>("role");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const now = useMemo(() => Date.now(), []);

  const visible = useMemo(
    () => filterAndSortMembers(members, { query, role, sort }),
    [members, query, role, sort],
  );

  async function changeRole(userId: string, nextRole: "owner" | "admin" | "member"): Promise<void> {
    setBusyId(userId);
    setError(null);
    try {
      await onChangeRole(userId, nextRole);
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(userId: string): Promise<void> {
    setBusyId(userId);
    setError(null);
    try {
      await onRemove(userId);
      startTransition(() => router.refresh());
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="filter-form member-toolbar">
        <div className="field">
          <label htmlFor="member-filter">{t("members.filter")}</label>
          <input
            id="member-filter"
            type="search"
            value={query}
            placeholder={t("members.filterPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="member-role">{t("org.role")}</label>
          <select id="member-role" value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="">{t("members.allRoles")}</option>
            <option value="owner">{t("org.owner")}</option>
            {scope === "organization" ? <option value="admin">{t("org.admin")}</option> : <option value="maintainer">{t("members.maintainer")}</option>}
            <option value="member">{t("org.memberRole")}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="member-sort">{t("members.sort")}</label>
          <select
            id="member-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as MemberSort)}
          >
            <option value="role">{t("members.sortRole")}</option>
            <option value="newest">{t("members.sortNewest")}</option>
            <option value="active">{t("members.sortActive")}</option>
          </select>
        </div>
        <p className="filter-summary member-toolbar-note" role="status">
          {t("members.scope", { count: members.length })}
        </p>
      </div>

      {error === null ? null : (
        <div className="notice notice-critical" role="alert">
          <div className="notice-content">
            <p className="notice-title">{error}</p>
          </div>
        </div>
      )}

      <p className="field-hint">{t("members.activityHint")}</p>
      <div className="table-wrap" role="region" aria-label={t("org.members")} tabIndex={0}>
        <table className="table member-table table-responsive" data-testid="member-table">
          <caption className="visually-hidden">{t("org.members")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("members.member")}</th>
              <th scope="col">{t("org.role")}</th>
              {scope === "project" ? <th scope="col">{t("members.source")}</th> : null}
              <th scope="col">{t("members.lastActivity")}</th>
              <th scope="col">
                <span className="visually-hidden">{t("org.action")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={scope === "project" ? 5 : 4}>
                  <p className="field-hint">
                    {members.length === 0 ? t("members.noneYet") : t("members.noMatch")}
                  </p>
                  {members.length === 0 ? null : (
                    <button
                      type="button"
                      className="button button-ghost"
                      onClick={() => {
                        setQuery("");
                        setRole("");
                      }}
                    >
                      {t("members.clearFilters")}
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              visible.map((member) => {
                const lastOwner = member.userId === protectedUserId || (scope === "project"
                  ? isLastOwner(members.filter((row) => row.directRole === "owner"), member.userId)
                  : isLastOwner(members, member.userId));
                const inherited = scope === "project" && member.source === "inherited";
                const activity = relativeTime(member.lastActivityAt ?? null, now, locale);
                const busy = busyId === member.userId;
                return (
                  <tr key={member.userId} data-testid="member-row" aria-busy={busy}>
                    <td>
                      <div className="member-cell">
                        <span
                          className="member-avatar"
                          style={{ backgroundColor: avatarColor(member.githubLogin) }}
                          aria-hidden="true"
                        >
                          {initials(member.githubLogin)}
                        </span>
                        <span className="member-identity">
                          <span className="member-login">{member.githubLogin}</span>
                          <span className="member-meta">
                            {t("members.joined", { date: member.createdAt.slice(0, 10) })}
                            {member.expiresAt === null || member.expiresAt === undefined
                              ? null
                              : ` · ${t("members.expires", { date: member.expiresAt.slice(0, 10) })}`}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td data-label={t("org.role")}>
                      {canManage && !inherited ? (
                        <select
                          className="member-role-select"
                          data-testid="member-role-select"
                          value={scope === "project" ? member.directRole ?? member.role : member.role}
                          disabled={busy || lastOwner}
                          title={lastOwner ? t(scope === "project" ? "members.projectOwnerHint" : "members.lastOwnerHint") : undefined}
                          aria-label={t("members.changeRoleFor", { login: member.githubLogin })}
                          onChange={(event) =>
                            void changeRole(member.userId, event.target.value as "owner" | "admin" | "member")
                          }
                        >
                          <option value="owner">{t("org.owner")}</option>
                          {scope === "organization" ? <option value="admin">{t("org.admin")}</option> : null}
                          <option value="member">{t("org.memberRole")}</option>
                        </select>
                      ) : (
                        <span className="badge">{member.role === "maintainer" ? t("members.maintainer") : t(ROLE_KEYS[member.role as keyof typeof ROLE_KEYS] ?? "org.memberRole")}</span>
                      )}
                    </td>
                    {scope === "project" ? <td data-label={t("members.source")}><span className="badge">{t(inherited ? "members.inherited" : "members.direct")}</span>{inherited ? <p className="member-meta">{t("members.inheritedHint")}</p> : null}{member.inheritedRole ? <p className="member-meta">{t("members.retainedAccessHint", { role: member.inheritedRole === "maintainer" ? t("members.maintainer") : t(ROLE_KEYS[member.inheritedRole as keyof typeof ROLE_KEYS] ?? "org.memberRole") })}</p> : null}</td> : null}
                    <td data-label={t("members.lastActivity")}>
                      {activity === null ? (
                        <span className="member-meta">{t("members.noActivity")}</span>
                      ) : (
                        <time dateTime={member.lastActivityAt ?? undefined} title={member.lastActivityAt ?? undefined}>
                          {activity}
                        </time>
                      )}
                    </td>
                    <td className="cell-action">
                      {canManage && !inherited && member.userId !== currentUserId && !lastOwner ? (
                        <ConfirmButton
                          className="button button-ghost member-remove"
                          testId="member-remove"
                          label={t("settings.remove")}
                          pendingLabel={t("members.removing")}
                          confirmLabel={t("members.removeConfirmAction")}
                          title={t("members.removeConfirmTitle", { login: member.githubLogin })}
                          busy={busy}
                          onConfirm={() => void remove(member.userId)}
                        >
                          <p>{t("members.removeConfirmBody", { login: member.githubLogin })}</p>
                          {member.inheritedRole === null || member.inheritedRole === undefined ? null : (
                            <p>{t("members.removeKeepsInherited", { role: member.inheritedRole })}</p>
                          )}
                        </ConfirmButton>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
