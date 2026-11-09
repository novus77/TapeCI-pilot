import { translate, type Locale, type MessageKey } from "./i18n";
import type { DeploymentState, FileState, TransactionState } from "./types";

/**
 * The four product states from the PRD (§10). They are milestones, not
 * synonyms: a build is never "deployed", and a receipt is never "Live".
 */
export type ReleaseStage =
  | "BUILD_SUCCESS"
  | "UPLOADED"
  | "VERIFIED"
  | "LIVE"
  | "IN_PROGRESS"
  | "FAILED";

export interface ReleaseStageInfo {
  readonly label: string;
  readonly description: string;
  readonly tone: "build" | "uploaded" | "verified" | "live" | "progress" | "failed";
  readonly symbol: string;
}

const FAILURE_STATES: ReadonlySet<DeploymentState> = new Set([
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

const BUILD_STATES: ReadonlySet<DeploymentState> = new Set([
  "BUILT",
  "VALIDATING",
  "PLAN_READY",
  "AWAITING_APPROVAL",
  "APPROVED",
]);

const UPLOADED_STATES: ReadonlySet<DeploymentState> = new Set([
  "UPLOADING_ASSETS",
  "VERIFYING_ASSETS",
  "SWITCHING_ENTRY",
]);

/** States that own the one-in-flight-writer-per-container lock. */
const IN_FLIGHT_STATES: ReadonlySet<DeploymentState> = new Set([
  "APPROVED",
  "UPLOADING_ASSETS",
  "VERIFYING_ASSETS",
  "SWITCHING_ENTRY",
  "VERIFYING_RELEASE",
]);

export const DEPLOYMENT_STATE_LABELS: Readonly<Record<DeploymentState, string>> = {
  RECEIVED: "Received",
  BUILDING: "Building",
  BUILT: "Built",
  VALIDATING: "Validating artifact",
  PLAN_READY: "Plan ready",
  AWAITING_APPROVAL: "Awaiting approval",
  APPROVED: "Approved",
  UPLOADING_ASSETS: "Uploading assets",
  VERIFYING_ASSETS: "Verifying assets",
  SWITCHING_ENTRY: "Switching entry",
  VERIFYING_RELEASE: "Verifying release",
  LIVE: "Live",
  BUILD_FAILED: "Build failed",
  PLAN_REJECTED: "Plan rejected",
  APPROVAL_EXPIRED: "Approval expired",
  AUTH_REVOKED: "Authorization revoked",
  OWNERSHIP_CHANGED: "Ownership changed",
  INSUFFICIENT_BALANCE: "Insufficient balance",
  FEE_OVER_BUDGET: "Fee over budget",
  RPC_DISAGREEMENT: "RPC disagreement",
  CHAIN_REORG_PENDING: "Chain reorg pending",
  IMPLEMENTATION_CHANGED: "Implementation changed",
  UPLOAD_CONFLICT: "Upload conflict",
  UPLOAD_INTERRUPTED: "Upload interrupted",
  VERIFY_FAILED: "Verification failed",
  SWITCH_FAILED: "Entry switch failed",
  ROLLBACK_REQUIRED: "Rollback required",
  CANCELED: "Canceled",
};

export const DEPLOYMENT_STATES = Object.keys(DEPLOYMENT_STATE_LABELS) as readonly DeploymentState[];

export interface StateFilterGroup {
  readonly label: string;
  readonly labelKey: MessageKey;
  readonly states: readonly DeploymentState[];
}

/** Grouped for the GET filter form; keeps the raw API state vocabulary visible. */
export const STATE_FILTER_GROUPS: readonly StateFilterGroup[] = [
  { label: "Build", labelKey: "filter.build", states: ["RECEIVED", "BUILDING", "BUILT", "VALIDATING", "BUILD_FAILED"] },
  {
    label: "Plan & approval", labelKey: "filter.approval",
    states: ["PLAN_READY", "AWAITING_APPROVAL", "APPROVED", "PLAN_REJECTED", "APPROVAL_EXPIRED"],
  },
  {
    label: "Chain write", labelKey: "filter.write",
    states: [
      "UPLOADING_ASSETS",
      "VERIFYING_ASSETS",
      "SWITCHING_ENTRY",
      "UPLOAD_CONFLICT",
      "UPLOAD_INTERRUPTED",
    ],
  },
  {
    label: "Verification", labelKey: "filter.verify",
    states: ["VERIFYING_RELEASE", "VERIFY_FAILED", "RPC_DISAGREEMENT", "CHAIN_REORG_PENDING"],
  },
  { label: "Live & rollback", labelKey: "filter.live", states: ["LIVE", "ROLLBACK_REQUIRED"] },
  {
    label: "Fail-closed", labelKey: "filter.safety",
    states: [
      "AUTH_REVOKED",
      "OWNERSHIP_CHANGED",
      "INSUFFICIENT_BALANCE",
      "FEE_OVER_BUDGET",
      "IMPLEMENTATION_CHANGED",
      "SWITCH_FAILED",
      "CANCELED",
    ],
  },
];

export const ACTIVE_RELEASE_STAGES: readonly ReleaseStage[] = [
  "BUILD_SUCCESS",
  "UPLOADED",
  "VERIFIED",
  "LIVE",
];

const STAGE_INFO: Readonly<Record<ReleaseStage, ReleaseStageInfo>> = {
  BUILD_SUCCESS: {
    label: "Build Success",
    description: "The build passed. Nothing is on-chain yet.",
    tone: "build",
    symbol: "◆",
  },
  UPLOADED: {
    label: "Uploaded",
    description: "Some or all file transactions are on-chain. The bytes are not verified yet.",
    tone: "uploaded",
    symbol: "▲",
  },
  VERIFIED: {
    label: "Verified",
    description:
      "Two independent RPC operators returned identical bytes at one pinned block. The entry may not be live yet.",
    tone: "verified",
    symbol: "●",
  },
  LIVE: {
    label: "Live",
    description:
      "The entry is switched and the full release is readable at the pinned block. This is the only state that means published.",
    tone: "live",
    symbol: "★",
  },
  IN_PROGRESS: {
    label: "In progress",
    description: "A build is running. No release milestone is complete yet.",
    tone: "progress",
    symbol: "…",
  },
  FAILED: {
    label: "Failed",
    description: "The deployment stopped. Progress before the failure is not assumed.",
    tone: "failed",
    symbol: "✕",
  },
};

const STAGE_MESSAGE_KEYS: Readonly<Record<ReleaseStage, MessageKey>> = {
  BUILD_SUCCESS: "legend.build",
  UPLOADED: "legend.uploaded",
  VERIFIED: "legend.verified",
  LIVE: "legend.live",
  IN_PROGRESS: "legend.inProgress",
  FAILED: "state.BUILD_FAILED",
};

const STAGE_DESCRIPTION_KEYS: Readonly<Record<ReleaseStage, MessageKey>> = {
  BUILD_SUCCESS: "legend.buildBody",
  UPLOADED: "legend.uploadedBody",
  VERIFIED: "legend.verifiedBody",
  LIVE: "legend.liveBody",
  IN_PROGRESS: "legend.inProgressBody",
  FAILED: "state.BUILD_FAILED",
};

export function stageInfo(
  stage: ReleaseStage,
  state?: DeploymentState,
  locale: Locale = "en",
): ReleaseStageInfo {
  const base = STAGE_INFO[stage];
  if (locale !== "en") {
    const localized: ReleaseStageInfo = {
      ...base,
      label: translate(locale, STAGE_MESSAGE_KEYS[stage]),
      description: translate(locale, STAGE_DESCRIPTION_KEYS[stage]),
    };
    if (stage === "FAILED" && state !== undefined) {
      return { ...localized, label: translate(locale, `state.${state}`) };
    }
    return localized;
  }
  if (stage === "FAILED" && state === "BUILD_FAILED") {
    return {
      ...base,
      label: "Build failed",
      description:
        "The build failed. No artifact was uploaded and no chain transaction was sent for this deployment.",
    };
  }
  if (stage === "FAILED" && state !== undefined) {
    return { ...base, label: DEPLOYMENT_STATE_LABELS[state] };
  }
  return base;
}

export function isFailureState(state: DeploymentState): boolean {
  return FAILURE_STATES.has(state);
}

export function isInFlightState(state: DeploymentState): boolean {
  return IN_FLIGHT_STATES.has(state);
}

export interface StageEvidence {
  /** Optional list-payload hint: the server says the release has a verified report. */
  readonly releaseVerified?: boolean;
  /** Detail-page evidence from `GET /v1/deployments/:id/verification`. */
  readonly releaseMatch?: boolean | null;
}

function isVerified(evidence: StageEvidence): boolean {
  if (evidence.releaseMatch === true) return true;
  if (evidence.releaseMatch === false) return false;
  return evidence.releaseVerified === true;
}

/** Derive the product stage from the durable deployment state plus verification evidence. */
export function deploymentStage(
  state: DeploymentState,
  evidence: StageEvidence = {},
): ReleaseStage {
  if (state === "LIVE") return "LIVE";
  if (isFailureState(state)) return "FAILED";
  if (state === "VERIFYING_RELEASE") return isVerified(evidence) ? "VERIFIED" : "UPLOADED";
  if (UPLOADED_STATES.has(state)) return "UPLOADED";
  if (BUILD_STATES.has(state)) return "BUILD_SUCCESS";
  return "IN_PROGRESS";
}

/** 0 = no milestone, 4 = Live. Used by the milestone strip. */
export function lifecycleRank(state: DeploymentState, evidence: StageEvidence = {}): number {
  if (state === "LIVE") return 4;
  if (isFailureState(state)) return 0;
  if (state === "VERIFYING_RELEASE") return isVerified(evidence) ? 3 : 2;
  if (state === "SWITCHING_ENTRY" || UPLOADED_STATES.has(state)) return 2;
  if (BUILD_STATES.has(state)) return 1;
  return 0;
}

export function isDeploymentState(value: unknown): value is DeploymentState {
  return typeof value === "string" && value in DEPLOYMENT_STATE_LABELS;
}

export function stateLabel(state: DeploymentState): string {
  return DEPLOYMENT_STATE_LABELS[state];
}

const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  webhook: "GitHub push",
  manual: "Manual",
  rollback: "Rollback",
  cli: "CLI",
};

export function triggerLabel(triggerKind: string): string {
  return TRIGGER_LABELS[triggerKind] ?? triggerKind;
}

export function fileStateTone(
  state: FileState,
): "success" | "warning" | "danger" | "neutral" {
  switch (state) {
    case "VERIFIED":
    case "UNCHANGED":
      return "success";
    case "WRITING":
    case "WRITTEN":
      return "warning";
    case "CONFLICT":
    case "FAILED":
      return "danger";
    case "PENDING":
      return "neutral";
  }
}

export function transactionStateTone(
  state: TransactionState,
): "success" | "warning" | "danger" | "neutral" {
  switch (state) {
    case "SAFE":
    case "INCLUDED":
      return "success";
    case "SIGNED":
    case "BROADCAST":
      return "warning";
    case "REPLACED":
    case "PREPARED":
      return "neutral";
    case "REVERTED":
    case "FAILED":
      return "danger";
  }
}
