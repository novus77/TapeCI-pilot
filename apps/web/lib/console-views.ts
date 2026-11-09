import { isFailureState } from "./states";
import type { DeploymentState, DeploymentSummary } from "./types";

export const OVERVIEW_DEPLOYMENT_LIMIT = 10;
export const DEPLOYMENT_VIEWS = ["overview", "files", "transactions", "verification", "events"] as const;
export type DeploymentView = (typeof DEPLOYMENT_VIEWS)[number];

export function deploymentView(value: unknown): DeploymentView {
  return DEPLOYMENT_VIEWS.find((view) => view === value) ?? "overview";
}

export interface SnapshotFilter {
  readonly scope?: string;
  readonly state?: DeploymentState;
  readonly q?: string;
}

/** Apply groups after the API limit so overview links refer to the same snapshot. */
export function filterDeploymentSnapshot(deployments: readonly DeploymentSummary[], filter: SnapshotFilter): readonly DeploymentSummary[] {
  const needle = filter.q?.trim().toLowerCase();
  return deployments.filter((deployment) => {
    if (filter.scope === "attention" && !isFailureState(deployment.state)) return false;
    if (filter.scope === "completed" && deployment.state !== "LIVE") return false;
    if (filter.scope === "approval" && !deploymentActionContext(deployment.state).approve) return false;
    if (filter.state !== undefined && deployment.state !== filter.state) return false;
    return !needle || [deployment.id, deployment.commitSha, deployment.project?.repoFullName ?? "", deployment.project?.defaultBranch ?? "", deployment.triggerKind].join(" ").toLowerCase().includes(needle);
  });
}

/** Presentation only: server capabilities and write-time safety checks remain authoritative. */
export function deploymentActionContext(state: DeploymentState) {
  const approve = state === "PLAN_READY" || state === "AWAITING_APPROVAL";
  const execute = state === "APPROVED";
  const rollback = state === "LIVE";
  const isFailure = isFailureState(state);
  const active = [
    ...(approve || isFailure ? ["approve"] as const : []),
    ...(execute || isFailure ? ["execute"] as const : []),
    ...(rollback || isFailure ? ["rollback"] as const : []),
  ];
  return { approve, execute, rollback, active };
}
