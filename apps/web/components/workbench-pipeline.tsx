import Link from "next/link";

import { shortValue } from "@/lib/format";
import { translate, type Locale } from "@/lib/i18n";
import { deploymentStage, stageInfo } from "@/lib/states";
import type { DeploymentState, DeploymentSummary, Project } from "@/lib/types";

/**
 * The six pipeline phases from the Precision Console prototype, in order.
 *
 * A phase is done because the record passed the state that proves it; the current phase is the
 * one the record sits in. Nothing here is copied from the prototype's demo checkmarks.
 */
const PHASES = ["build", "prepare", "approval", "upload", "verify", "switch"] as const;
type Phase = (typeof PHASES)[number];

const PHASE_OF_STATE: Readonly<Record<DeploymentState, Phase>> = {
  RECEIVED: "build",
  BUILDING: "build",
  BUILD_FAILED: "build",
  BUILT: "prepare",
  VALIDATING: "prepare",
  PLAN_READY: "approval",
  PLAN_REJECTED: "prepare",
  AWAITING_APPROVAL: "approval",
  APPROVAL_EXPIRED: "approval",
  APPROVED: "upload",
  UPLOADING_ASSETS: "upload",
  UPLOAD_INTERRUPTED: "upload",
  UPLOAD_CONFLICT: "upload",
  INSUFFICIENT_BALANCE: "upload",
  FEE_OVER_BUDGET: "upload",
  VERIFYING_ASSETS: "verify",
  VERIFYING_RELEASE: "verify",
  VERIFY_FAILED: "verify",
  RPC_DISAGREEMENT: "verify",
  CHAIN_REORG_PENDING: "verify",
  IMPLEMENTATION_CHANGED: "verify",
  AUTH_REVOKED: "verify",
  OWNERSHIP_CHANGED: "verify",
  SWITCHING_ENTRY: "switch",
  SWITCH_FAILED: "switch",
  LIVE: "switch",
  ROLLBACK_REQUIRED: "switch",
  CANCELED: "switch",
};

/** States that mean "this deployment cannot proceed without a human". */
const BLOCKING = new Set<DeploymentState>([
  "BUILD_FAILED",
  "PLAN_REJECTED",
  "APPROVAL_EXPIRED",
  "AUTH_REVOKED",
  "OWNERSHIP_CHANGED",
  "INSUFFICIENT_BALANCE",
  "FEE_OVER_BUDGET",
  "RPC_DISAGREEMENT",
  "CHAIN_REORG_PENDING",
  "IMPLEMENTATION_CHANGED",
  "UPLOAD_CONFLICT",
  "UPLOAD_INTERRUPTED",
  "VERIFY_FAILED",
  "SWITCH_FAILED",
  "ROLLBACK_REQUIRED",
  "CANCELED",
]);

export function WorkbenchPipeline({
  project,
  deployment,
  currentReleaseId,
  locale,
  releaseUnavailable = false,
  deploymentUnavailable = false,
}: {
  readonly project: Project;
  /** The project's latest deployment, or `null` when it has never deployed. */
  readonly deployment: DeploymentSummary | null;
  /** The release currently serving, which is a different fact from the latest attempt. */
  readonly currentReleaseId: string | null;
  readonly locale: Locale;
  readonly releaseUnavailable?: boolean;
  readonly deploymentUnavailable?: boolean;
}) {
  const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  const unknownPhase = deployment !== null && ["CANCELED", "AUTH_REVOKED", "OWNERSHIP_CHANGED", "IMPLEMENTATION_CHANGED", "ROLLBACK_REQUIRED", "RPC_DISAGREEMENT", "CHAIN_REORG_PENDING", "INSUFFICIENT_BALANCE", "FEE_OVER_BUDGET"].includes(deployment.state);
  const index = deployment === null || unknownPhase ? -1 : PHASES.indexOf(PHASE_OF_STATE[deployment.state] ?? "build");
  const blocked = deployment !== null && BLOCKING.has(deployment.state);
  const stage = deployment === null ? null : stageInfo(deploymentStage(deployment.state, { releaseVerified: deployment.releaseVerified }), deployment.state, locale);

  return (
    <article className="panel pipeline-card" data-testid="workbench-pipeline">
      <div className="pipeline-head">
        <div className="pipeline-title">
          <span className="project-mark" aria-hidden="true">
            {project.repoFullName.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <h2 className="pipeline-name">{project.repoFullName.split("/")[1] ?? project.repoFullName}</h2>
            <p className="pipeline-sub">
              {project.repoFullName} / {project.defaultBranch}
            </p>
          </div>
        </div>
        <Link className="button button-ghost button-compact" href={`/projects/${project.id}`}>
          {t("workbench.projectDetail")}
        </Link>
      </div>

      <div className="pipeline-facts">
        <div className="labelled-value">
          <span className="label">{t("workbench.latestDeployment")}</span>
          <span className="value-line">
            {deployment === null ? (
              <span className="muted">{t(deploymentUnavailable ? "console.latestUnavailable" : "workbench.noDeployment")}</span>
            ) : (
              <>
                <Link className="mono" href={`/deployments/${deployment.id}`}>
                  {deployment.commitSha.slice(0, 7)}
                </Link>
                {stage === null ? null : (
                  <span className={`tag ${blocked ? "error" : deployment.state === "LIVE" ? "success" : "active"}`}>
                    {t(`state.${deployment.state}`)}
                  </span>
                )}
              </>
            )}
          </span>
        </div>
        <div className="labelled-value">
          <span className="label">{t("workbench.currentLive")}</span>
          <span className="value-line">
            {currentReleaseId === null ? (
              <span className="muted">{t(releaseUnavailable ? "console.releaseUnavailable" : "workbench.noLive")}</span>
            ) : (
              <>
                <code>{shortValue(currentReleaseId, 10, 4)}</code>
                <span className="tag">{t("workbench.historical")}</span>
              </>
            )}
          </span>
        </div>
      </div>

      <ol className="pipeline-phases" aria-label={t("workbench.pipeline")}>
        {PHASES.map((phase, position) => {
          const state =
            deployment?.state === "LIVE" ? "done" : index === -1
              ? "todo"
              : position < index
                ? "done"
                : position === index
                  ? blocked
                    ? "blocked"
                    : "current"
                  : "todo";
          return (
            <li key={phase} className="phase" data-state={state}>
              <span className="phase-mark" aria-hidden="true">
                {state === "done" ? "✓" : state === "blocked" ? "!" : position + 1}
              </span>
              <span className="phase-label">{t(`workbench.phase.${phase}` as never)}</span>
            </li>
          );
        })}
      </ol>

      <p className="pipeline-foot">
        <span className="dot" aria-hidden="true" />
        {deployment === null
          ? t("workbench.pipelineIdle")
          : blocked
            ? t("workbench.pipelineBlocked")
            : t("workbench.pipelineHint")}
      </p>
    </article>
  );
}
