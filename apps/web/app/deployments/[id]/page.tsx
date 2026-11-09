import { ReviewTabs } from "@/components/review-tabs";
import { Disclosure } from "@/components/disclosure";
import { CompressionPreparationPanel } from "@/components/compression-preparation-panel";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LiveRefresh } from "@/components/live-refresh";
import { Download } from "lucide-react";
import { CopyValue } from "@/components/copy-value";
import { DeploymentActions } from "@/components/deployment-actions";
import { ErrorNotice } from "@/components/error-notice";
import { EventTimeline } from "@/components/event-timeline";
import { PageHeader } from "@/components/page-header";
import { PlanPanel } from "@/components/plan-panel";
import { ReleaseMilestones } from "@/components/release-milestones";
import { EmptyState, RiskNotice } from "@/components/risk-notice";
import { StageBadge, StateChip, StatusChip } from "@/components/stage-badge";
import { VerificationPanel } from "@/components/verification-panel";
import {
  getDeployment,
  getDeploymentPreparation,
  getDeploymentPlan,
  getVerificationReport,
  isMockMode,
  listDeploymentEvents,
} from "@/lib/api";
import { DEPLOYMENT_VIEWS, deploymentView } from "@/lib/console-views";
import { describeError, isNotFound } from "@/lib/errors";
import {
  formatBytes,
  formatDurationBetween,
  formatInteger,
  formatUtcDateTime,
  formatWeiAsOkb,
  shortValue,
} from "@/lib/format";
import { getServerT } from "@/lib/i18n-server";
import {
  deploymentStage,
  fileStateTone,
  transactionStateTone,
  triggerLabel,
} from "@/lib/states";
import type {
  DeploymentDetail,
  DeploymentPreparation,
  DeploymentEvent,
  DeploymentPlan,
  VerificationReport,
} from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Deployment" };

export default async function DeploymentPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<{ view?: string }>;
}) {
  const { id } = await params;
  const view = deploymentView((await searchParams).view);
  const { locale, t } = await getServerT();
  let deployment: DeploymentDetail;
  try {
    deployment = await getDeployment(id);
  } catch (error) {
    if (isNotFound(error)) notFound();
    return (
      <>
        <PageHeader eyebrow={t("deployment.title")} title={t("deployment.title")} />
        <ErrorNotice title={t("deployment.loadError")} message={describeError(error)} />
      </>
    );
  }

  let preparation: DeploymentPreparation | null = null;
  let preparationError: string | null = null;
  try { preparation = await getDeploymentPreparation(id); } catch (error) { preparationError = describeError(error); }

  let events: readonly DeploymentEvent[] = [];
  let plan: DeploymentPlan | null = null;
  let verification: VerificationReport | null = null;
  let loadError: string | null = null;
  try {
    const [loadedEvents, loadedPlan, loadedVerification] = await Promise.all([
      listDeploymentEvents(deployment.id),
      getDeploymentPlan(deployment.id),
      getVerificationReport(deployment.id),
    ]);
    events = loadedEvents;
    plan = loadedPlan;
    verification = loadedVerification;
  } catch (error) {
    loadError = describeError(error);
  }

  const evidence = {
    releaseVerified: deployment.releaseVerified,
    releaseMatch: verification?.releaseMatch ?? null,
  };
  const stage = deploymentStage(deployment.state, evidence);
  const releaseFiles = deployment.releaseFiles ?? [];
  const transactions = deployment.transactions ?? [];
  const filesExposed = deployment.releaseFiles !== undefined;
  const transactionsExposed = deployment.transactions !== undefined;
  const entry = releaseFiles.find((file) => file.targetPath === "index.html");
  const active = !["LIVE", "BUILD_FAILED", "PLAN_REJECTED", "UPLOAD_FAILED", "VERIFY_FAILED"].includes(deployment.state);
  const entryTooLarge =
    entry !== undefined && (entry.byteSize > 24_000 || entry.chunkCount > 1);

  return (
    <>
      <LiveRefresh active={active} />
      <PageHeader
        eyebrow={
          <>
            <Link href={`/projects/${deployment.projectId}`}>{deployment.project?.repoFullName ?? t("project.eyebrow")}</Link> / <Link href="/deployments">{t("deployments.title")}</Link> /{" "}
            {triggerLabel(deployment.triggerKind)}
          </>
        }
        title={
          <>
            {deployment.project?.repoFullName ?? t("deployment.title")}{" "}
            <StageBadge stage={stage} state={deployment.state} locale={locale} currentState />
          </>
        }
        lede={
          <>
            {t("deployment.commit")}{" "}
            <code className="mono" title={deployment.commitSha}>
              {deployment.commitSha}
            </code>{" "}
            · {t("deployment.title")} <code className="mono">{deployment.id}</code>
          </>
        }
        actions={
          <>
            <Link className="button button-ghost" href={`/deployments/${deployment.id}/evidence`}>
              <Download size={14} aria-hidden="true" /> {t("console.export")}
            </Link>

          </>
        }
      />

      {loadError === null ? null : (
        <ErrorNotice
          title={t("console.evidenceError")}
          message={loadError}
          hint={t("console.evidenceHint")}
        />
      )}

      {deployment.errorCode === null ? null : (
        <RiskNotice
          tone="critical"
          title={t("console.stopped", { state: t(`state.${deployment.state}`) })}
        >
          <p>
            <code>{deployment.errorCode}</code>
            {deployment.errorMessage === null ? "" : ` — ${deployment.errorMessage}`}
          </p>
          {deployment.state === "BUILD_FAILED" ? (
            <p>
              {t("console.failureBuild")}
            </p>
          ) : (
            <p>
              {t("console.failureClosed")}
            </p>
          )}
        </RiskNotice>
      )}

      <Disclosure className="release-context" data-testid="deployment-result" title={t("console.checkActivation")}>
        <p>{t("console.historicalRelease")} <Link href={`/projects/${deployment.projectId}`}>{t("home.openProject")}</Link></p>
        <p>{t("console.activationBody")}</p>
        {deployment.containerAddress === null ? null : <Link className="button" href={`/containers/${deployment.containerAddress}`}>{t("console.checkActivation")}</Link>}
      </Disclosure>
      <section className="panel release-progress-panel" aria-labelledby="milestones-heading">
        <div className="panel-head">
          <h2 id="milestones-heading">{t("milestones.title")}</h2>
        </div>
        <ReleaseMilestones state={deployment.state} evidence={evidence} />
      </section>



      <div className="deployment-workspace">
      <div className="deployment-main">
      <ReviewTabs label={t("console.sections")} items={DEPLOYMENT_VIEWS.map(section => ({ href: `/deployments/${deployment.id}?view=${section}`, label: t(`console.${section}`), active: view === section }))} />

      {view === "overview" ? <>
        <CompressionPreparationPanel key={deployment.id} deploymentId={deployment.id} preparation={preparation} error={preparationError} />
      <section className="panel" aria-labelledby="meta-heading">
        <div className="panel-head">
          <h2 id="meta-heading">{t("deployment.details")}</h2>
          <span className="panel-meta mono"><StateChip state={deployment.state} /> · v{deployment.stateVersion}</span>
        </div>
        <dl className="meta-grid">
          <div className="meta-item">
            <dt>{t("table.project")}</dt>
            <dd>
              <Link href={`/projects/${deployment.projectId}`}>
                {deployment.project?.repoFullName ?? deployment.projectId}
              </Link>
            </dd>
          </div>
          <div className="meta-item">
            <dt>{t("deployment.branch")}</dt>
            <dd>
              <code>{deployment.project?.defaultBranch ?? t("console.unknown")}</code>
            </dd>
          </div>
          <div className="meta-item">
            <dt>{t("container.title")}</dt>
            <dd>
              {deployment.containerAddress === null ? (
                t("console.unknown")
              ) : (
                <span className="copy-value">
                  <Link className="mono" href={`/containers/${deployment.containerAddress}`}>
                    {shortValue(deployment.containerAddress, 10, 8)}
                  </Link>
                  <CopyValue
                    value={deployment.containerAddress}
                    label={t("home.container")}
                    display=""
                  />
                </span>
              )}
            </dd>
          </div>
          <div className="meta-item">
            <dt>{t("deployment.chain")}</dt>
            <dd>{deployment.targetChainId}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("container.registry")}</dt>
            <dd className="mono" title={deployment.registryAddress ?? undefined}>
              {shortValue(deployment.registryAddress, 10, 8)}
            </dd>
          </div>
          <div className="meta-item">
            <dt>{t("deployment.trigger")}</dt>
            <dd>{triggerLabel(deployment.triggerKind)}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("deployment.requested")}</dt>
            <dd>
              <time dateTime={deployment.requestedAt}>
                {formatUtcDateTime(deployment.requestedAt)}
              </time>
            </dd>
          </div>
          <div className="meta-item">
            <dt>{t("deployment.started")}</dt>
            <dd>{formatUtcDateTime(deployment.startedAt)}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("deployment.finished")}</dt>
            <dd>{formatUtcDateTime(deployment.finishedAt)}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("deployment.duration")}</dt>
            <dd>{formatDurationBetween(deployment.requestedAt, deployment.finishedAt)}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("deployment.estimatedCost")}</dt>
            <dd>{formatWeiAsOkb(deployment.estimatedCostWei, t("console.unknown"))}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("deployment.approvedCap")}</dt>
            <dd>{formatWeiAsOkb(deployment.approvedCostCapWei, t("console.unknown"))}</dd>
          </div>
          <div className="meta-item">
            <dt>{t("deployment.manifestSha")}</dt>
            <dd className="mono">
              {deployment.manifestSha256 === null ? (
                "—"
              ) : (
                <CopyValue
                  value={deployment.manifestSha256}
                  label="manifest SHA-256"
                  display={shortValue(deployment.manifestSha256, 12, 8)}
                />
              )}
            </dd>
          </div>
          <div className="meta-item">
            <dt>{t("deployment.artifactSha")}</dt>
            <dd className="mono">
              {deployment.artifactSha256 === null ? (
                "—"
              ) : (
                <CopyValue
                  value={deployment.artifactSha256}
                  label="artifact SHA-256"
                  display={shortValue(deployment.artifactSha256, 12, 8)}
                />
              )}
            </dd>
          </div>
        </dl>
      </section>

        <PlanPanel plan={plan} />
      </> : null}

      {view === "verification" ? <VerificationPanel report={verification} /> : null}

      {view === "files" ? (
      <section className="panel" aria-labelledby="files-heading">
        <div className="panel-head">
          <h2 id="files-heading">{t("deployment.files")}</h2>
          <span className="panel-meta">
            {filesExposed ? t("console.rows", { count: releaseFiles.length }) : t("console.notExposed")}
          </span>
        </div>
        {entry === undefined ? null : (
          <p className="panel-copy">
            {t("console.entrySize", { bytes: formatBytes(entry.byteSize), chunks: entry.chunkCount })}
          </p>
        )}
        {entryTooLarge ? (
          <RiskNotice tone="critical" title={t("deployment.entryNotEligible")}>
            <p>
              {t("console.entryRejected")}
            </p>
          </RiskNotice>
        ) : null}
        {!filesExposed ? (
          <EmptyState
            title={t("console.filesMissing")}
            message={t("console.filesMissingBody")}
          />
        ) : releaseFiles.length === 0 ? (
          <EmptyState
            title={t("console.filesEmpty")}
            message={t("console.filesEmptyBody")}
          />
        ) : (
          <div className="table-wrap" role="region" aria-label={t("deployment.table")} tabIndex={0}>
            <table className="table">
              <caption className="visually-hidden">
                {t("deployment.files")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("deployment.targetPath")}</th>
                  <th scope="col">{t("deployment.source")}</th>
                  <th scope="col">{t("console.size")}</th>
                  <th scope="col">{t("deployment.chunks")}</th>
                  <th scope="col">{t("deployment.sha256")}</th>
                  <th scope="col">{t("deployment.state")}</th>
                </tr>
              </thead>
              <tbody>
                {releaseFiles.map((file) => (
                  <tr key={file.id}>
                    <td className="mono">{file.targetPath}</td>
                    <td className="mono">{file.sourceRelativePath}</td>
                    <td>{formatBytes(file.byteSize)}</td>
                    <td>{file.chunkCount}</td>
                    <td className="mono" title={file.sha256}>
                      {shortValue(file.sha256, 10, 6)}
                    </td>
                    <td>
                      <StatusChip label={file.state} tone={fileStateTone(file.state)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      ) : null}

      {view === "transactions" ? (
      <section className="panel" aria-labelledby="transactions-heading">
        <div className="panel-head">
          <h2 id="transactions-heading">{t("deployment.txTitle")}</h2>
          <span className="panel-meta">
            {transactionsExposed ? t("console.rows", { count: transactions.length }) : t("console.notExposed")}
          </span>
        </div>
        {!transactionsExposed ? (
          <EmptyState
            title={t("deployment.txMissing")}
            message={t("console.txMissingBody")}
          />
        ) : transactions.length === 0 ? (
          <EmptyState
            title={t("console.txEmpty")}
            message={t("console.txEmptyBody")}
          />
        ) : (
          <div className="table-wrap" role="region" aria-label={t("deployment.table")} tabIndex={0}>
            <table className="table">
              <caption className="visually-hidden">
                {t("deployment.txTitle")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("deployment.operation")}</th>
                  <th scope="col">{t("deployment.nonce")}</th>
                  <th scope="col">{t("deployment.txHash")}</th>
                  <th scope="col">{t("deployment.block")}</th>
                  <th scope="col">{t("deployment.gasUsed")}</th>
                  <th scope="col">{t("deployment.signer")}</th>
                  <th scope="col">{t("deployment.state")}</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((transaction) => (
                  <tr key={transaction.id}>
                    <td>
                      <code>{transaction.operation}</code>
                    </td>
                    <td>{transaction.nonce ?? "—"}</td>
                    <td className="mono">
                      {transaction.txHash === null ? (
                        "—"
                      ) : (
                        <CopyValue
                          value={transaction.txHash}
                          label={t("deployment.txHash")}
                          display={shortValue(transaction.txHash, 12, 8)}
                          href={`https://www.oklink.com/xlayer/tx/${transaction.txHash}`}
                        />
                      )}
                    </td>
                    <td>{transaction.receiptBlockNumber ?? "—"}</td>
                    <td>{transaction.gasUsed === null ? "—" : formatInteger(transaction.gasUsed)}</td>
                    <td className="mono">
                      <CopyValue
                        value={transaction.signerAddress}
                        label={t("deployment.signer")}
                        display={shortValue(transaction.signerAddress, 8, 6)}
                        href={`https://www.oklink.com/xlayer/address/${transaction.signerAddress}`}
                      />
                    </td>
                    <td>
                      <StatusChip
                        label={transaction.state}
                        tone={transactionStateTone(transaction.state)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      ) : null}

      {view === "events" ? (
      <section className="panel" aria-labelledby="timeline-heading">
        <div className="panel-head">
          <h2 id="timeline-heading">{t("deployment.timeline")}</h2>
          <span className="panel-meta">deployment_events</span>
        </div>
        <EventTimeline events={events} />
      </section>
      ) : null}
      </div>
      <aside className="deployment-rail" aria-label={t("approval.heading")}>
      <DeploymentActions
        deploymentId={deployment.id}
        state={deployment.state}
        demoMode={isMockMode()}
        costCapWei={deployment.approvedCostCapWei}
        review={{ repository: deployment.project?.repoFullName ?? deployment.projectId, container: deployment.containerAddress, commit: deployment.commitSha, manifest: deployment.manifestSha256, chainId: deployment.targetChainId, estimate: deployment.estimatedCostWei, cap: deployment.approvedCostCapWei }}
      />
      </aside>
      </div>
    </>
  );
}
