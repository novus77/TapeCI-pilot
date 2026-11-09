import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BindNameForm } from "@/components/bind-name-form";
import { DeploymentTable } from "@/components/deployment-table";
import { ErrorNotice } from "@/components/error-notice";
import { PageHeader } from "@/components/page-header";
import { EmptyState, RiskNotice, type NoticeTone } from "@/components/risk-notice";
import { StatusChip } from "@/components/stage-badge";
import { getContainer, getContainerBinding, listDeployments, listProjects } from "@/lib/api";
import { X_LAYER_AREA_CODE, suggestedName, validateBindName } from "@/lib/binding";
import { describeError, isNotFound } from "@/lib/errors";
import {
  formatUtcDateTime,
  formatWeiAsOkb,
  isHexAddress,
  shortValue,
  ttlStatus,
  type TtlStatus,
} from "@/lib/format";
import { getServerT } from "@/lib/i18n-server";
import type { ServerT } from "@/lib/i18n-server";
import type {
  BindingState,
  ContainerBindingStatus,
  ContainerDetail,
  DeploymentSummary,
  Project,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Container" };

interface SessionRow {
  readonly id: string;
  readonly signerAddress: string;
  readonly approvalId: string | null;
  readonly createdAt: string | null;
  readonly expiresAt: string;
  readonly ttl: TtlStatus;
}

function sessionTone(row: SessionRow): "critical" | "warning" | "healthy" | "revoked" | "expired" {
  return row.ttl.tone;
}

function overallRisk(rows: readonly SessionRow[]): {
  readonly tone: NoticeTone;
  readonly title: string;
} {
  if (rows.some((row) => sessionTone(row) === "expired")) {
    return {
      tone: "critical",
      title: "An operator session has expired",
    };
  }
  if (rows.some((row) => sessionTone(row) === "critical")) {
    return {
      tone: "critical",
      title: "An operator session expires within six hours",
    };
  }
  if (rows.some((row) => sessionTone(row) === "warning")) {
    return {
      tone: "warning",
      title: "An operator session expires within a day",
    };
  }
  const active = rows.filter(
    (row) => row.ttl.tone === "healthy" || row.ttl.tone === "warning" || row.ttl.tone === "critical",
  );
  if (active.length === 0) {
    return {
      tone: "warning",
      title: "No active operator session",
    };
  }
  return {
    tone: "success",
    title: "Operator sessions are within their TTL",
  };
}

/** TapeKit names are `<tokenId>.<area>.<processorIndex>.tape` on X Layer 196. */

function firstSearchParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) return null;
  const trimmed = first.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function bindingStateLabel(t: ServerT, state: BindingState): string {
  switch (state) {
    case "ACTIVE":
      return t("binding.stateActive");
    case "EXPIRED":
      return t("binding.stateExpired");
    default:
      return t("binding.stateInactive");
  }
}

function bindingStateTone(state: BindingState): "success" | "danger" | "warning" {
  switch (state) {
    case "ACTIVE":
      return "success";
    case "EXPIRED":
      return "warning";
    default:
      return "danger";
  }
}

function paidUntilIso(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? new Date(seconds * 1000).toISOString() : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export default async function ContainerPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ address: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { address } = await params;
  const query = await searchParams;
  const { locale, t } = await getServerT();
  if (!isHexAddress(address)) notFound();

  let container: ContainerDetail;
  try {
    container = await getContainer(address);
  } catch (error) {
    if (isNotFound(error)) notFound();
    return (
      <>
        <PageHeader eyebrow={t("container.title")} title={t("container.title")} />
        <ErrorNotice title={t("container.loadError")} message={describeError(error)} />
      </>
    );
  }

  let projects: readonly Project[] = [];
  let deployments: readonly DeploymentSummary[] = [];
  let loadError: string | null = null;
  let bindingError: string | null = null;
  try {
    const [loadedProjects, loadedDeployments] = await Promise.all([
      listProjects(),
      listDeployments({ limit: 200 }),
    ]);
    projects = loadedProjects;
    deployments = loadedDeployments;
  } catch (error) {
    loadError = describeError(error);
  }

  const rows: readonly SessionRow[] = container.operatorSessions.map((session) => ({
    id: session.id,
    signerAddress: session.signerAddress,
    approvalId: session.approvalId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    ttl: ttlStatus(session.expiresAt, session.revokedAt),
  }));
  const risk = overallRisk(rows);
  const ownershipChanged =
    container.ownerAddress.toLowerCase() !== container.lastObservedOwner.toLowerCase();
  const relatedProjects = projects.filter(
    (project) => project.container.address.toLowerCase() === container.address.toLowerCase(),
  );
  const relatedProjectIds = new Set(relatedProjects.map((project) => project.id));
  const relatedDeployments = deployments.filter((deployment) =>
    relatedProjectIds.has(deployment.projectId),
  );

  // The on-chain name: `?name=` wins, otherwise the name TapeKit derives from the
  // container (<tokenId>.<area>.<processorIndex>.tape).
  const queryName = firstSearchParam(query["name"]);
  const derivedName = suggestedName(container.tokenId, X_LAYER_AREA_CODE, container.processorIndex);
  const requestedName =
    queryName === null ? null : validateBindName(queryName) === null ? queryName : null;
  const displayName = requestedName ?? derivedName;
  let binding: ContainerBindingStatus | null = null;
  try {
    binding = await getContainerBinding(container.address, {
      ...(requestedName === null ? {} : { name: requestedName }),
    });
    if (binding !== null && binding.suggestedName.length === 0) {
      binding = { ...binding, suggestedName: derivedName };
    }
  } catch (error) {
    // A malformed payload or an unexpected status must not fail the page: the
    // panel degrades to the neutral "status unavailable" line.
    binding = null;
    bindingError = describeError(error);
  }

  return (
    <div className="console-page page--container">
      <PageHeader
        eyebrow={
          <>
            <Link href="/">{t("nav.overview")}</Link> / {t("container.title")}
          </>
        }
        title={
          <span className="mono" title={container.address}>
            {shortValue(container.address, 12, 8)}
          </span>
        }
        lede={
          <>
            {t("container.title")} <code className="mono">{container.address}</code> ·{" "}
            {t("container.lede")}
          </>
        }
        actions={
          <StatusChip
            label={container.opened ? t("container.opened") : t("project.openedNot")}
            tone={container.opened ? "success" : "danger"}
          />
        }
      />

      {loadError === null ? null : (
        <ErrorNotice title="Some container data could not be loaded" message={loadError} />
      )}

      {ownershipChanged ? (
        <RiskNotice tone="critical" title="Ownership changed since the last check">
          <p>
            Last observed owner <code className="mono">{container.lastObservedOwner}</code> differs
            from the recorded owner <code className="mono">{container.ownerAddress}</code>. TapeCI
            stops writing on OWNERSHIP_CHANGED until the project is re-verified.
          </p>
        </RiskNotice>
      ) : null}

      <RiskNotice tone={risk.tone} title={risk.title}>
        <p>
          TTL risk: operator sessions are temporary chain-write grants. The signer can write to this container
          until the session expires or is revoked; approval is bound to a manifest hash and an
          approved cost cap, so it cannot publish a different release.
        </p>
        <p>
          If the session expires mid-release, the next write is refused and the deployment stops.
          If the container owner changes, writes fail closed with OWNERSHIP_CHANGED. Revoke sessions
          you no longer need.
        </p>
      </RiskNotice>

      <section
        className="panel bind-panel"
        aria-labelledby="binding-heading"
        data-testid="binding-panel"
      >
        <div className="panel-head">
          <h2 id="binding-heading">{t("binding.heading")}</h2>
          <span className="panel-meta">
            {container.chainId} · {shortValue(container.bindingAddress, 10, 8)}
          </span>
        </div>

        {binding === null ? (
          <p className="field-hint" data-testid="binding-status-unavailable">
            {t("binding.statusUnavailable")}
          </p>
        ) : (
          <dl className="meta-grid">
            <div className="meta-item">
              <dt>{binding.nameRecorded ? t("binding.savedName") : t("binding.suggestedName")}</dt>
              <dd className="mono" title={displayName} data-testid="binding-name">
                {displayName}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("binding.state")}</dt>
              <dd data-testid="binding-state" data-state={binding.state}>
                <StatusChip
                  label={bindingStateLabel(t, binding.state)}
                  tone={bindingStateTone(binding.state)}
                />
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("binding.paidUntil")}</dt>
              <dd data-testid="binding-paid-until">
                {binding.paidUntil === null
                  ? t("binding.paidUntilNone")
                  : formatUtcDateTime(paidUntilIso(binding.paidUntil))}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("binding.monthlyFee")}</dt>
              <dd className="mono" data-testid="binding-monthly-fee">
                {formatWeiAsOkb(binding.monthlyFeeWei, t("console.unknown"))}
              </dd>
            </div>
          </dl>
        )}

        <p className="panel-copy" data-testid="binding-next-action">
          <strong>{t("binding.nextAction")}:</strong>{" "}
          {binding === null
            ? t("binding.statusUnavailable")
            : binding.state === "ACTIVE"
              ? t("binding.nextActionActive", {
                  date: formatUtcDateTime(paidUntilIso(binding.paidUntil)),
                })
              : binding.state === "EXPIRED"
                ? t("binding.nextActionExpired")
                : t("binding.nextActionInactive")}
        </p>

        {bindingError === null ? null : <p className="visually-hidden">{bindingError}</p>}

        <BindNameForm
          containerAddress={container.address}
          bindingAddress={container.bindingAddress}
          ownerAddress={container.ownerAddress}
          suggestedName={binding?.suggestedName ?? derivedName}
          initialName={displayName}
          defaultMonths={1}
          status={binding}
        />
      </section>
      <div className="detail-grid">
        <section className="panel" aria-labelledby="ownership-heading">
          <div className="panel-head">
            <h2 id="ownership-heading">{t("container.ownership")}</h2>
            <span className="panel-meta">
              {t("deployment.block")} {container.lastCheckedBlock}
            </span>
          </div>
          <dl className="meta-grid">
            <div className="meta-item">
              <dt>{t("container.currentOwner")}</dt>
              <dd className="mono" title={container.ownerAddress}>
                {container.ownerAddress}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("container.lastObserved")}</dt>
              <dd className="mono" title={container.lastObservedOwner}>
                {container.lastObservedOwner}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("container.opened")}</dt>
              <dd>{container.opened ? t("common.yes") : t("common.no")}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("container.openedAt")}</dt>
              <dd>{formatUtcDateTime(container.openedAt)}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("container.registryImpl")}</dt>
              <dd className="mono" title={container.lastRegistryImpl ?? undefined}>
                {shortValue(container.lastRegistryImpl, 12, 8)}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("container.bindingImpl")}</dt>
              <dd className="mono" title={container.lastBindingImpl ?? undefined}>
                {shortValue(container.lastBindingImpl, 12, 8)}
              </dd>
            </div>
          </dl>
          <p className="panel-copy">
            TapeCI refuses to write if the registry or binding implementation is not on the pinned
            allowlist. The owner is read at the same block as the write plan.
          </p>
        </section>

        <section className="panel" aria-labelledby="roles-heading">
          <div className="panel-head">
            <h2 id="roles-heading">{t("container.roles")}</h2>
            <span className="panel-meta">
              {t("deployment.chain")} {container.chainId}
            </span>
          </div>
          <dl className="meta-grid">
            <div className="meta-item">
              <dt>{t("container.factory")}</dt>
              <dd className="mono" title={container.factoryAddress}>
                {shortValue(container.factoryAddress, 12, 8)}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("container.processor")}</dt>
              <dd className="mono" title={container.processorAddress}>
                #{container.processorIndex} · {shortValue(container.processorAddress, 10, 6)}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("container.tokenId")}</dt>
              <dd>{container.tokenId}</dd>
            </div>
            <div className="meta-item">
              <dt>{t("container.opener")}</dt>
              <dd className="mono" title={container.openerAddress}>
                {shortValue(container.openerAddress, 12, 8)}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("container.registry")}</dt>
              <dd className="mono" title={container.registryAddress}>
                {shortValue(container.registryAddress, 12, 8)}
              </dd>
            </div>
            <div className="meta-item">
              <dt>{t("container.domainBinding")}</dt>
              <dd className="mono" title={container.bindingAddress}>
                {shortValue(container.bindingAddress, 12, 8)}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="section" aria-labelledby="sessions-heading">
        <div className="section-head">
          <h2 id="sessions-heading">{t("container.operatorSessions")}</h2>
          <span className="section-meta">
            {rows.length} session{rows.length === 1 ? "" : "s"}
          </span>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            title={t("container.noOperatorSessions")}
            message="No temporary signer is authorized for this container. A release cannot execute until an approval creates a session."
          />
        ) : (
          <div
            className="table-wrap"
            role="region"
            aria-label={t("container.rolesTable")}
            tabIndex={0}
          >
            <table className="table">
              <caption className="visually-hidden">
                Operator sessions and their remaining TTL
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("container.signer")}</th>
                  <th scope="col">{t("container.approval")}</th>
                  <th scope="col">{t("container.created")}</th>
                  <th scope="col">{t("container.expires")}</th>
                  <th scope="col">{t("container.ttlStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <code title={row.signerAddress}>{shortValue(row.signerAddress, 10, 8)}</code>
                    </td>
                    <td>{row.approvalId === null ? "—" : <code>{row.approvalId}</code>}</td>
                    <td>
                      <time dateTime={row.createdAt ?? undefined}>
                        {formatUtcDateTime(row.createdAt)}
                      </time>
                    </td>
                    <td>
                      <time dateTime={row.expiresAt}>{formatUtcDateTime(row.expiresAt)}</time>
                    </td>
                    <td>
                      <span className={`ttl ttl-${row.ttl.tone}`} data-tone={row.ttl.tone}>
                        {row.ttl.label}
                      </span>
                      <span className="ttl-detail">{row.ttl.detail}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="container-projects-heading">
        <div className="section-head">
          <h2 id="container-projects-heading">{t("container.projectsUsing")}</h2>
        </div>
        {relatedProjects.length === 0 ? (
          <EmptyState
            title={t("container.noProject")}
            message="A project binds a repository and branch to this container."
          />
        ) : (
          <ul className="plain-list">
            {relatedProjects.map((project) => (
              <li key={project.id}>
                <Link href={`/projects/${project.id}`}>{project.repoFullName}</Link> · branch{" "}
                <code>{project.defaultBranch}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section" aria-labelledby="container-deployments-heading">
        <div className="section-head">
          <h2 id="container-deployments-heading">{t("container.deployments")}</h2>
        </div>
        <DeploymentTable
          deployments={relatedDeployments.slice(0, 10)}
          caption={t("container.deployments")}
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
