import type {
  ProcessorCatalogue,
  ProcessorRef,
  WalletResource,
  WalletResourcePage,
} from "./api";
import { ApiError } from "./errors";
import type {
  ActorKind,
  ChainTransaction,
  ContainerBindingStatus,
  ContainerDetail,
  DeploymentEvent,
  DeploymentPlan,
  DeploymentState,
  DeploymentSummary,
  FileState,
  Hex,
  OperatorSession,
  Project,
  Release,
  ReleaseFile,
  TransactionState,
  VerificationFileCheck,
  VerificationReport,
} from "./types";

/**
 * Deterministic P2 fixtures. No clocks, randomness or secrets: every value here is
 * a literal so the console and the browser tests render the same bytes every run.
 * Values are demo data only; nothing here is chain evidence.
 */

const hashFrom = (pattern: string): Hex => {
  const repeated = pattern.repeat(Math.ceil(64 / pattern.length)).slice(0, 64);
  return `0x${repeated}`;
};

export const MOCK_REGISTRY: Hex = "0x8f2b9d6a4c1e3f5079b2d8c4a6e0f1b3c5d7e9a2";
export const MOCK_FACTORY: Hex = "0xc4a1e7f39b2d5068a0c4e6f8b1d3a5c7e9f0b2d4";
export const MOCK_OPENER: Hex = "0x6b1d3f5a7c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d";
export const MOCK_BINDING: Hex = "0xa0b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d";
export const MOCK_REGISTRY_IMPL: Hex = "0x5e9f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b";
export const MOCK_BINDING_IMPL: Hex = "0x8d7c6b5a4938271605f4e3d2c1b0a99887766554";
export const MOCK_PROCESSOR: Hex = "0x4d3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0";

export const MOCK_CONTAINER_ONE: Hex = "0x1f0a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c";
export const MOCK_CONTAINER_TWO: Hex = "0x2e1d3c4b5a69788796a5b4c3d2e1f00918273645";
export const MOCK_OWNER_ONE: Hex = "0x7a8b9c0d1e2f30415263748596a7b8c9d0e1f203";
export const MOCK_OWNER_TWO: Hex = "0x3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f";
export const MOCK_OPERATOR_ONE: Hex = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
export const MOCK_OPERATOR_TWO: Hex = "0x1b2c3d4e5f60718293a4b5c6d7e8f90123456789";
export const MOCK_OPERATOR_THREE: Hex = "0x4f5e6d7c8b9a0f1e2d3c4b5a69788796a5b4c3d2";

export const MOCK_ORGANIZATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * Members for the mock organization page. `lastActivityAt` is null for one member
 * on purpose: the table must render "No activity yet" instead of inventing a date.
 */
export const MOCK_ORGANIZATION_MEMBERS = [
  {
    userId: "11111111-1111-4111-8111-111111111111",
    githubLogin: "novus77",
    role: "owner",
    createdAt: "2026-10-01T09:00:00.000Z",
    lastActivityAt: "2026-10-26T02:49:04.000Z",
  },
  {
    userId: "22222222-2222-4222-8222-222222222222",
    githubLogin: "tapeci-bot",
    role: "admin",
    createdAt: "2026-10-05T11:30:00.000Z",
    lastActivityAt: "2026-10-25T10:15:44.000Z",
  },
  {
    userId: "33333333-3333-4333-8333-333333333333",
    githubLogin: "reviewer-olga",
    role: "member",
    createdAt: "2026-10-12T16:45:00.000Z",
    lastActivityAt: null,
  },
] as const;

export const MOCK_PROJECT_IDS = {
  tapekit: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  docs: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

export const MOCK_CONTAINER_IDS = {
  one: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  two: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;

export const MOCK_DEPLOYMENT_IDS = {
  live: "d0000000-0000-4000-8000-000000000001",
  verified: "d0000000-0000-4000-8000-000000000002",
  uploaded: "d0000000-0000-4000-8000-000000000003",
  approval: "d0000000-0000-4000-8000-000000000004",
  buildFailed: "d0000000-0000-4000-8000-000000000005",
} as const;

const ENTRY_SHA = hashFrom("3f1c9a7e5b2d4806");
const APP_SHA = hashFrom("a7b8c9d0e1f20314");
const CSS_SHA = hashFrom("c3d4e5f60718293a");
const LOGO_SHA = hashFrom("102f3e4d5c6b7a89");
const ENTRY_SHA_OLD = hashFrom("0f1e2d3c4b5a6978");
const ARTIFACT_SHA = hashFrom("ab12cd34ef567890");
const MANIFEST_SHA = hashFrom("5e6f7a8b9c0d1e2f");

const RELEASE_LIVE = "r-5f3a1b2c9d4e-8a1b2c3d";
const RELEASE_VERIFIED = "r-9c2d4e6f8011-4d5e6f70";
const RELEASE_UPLOADED = "r-1a2b3c4d5e6f-1f2e3d4c";
const RELEASE_APPROVAL = "r-7e4f5a6b7c8d-9a8b7c6d";
const RELEASE_P1_OLD = "r-0b1c2d3e4f50-1a2b3c4d";
const RELEASE_P2 = "r-f0e1d2c3b4a5-5e6f7a8b";

const COMMIT_LIVE = "5f3a1b2c9d4e8f60718293a4b5c6d7e8f9012345";
const COMMIT_VERIFIED = "9c2d4e6f80112233445566778899aabbccddeeff";
const COMMIT_UPLOADED = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
const COMMIT_APPROVAL = "7e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5";
const COMMIT_FAILED = "dead00beef11cafe22babe33f00d44d5e66f77a8";
const COMMIT_P1_OLD = "0b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4";
const COMMIT_P2_OLD = "f0e1d2c3b4a5968778695a4b3c2d1e0f9a8b7c6d";

const PROJECT_TAPEKIT_REF = {
  id: MOCK_PROJECT_IDS.tapekit,
  repoFullName: "tapeoutprotocol/tapekit-site",
  defaultBranch: "main",
} as const;

const PROJECT_DOCS_REF = {
  id: MOCK_PROJECT_IDS.docs,
  repoFullName: "tapeoutprotocol/docs-site",
  defaultBranch: "main",
} as const;

export const seedProjects: readonly Project[] = [
  {
    id: MOCK_PROJECT_IDS.tapekit,
    repoFullName: PROJECT_TAPEKIT_REF.repoFullName,
    defaultBranch: "main",
    buildCommand: "npm run build",
    installCommand: "npm ci",
    outputDirectory: "dist",
    strictDewebMode: true,
    isArchived: false,
    container: {
      address: MOCK_CONTAINER_ONE,
      chainId: 196,
      ownerAddress: MOCK_OWNER_ONE,
      registryAddress: MOCK_REGISTRY,
      opened: true,
    },
    installations: [
      { id: "inst-one", installationId: 81234567, accountLogin: "tapeoutprotocol" },
    ],
    createdAt: "2026-09-10T08:00:00Z",
    updatedAt: "2026-10-18T09:31:00Z",
  },
  {
    id: MOCK_PROJECT_IDS.docs,
    repoFullName: PROJECT_DOCS_REF.repoFullName,
    defaultBranch: "main",
    buildCommand: "npm run docs:build",
    installCommand: "npm ci",
    outputDirectory: "dist",
    strictDewebMode: true,
    isArchived: false,
    container: {
      address: MOCK_CONTAINER_TWO,
      chainId: 196,
      ownerAddress: MOCK_OWNER_TWO,
      registryAddress: MOCK_REGISTRY,
      opened: true,
    },
    installations: [
      { id: "inst-two", installationId: 82345678, accountLogin: "tapeoutprotocol" },
    ],
    createdAt: "2026-09-22T13:30:00Z",
    updatedAt: "2026-10-19T07:22:00Z",
  },
];

interface DeploymentSeed {
  readonly id: string;
  readonly projectId: string;
  readonly project: typeof PROJECT_TAPEKIT_REF | typeof PROJECT_DOCS_REF;
  readonly containerId: string;
  readonly containerAddress: Hex;
  readonly triggerKind: string;
  readonly commitSha: string;
  readonly state: DeploymentState;
  readonly stateVersion: number;
  readonly releaseId: string | null;
  readonly releaseVerified: boolean;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

const COST_CAP_WEI = "500000000000000000";
const ESTIMATED_COST_WEI = "370000000000000000";

const deploymentSeeds: readonly DeploymentSeed[] = [
  {
    id: MOCK_DEPLOYMENT_IDS.live,
    projectId: MOCK_PROJECT_IDS.tapekit,
    project: PROJECT_TAPEKIT_REF,
    containerId: MOCK_CONTAINER_IDS.one,
    containerAddress: MOCK_CONTAINER_ONE,
    triggerKind: "webhook",
    commitSha: COMMIT_LIVE,
    state: "LIVE",
    stateVersion: 11,
    releaseId: RELEASE_LIVE,
    releaseVerified: true,
    errorCode: null,
    errorMessage: null,
    requestedAt: "2026-10-18T09:12:00Z",
    startedAt: "2026-10-18T09:13:00Z",
    finishedAt: "2026-10-18T09:31:00Z",
  },
  {
    id: MOCK_DEPLOYMENT_IDS.verified,
    projectId: MOCK_PROJECT_IDS.tapekit,
    project: PROJECT_TAPEKIT_REF,
    containerId: MOCK_CONTAINER_IDS.one,
    containerAddress: MOCK_CONTAINER_ONE,
    triggerKind: "webhook",
    commitSha: COMMIT_VERIFIED,
    state: "VERIFYING_RELEASE",
    stateVersion: 10,
    releaseId: RELEASE_VERIFIED,
    releaseVerified: true,
    errorCode: null,
    errorMessage: null,
    requestedAt: "2026-10-18T15:40:00Z",
    startedAt: "2026-10-18T15:41:00Z",
    finishedAt: null,
  },
  {
    id: MOCK_DEPLOYMENT_IDS.uploaded,
    projectId: MOCK_PROJECT_IDS.docs,
    project: PROJECT_DOCS_REF,
    containerId: MOCK_CONTAINER_IDS.two,
    containerAddress: MOCK_CONTAINER_TWO,
    triggerKind: "webhook",
    commitSha: COMMIT_UPLOADED,
    state: "VERIFYING_ASSETS",
    stateVersion: 8,
    releaseId: RELEASE_UPLOADED,
    releaseVerified: false,
    errorCode: null,
    errorMessage: null,
    requestedAt: "2026-10-19T07:05:00Z",
    startedAt: "2026-10-19T07:06:00Z",
    finishedAt: null,
  },
  {
    id: MOCK_DEPLOYMENT_IDS.approval,
    projectId: MOCK_PROJECT_IDS.docs,
    project: PROJECT_DOCS_REF,
    containerId: MOCK_CONTAINER_IDS.two,
    containerAddress: MOCK_CONTAINER_TWO,
    triggerKind: "manual",
    commitSha: COMMIT_APPROVAL,
    state: "AWAITING_APPROVAL",
    stateVersion: 5,
    releaseId: RELEASE_APPROVAL,
    releaseVerified: false,
    errorCode: null,
    errorMessage: null,
    requestedAt: "2026-10-19T08:10:00Z",
    startedAt: "2026-10-19T08:11:00Z",
    finishedAt: null,
  },
  {
    id: MOCK_DEPLOYMENT_IDS.buildFailed,
    projectId: MOCK_PROJECT_IDS.tapekit,
    project: PROJECT_TAPEKIT_REF,
    containerId: MOCK_CONTAINER_IDS.one,
    containerAddress: MOCK_CONTAINER_ONE,
    triggerKind: "webhook",
    commitSha: COMMIT_FAILED,
    state: "BUILD_FAILED",
    stateVersion: 2,
    releaseId: null,
    releaseVerified: false,
    errorCode: "BUILD_FAILED",
    errorMessage: "npm run build exited with code 2: missing module './release-manifest'.",
    requestedAt: "2026-10-17T12:00:00Z",
    startedAt: "2026-10-17T12:01:00Z",
    finishedAt: "2026-10-17T12:03:00Z",
  },
  // Older history so the pager has more than one page to move through. These are
  // plain LIVE records: they must never look like a distinct stage.
  ...Array.from({ length: 7 }, (_, index) => ({
    id: `d0000000-0000-4000-8000-0000000001${String(index + 10).padStart(2, "0")}`,
    projectId: index % 2 === 0 ? MOCK_PROJECT_IDS.tapekit : MOCK_PROJECT_IDS.docs,
    project: index % 2 === 0 ? PROJECT_TAPEKIT_REF : PROJECT_DOCS_REF,
    containerId: index % 2 === 0 ? MOCK_CONTAINER_IDS.one : MOCK_CONTAINER_IDS.two,
    containerAddress: index % 2 === 0 ? MOCK_CONTAINER_ONE : MOCK_CONTAINER_TWO,
    triggerKind: "manual" as const,
    commitSha: `${String(index + 1).repeat(40)}`.slice(0, 40),
    branch: "main",
    state: "LIVE" as const,
    manifestSha256: MANIFEST_SHA,
    releaseId: RELEASE_LIVE,
    requestedAt: `2026-10-${String(9 - index).padStart(2, "0")}T08:00:00Z`,
    startedAt: `2026-10-${String(9 - index).padStart(2, "0")}T08:01:00Z`,
    finishedAt: `2026-10-${String(9 - index).padStart(2, "0")}T08:05:00Z`,
    stateVersion: 1,
    releaseVerified: true,
    errorCode: null,
    errorMessage: null,
  })),
];

export const seedDeployments: readonly DeploymentSummary[] = deploymentSeeds.map((seed) => ({
  id: seed.id,
  projectId: seed.projectId,
  project: seed.project,
  containerId: seed.containerId,
  containerAddress: seed.containerAddress,
  triggerKind: seed.triggerKind,
  commitSha: seed.commitSha,
  state: seed.state,
  stateVersion: seed.stateVersion,
  targetChainId: 196,
  registryAddress: MOCK_REGISTRY,
  artifactSha256: ARTIFACT_SHA,
  manifestSha256: MANIFEST_SHA,
  releaseId: seed.releaseId,
  entryPath: "index.html",
  errorCode: seed.errorCode,
  errorMessage: seed.errorMessage,
  approvedCostCapWei: seed.state === "BUILD_FAILED" ? null : COST_CAP_WEI,
  estimatedCostWei: seed.state === "BUILD_FAILED" ? null : ESTIMATED_COST_WEI,
  releaseVerified: seed.releaseVerified,
  requestedAt: seed.requestedAt,
  startedAt: seed.startedAt,
  finishedAt: seed.finishedAt,
  updatedAt: seed.finishedAt ?? seed.startedAt ?? seed.requestedAt,
}));

export const seedReleases: readonly Release[] = [
  {
    id: "rel-tapekit-live",
    projectId: MOCK_PROJECT_IDS.tapekit,
    deploymentId: MOCK_DEPLOYMENT_IDS.live,
    releaseId: RELEASE_LIVE,
    commitSha: COMMIT_LIVE,
    manifestSha256: MANIFEST_SHA,
    entrySha256: ENTRY_SHA,
    entryPath: "index.html",
    verifiedBlockNumber: "48214990",
    activatedAt: "2026-10-18T09:31:00Z",
    isCurrent: true,
  },
  {
    id: "rel-tapekit-old",
    projectId: MOCK_PROJECT_IDS.tapekit,
    deploymentId: "d0000000-0000-4000-8000-000000000098",
    releaseId: RELEASE_P1_OLD,
    commitSha: COMMIT_P1_OLD,
    manifestSha256: MANIFEST_SHA,
    entrySha256: ENTRY_SHA_OLD,
    entryPath: "index.html",
    verifiedBlockNumber: "48100200",
    activatedAt: "2026-10-10T11:00:00Z",
    isCurrent: false,
  },
  {
    id: "rel-docs-live",
    projectId: MOCK_PROJECT_IDS.docs,
    deploymentId: "d0000000-0000-4000-8000-000000000097",
    releaseId: RELEASE_P2,
    commitSha: COMMIT_P2_OLD,
    manifestSha256: MANIFEST_SHA,
    entrySha256: ENTRY_SHA_OLD,
    entryPath: "index.html",
    verifiedBlockNumber: "48000100",
    activatedAt: "2026-10-05T09:00:00Z",
    isCurrent: true,
  },
];

interface EventSeed {
  readonly state: DeploymentState | null;
  readonly type: string;
  readonly actor: ActorKind;
  readonly actorId: string | null;
  readonly at: string;
  readonly payload?: Record<string, unknown>;
}

function buildEvents(deploymentId: string, prefix: string, seeds: readonly EventSeed[]): DeploymentEvent[] {
  return seeds.map((seed, index) => ({
    id: `ev-${prefix}-${String(index + 1).padStart(2, "0")}`,
    deploymentId,
    oldState: index === 0 ? null : (seeds[index - 1]?.state ?? null),
    newState: seed.state,
    eventType: seed.type,
    actorKind: seed.actor,
    actorId: seed.actorId,
    payload: seed.payload ?? {},
    createdAt: seed.at,
  }));
}

const liveEvents: readonly EventSeed[] = [
  { state: "RECEIVED", type: "deployment.created", actor: "webhook", actorId: "delivery-9f21", at: "2026-10-18T09:12:00Z" },
  { state: "BUILDING", type: "build.started", actor: "worker", actorId: "build-runner-1", at: "2026-10-18T09:13:00Z" },
  { state: "BUILT", type: "build.succeeded", actor: "worker", actorId: "build-runner-1", at: "2026-10-18T09:15:00Z" },
  { state: "VALIDATING", type: "artifact.validation.started", actor: "worker", actorId: "planning-worker-1", at: "2026-10-18T09:15:20Z" },
  { state: "PLAN_READY", type: "plan.ready", actor: "worker", actorId: "planning-worker-1", at: "2026-10-18T09:17:00Z" },
  { state: "AWAITING_APPROVAL", type: "approval.requested", actor: "user", actorId: "octocat", at: "2026-10-18T09:18:00Z" },
  {
    state: "APPROVED",
    type: "approval.signed",
    actor: "user",
    actorId: "octocat",
    at: "2026-10-18T09:20:00Z",
    payload: { approvalDigest: hashFrom("d1a2b3c4d5e6f708") },
  },
  { state: "UPLOADING_ASSETS", type: "chain.write.started", actor: "worker", actorId: "deploy-worker-1", at: "2026-10-18T09:22:00Z" },
  { state: "VERIFYING_ASSETS", type: "assets.uploaded", actor: "worker", actorId: "deploy-worker-1", at: "2026-10-18T09:26:00Z" },
  { state: "SWITCHING_ENTRY", type: "entry.switching", actor: "worker", actorId: "deploy-worker-1", at: "2026-10-18T09:28:00Z" },
  { state: "VERIFYING_RELEASE", type: "release.verifying", actor: "worker", actorId: "verify-worker-1", at: "2026-10-18T09:29:00Z" },
  { state: "LIVE", type: "release.live", actor: "system", actorId: "verify-worker-1", at: "2026-10-18T09:31:00Z", payload: { note: "two operators matched at pinned block 48214990" } },
];

const verifiedEvents: readonly EventSeed[] = [
  { state: "RECEIVED", type: "deployment.created", actor: "webhook", actorId: "delivery-7c14", at: "2026-10-18T15:40:00Z" },
  { state: "BUILDING", type: "build.started", actor: "worker", actorId: "build-runner-2", at: "2026-10-18T15:41:00Z" },
  { state: "BUILT", type: "build.succeeded", actor: "worker", actorId: "build-runner-2", at: "2026-10-18T15:43:00Z" },
  { state: "VALIDATING", type: "artifact.validation.started", actor: "worker", actorId: "planning-worker-1", at: "2026-10-18T15:43:30Z" },
  { state: "PLAN_READY", type: "plan.ready", actor: "worker", actorId: "planning-worker-1", at: "2026-10-18T15:45:00Z" },
  { state: "AWAITING_APPROVAL", type: "approval.requested", actor: "user", actorId: "octocat", at: "2026-10-18T15:46:00Z" },
  { state: "APPROVED", type: "approval.signed", actor: "user", actorId: "octocat", at: "2026-10-18T15:48:00Z" },
  { state: "UPLOADING_ASSETS", type: "chain.write.started", actor: "worker", actorId: "deploy-worker-2", at: "2026-10-18T15:50:00Z" },
  { state: "VERIFYING_ASSETS", type: "assets.uploaded", actor: "worker", actorId: "deploy-worker-2", at: "2026-10-18T15:54:00Z" },
  { state: "SWITCHING_ENTRY", type: "entry.switching", actor: "worker", actorId: "deploy-worker-2", at: "2026-10-18T15:56:00Z" },
  { state: "VERIFYING_RELEASE", type: "release.verifying", actor: "worker", actorId: "verify-worker-1", at: "2026-10-18T15:57:00Z" },
  {
    state: "VERIFYING_RELEASE",
    type: "release.verified",
    actor: "worker",
    actorId: "verify-worker-1",
    at: "2026-10-18T15:58:00Z",
    payload: { note: "releaseMatch=true at pinned block 48214810; LIVE transition not persisted yet" },
  },
];

const uploadedEvents: readonly EventSeed[] = [
  { state: "RECEIVED", type: "deployment.created", actor: "webhook", actorId: "delivery-2b88", at: "2026-10-19T07:05:00Z" },
  { state: "BUILDING", type: "build.started", actor: "worker", actorId: "build-runner-3", at: "2026-10-19T07:06:00Z" },
  { state: "BUILT", type: "build.succeeded", actor: "worker", actorId: "build-runner-3", at: "2026-10-19T07:08:00Z" },
  { state: "VALIDATING", type: "artifact.validation.started", actor: "worker", actorId: "planning-worker-2", at: "2026-10-19T07:08:30Z" },
  { state: "PLAN_READY", type: "plan.ready", actor: "worker", actorId: "planning-worker-2", at: "2026-10-19T07:10:00Z" },
  { state: "AWAITING_APPROVAL", type: "approval.requested", actor: "user", actorId: "octocat", at: "2026-10-19T07:11:00Z" },
  { state: "APPROVED", type: "approval.signed", actor: "user", actorId: "octocat", at: "2026-10-19T07:13:00Z" },
  { state: "UPLOADING_ASSETS", type: "chain.write.started", actor: "worker", actorId: "deploy-worker-3", at: "2026-10-19T07:15:00Z" },
  { state: "VERIFYING_ASSETS", type: "assets.uploaded", actor: "worker", actorId: "deploy-worker-3", at: "2026-10-19T07:22:00Z", payload: { note: "4 of 4 files written; entry switch not started" } },
];

const approvalEvents: readonly EventSeed[] = [
  { state: "RECEIVED", type: "deployment.created", actor: "webhook", actorId: "delivery-5e07", at: "2026-10-19T08:10:00Z" },
  { state: "BUILDING", type: "build.started", actor: "worker", actorId: "build-runner-4", at: "2026-10-19T08:11:00Z" },
  { state: "BUILT", type: "build.succeeded", actor: "worker", actorId: "build-runner-4", at: "2026-10-19T08:13:00Z" },
  { state: "VALIDATING", type: "artifact.validation.started", actor: "worker", actorId: "planning-worker-2", at: "2026-10-19T08:13:30Z" },
  { state: "PLAN_READY", type: "plan.ready", actor: "worker", actorId: "planning-worker-2", at: "2026-10-19T08:15:00Z" },
  { state: "AWAITING_APPROVAL", type: "approval.requested", actor: "user", actorId: "octocat", at: "2026-10-19T08:16:00Z" },
];

const failedEvents: readonly EventSeed[] = [
  { state: "RECEIVED", type: "deployment.created", actor: "webhook", actorId: "delivery-11ab", at: "2026-10-17T12:00:00Z" },
  { state: "BUILDING", type: "build.started", actor: "worker", actorId: "build-runner-2", at: "2026-10-17T12:01:00Z" },
  {
    state: "BUILD_FAILED",
    type: "build.failed",
    actor: "worker",
    actorId: "build-runner-2",
    at: "2026-10-17T12:03:00Z",
    payload: {
      errorCode: "BUILD_FAILED",
      exitCode: 2,
      note: "build log tail: missing module './release-manifest'",
    },
  },
];

export const seedEvents: readonly DeploymentEvent[] = [
  ...buildEvents(MOCK_DEPLOYMENT_IDS.live, "live", liveEvents),
  ...buildEvents(MOCK_DEPLOYMENT_IDS.verified, "verified", verifiedEvents),
  ...buildEvents(MOCK_DEPLOYMENT_IDS.uploaded, "uploaded", uploadedEvents),
  ...buildEvents(MOCK_DEPLOYMENT_IDS.approval, "approval", approvalEvents),
  ...buildEvents(MOCK_DEPLOYMENT_IDS.buildFailed, "failed", failedEvents),
];

interface FileSeed {
  readonly name: string;
  readonly source: string;
  readonly sha256: Hex;
  readonly bytes: number;
  readonly chunks: number;
  readonly contentType: string;
}

const FILE_SEEDS: readonly FileSeed[] = [
  { name: "entry", source: "index.html", sha256: ENTRY_SHA, bytes: 1240, chunks: 1, contentType: "text/html" },
  { name: "app", source: "app.js", sha256: APP_SHA, bytes: 28410, chunks: 2, contentType: "text/javascript" },
  { name: "styles", source: "styles.css", sha256: CSS_SHA, bytes: 6120, chunks: 1, contentType: "text/css" },
  { name: "logo", source: "assets/logo.svg", sha256: LOGO_SHA, bytes: 2240, chunks: 1, contentType: "image/svg+xml" },
];

function targetPathFor(source: string, releaseId: string): string {
  return source === "index.html" ? "index.html" : `releases/${releaseId}/${source}`;
}

type FileMode = "verified" | "uploaded" | "pending";

function buildFiles(
  deploymentId: string,
  prefix: string,
  releaseId: string,
  mode: FileMode,
  verifiedAt: string | null,
): ReleaseFile[] {
  return FILE_SEEDS.map((seed, index) => {
    let state: FileState = "PENDING";
    let lastConfirmedChunkIndex = -1;
    if (mode === "verified") {
      state = "VERIFIED";
      lastConfirmedChunkIndex = seed.chunks - 1;
    } else if (mode === "uploaded") {
      if (seed.source === "index.html" || seed.source === "styles.css") {
        state = "PENDING";
        lastConfirmedChunkIndex = -1;
      } else {
        state = "WRITTEN";
        lastConfirmedChunkIndex = seed.chunks - 1;
      }
    }
    return {
      id: `rf-${prefix}-${String(index + 1).padStart(2, "0")}`,
      deploymentId,
      targetPath: targetPathFor(seed.source, releaseId),
      sourceRelativePath: seed.source,
      sha256: seed.sha256,
      byteSize: seed.bytes,
      chunkCount: seed.chunks,
      contentType: seed.contentType,
      state,
      lastConfirmedChunkIndex,
      verifiedAt: state === "VERIFIED" ? verifiedAt : null,
      createdAt: "2026-10-18T09:17:00Z",
      updatedAt: verifiedAt ?? "2026-10-18T09:26:00Z",
    };
  });
}

const liveFiles = buildFiles(MOCK_DEPLOYMENT_IDS.live, "live", RELEASE_LIVE, "verified", "2026-10-18T09:30:00Z");
const verifiedFiles = buildFiles(MOCK_DEPLOYMENT_IDS.verified, "verified", RELEASE_VERIFIED, "verified", "2026-10-18T15:58:00Z");
const uploadedFiles = buildFiles(MOCK_DEPLOYMENT_IDS.uploaded, "uploaded", RELEASE_UPLOADED, "uploaded", null);
const approvalFiles = buildFiles(MOCK_DEPLOYMENT_IDS.approval, "approval", RELEASE_APPROVAL, "pending", null);

export const seedReleaseFiles: readonly ReleaseFile[] = [
  ...liveFiles,
  ...verifiedFiles,
  ...uploadedFiles,
  ...approvalFiles,
];

interface TransactionSeed {
  readonly deploymentId: string;
  readonly prefix: string;
  readonly fileIndex: number | null;
  readonly operation: string;
  readonly nonce: number;
  readonly state: TransactionState;
  readonly block: number;
  readonly gasUsed: string;
  readonly hash: string;
  readonly createdAt: string;
}

const transactionSeeds: readonly TransactionSeed[] = [
  { deploymentId: MOCK_DEPLOYMENT_IDS.live, prefix: "live", fileIndex: 0, operation: "putFile", nonce: 40, state: "SAFE", block: 48214980, gasUsed: "5490000", hash: "aa11bb22cc33dd01", createdAt: "2026-10-18T09:22:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.live, prefix: "live", fileIndex: 1, operation: "putFile", nonce: 41, state: "SAFE", block: 48214981, gasUsed: "6240000", hash: "aa11bb22cc33dd02", createdAt: "2026-10-18T09:23:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.live, prefix: "live", fileIndex: 1, operation: "appendChunk", nonce: 42, state: "SAFE", block: 48214982, gasUsed: "1810000", hash: "aa11bb22cc33dd03", createdAt: "2026-10-18T09:24:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.live, prefix: "live", fileIndex: 2, operation: "putFile", nonce: 43, state: "SAFE", block: 48214983, gasUsed: "1870000", hash: "aa11bb22cc33dd04", createdAt: "2026-10-18T09:25:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.live, prefix: "live", fileIndex: 3, operation: "putFile", nonce: 44, state: "SAFE", block: 48214984, gasUsed: "1210000", hash: "aa11bb22cc33dd05", createdAt: "2026-10-18T09:25:30Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.live, prefix: "live", fileIndex: 0, operation: "setEntry", nonce: 45, state: "SAFE", block: 48214985, gasUsed: "98000", hash: "aa11bb22cc33dd06", createdAt: "2026-10-18T09:28:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.verified, prefix: "verified", fileIndex: 0, operation: "putFile", nonce: 46, state: "SAFE", block: 48214800, gasUsed: "5490000", hash: "bb22cc33dd44ee01", createdAt: "2026-10-18T15:50:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.verified, prefix: "verified", fileIndex: 1, operation: "putFile", nonce: 47, state: "SAFE", block: 48214801, gasUsed: "6240000", hash: "bb22cc33dd44ee02", createdAt: "2026-10-18T15:51:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.verified, prefix: "verified", fileIndex: 1, operation: "appendChunk", nonce: 48, state: "SAFE", block: 48214802, gasUsed: "1810000", hash: "bb22cc33dd44ee03", createdAt: "2026-10-18T15:52:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.verified, prefix: "verified", fileIndex: 2, operation: "putFile", nonce: 49, state: "SAFE", block: 48214803, gasUsed: "1870000", hash: "bb22cc33dd44ee04", createdAt: "2026-10-18T15:53:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.verified, prefix: "verified", fileIndex: 3, operation: "putFile", nonce: 50, state: "SAFE", block: 48214804, gasUsed: "1210000", hash: "bb22cc33dd44ee05", createdAt: "2026-10-18T15:53:30Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.verified, prefix: "verified", fileIndex: 0, operation: "setEntry", nonce: 51, state: "SAFE", block: 48214805, gasUsed: "98000", hash: "bb22cc33dd44ee06", createdAt: "2026-10-18T15:56:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.uploaded, prefix: "uploaded", fileIndex: 1, operation: "putFile", nonce: 52, state: "SAFE", block: 48210040, gasUsed: "6240000", hash: "cc33dd44ee55ff02", createdAt: "2026-10-19T07:15:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.uploaded, prefix: "uploaded", fileIndex: 1, operation: "appendChunk", nonce: 53, state: "SAFE", block: 48210041, gasUsed: "1810000", hash: "cc33dd44ee55ff03", createdAt: "2026-10-19T07:16:00Z" },
  { deploymentId: MOCK_DEPLOYMENT_IDS.uploaded, prefix: "uploaded", fileIndex: 3, operation: "putFile", nonce: 54, state: "INCLUDED", block: 48210042, gasUsed: "1210000", hash: "cc33dd44ee55ff04", createdAt: "2026-10-19T07:17:00Z" },
];

function fileIdFor(prefix: string, fileIndex: number | null): string | null {
  return fileIndex === null ? null : `rf-${prefix}-${String(fileIndex + 1).padStart(2, "0")}`;
}

export const seedTransactions: readonly ChainTransaction[] = transactionSeeds.map((seed, index) => {
  const hash: Hex = hashFrom(seed.hash);
  return {
    id: `tx-${seed.prefix}-${String(index + 1).padStart(2, "0")}`,
    deploymentId: seed.deploymentId,
    releaseFileId: fileIdFor(seed.prefix, seed.fileIndex),
    chainId: 196,
    signerAddress: MOCK_OPERATOR_ONE,
    toAddress: MOCK_REGISTRY,
    operation: seed.operation,
    operationFingerprint: hashFrom(`f${String(index).padStart(2, "0")}0a1b2c3d4e5f`),
    nonce: String(seed.nonce),
    gasLimit: "7000000",
    gasUsed: seed.gasUsed,
    effectiveGasPriceWei: "20000000000",
    txHash: hash,
    state: seed.state,
    receiptBlockNumber: String(seed.block),
    receiptBlockHash: hashFrom(`b${String(index).padStart(2, "0")}0c1d2e3f4a5b`),
    replacementFor: null,
    errorCode: null,
    createdAt: seed.createdAt,
    updatedAt: seed.createdAt,
  };
});

function makePlan(input: {
  readonly releaseId: string;
  readonly commitSha: string;
  readonly container: Hex;
  readonly owner: Hex;
  readonly pinnedBlockNumber: number;
  readonly pinPattern: string;
  readonly observedAt: string;
  readonly costCapWei: string | null;
  readonly warnings?: readonly string[];
}): DeploymentPlan {
  return {
    schemaVersion: "tapeci.plan.v1",
    chainId: 196,
    container: input.container,
    siteRegistry: MOCK_REGISTRY,
    commitSha: input.commitSha,
    releaseId: input.releaseId,
    entryPath: "index.html",
    pinnedBlockNumber: input.pinnedBlockNumber,
    pinnedBlockHash: hashFrom(input.pinPattern),
    operators: ["okx", "drpc"],
    observedAt: input.observedAt,
    totals: { files: 4, writes: 4, unchanged: 0, conflicts: 0, chunks: 5, bytes: 48010 },
    fees: {
      gasPriceWei: "20000000000",
      estimatedGas: "18500000",
      estimatedCostWei: ESTIMATED_COST_WEI,
      marginBps: 2000,
      recommendedCapWei: "444000000000000000",
      costCapWei: input.costCapWei,
      withinBudget: true,
    },
    containerOwner: input.owner,
    containerOpened: true,
    blocked: false,
    blockedReasons: [],
    warnings: input.warnings ?? [],
  };
}

const planLive = makePlan({
  releaseId: RELEASE_LIVE,
  commitSha: COMMIT_LIVE,
  container: MOCK_CONTAINER_ONE,
  owner: MOCK_OWNER_ONE,
  pinnedBlockNumber: 48214990,
  pinPattern: "b19c8d7e6f5a4b3c",
  observedAt: "2026-10-18T09:17:00Z",
  costCapWei: COST_CAP_WEI,
});

const planVerified = makePlan({
  releaseId: RELEASE_VERIFIED,
  commitSha: COMMIT_VERIFIED,
  container: MOCK_CONTAINER_ONE,
  owner: MOCK_OWNER_ONE,
  pinnedBlockNumber: 48214810,
  pinPattern: "b29d9e8f7a6b5c4d",
  observedAt: "2026-10-18T15:45:00Z",
  costCapWei: COST_CAP_WEI,
});

const planUploaded = makePlan({
  releaseId: RELEASE_UPLOADED,
  commitSha: COMMIT_UPLOADED,
  container: MOCK_CONTAINER_TWO,
  owner: MOCK_OWNER_TWO,
  pinnedBlockNumber: 48210050,
  pinPattern: "b39eaf9081726354",
  observedAt: "2026-10-19T07:10:00Z",
  costCapWei: COST_CAP_WEI,
});

const planApproval = makePlan({
  releaseId: RELEASE_APPROVAL,
  commitSha: COMMIT_APPROVAL,
  container: MOCK_CONTAINER_TWO,
  owner: MOCK_OWNER_TWO,
  pinnedBlockNumber: 48202000,
  pinPattern: "b4afb0a192837465",
  observedAt: "2026-10-19T08:15:00Z",
  costCapWei: COST_CAP_WEI,
  warnings: ["cost cap is above the estimate; unused allowance is not spent"],
});

export const seedPlans: Readonly<Record<string, DeploymentPlan>> = {
  [MOCK_DEPLOYMENT_IDS.live]: planLive,
  [MOCK_DEPLOYMENT_IDS.verified]: planVerified,
  [MOCK_DEPLOYMENT_IDS.uploaded]: planUploaded,
  [MOCK_DEPLOYMENT_IDS.approval]: planApproval,
};

function makeVerificationReport(input: {
  readonly deploymentId: string;
  readonly container: Hex;
  readonly releaseId: string;
  readonly commitSha: string;
  readonly pinnedBlockNumber: number;
  readonly observedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly files: readonly ReleaseFile[];
}): VerificationReport {
  const files: VerificationFileCheck[] = input.files.map((file) => ({
    path: file.targetPath,
    sourcePath: file.sourceRelativePath,
    expectedSha256: file.sha256,
    expectedSize: file.byteSize,
    actualSha256: file.sha256,
    actualSize: file.byteSize,
    chainDeclaredSha256: file.sha256,
    chainDeclaredSize: file.byteSize,
    operators: ["okx", "drpc"],
    operatorsAgree: true,
    manifestDeclarationMatchesChain: true,
    matched: true,
  }));
  return {
    chainId: 196,
    container: input.container,
    registry: MOCK_REGISTRY,
    pinnedBlockNumber: input.pinnedBlockNumber,
    observedAt: input.observedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    nodeOperators: ["okx", "drpc"],
    registryImplementation: MOCK_REGISTRY_IMPL,
    bindingImplementation: MOCK_BINDING_IMPL,
    status: "VERIFIED",
    releaseStatus: "VERIFIED",
    releaseMatch: true,
    manifest: {
      chainId: 196,
      container: input.container,
      commitSha: input.commitSha,
      releaseId: input.releaseId,
      entryPath: "index.html",
      fallbackPath: "404.html",
      artifactDigest: ARTIFACT_SHA,
      releaseManifestHash: MANIFEST_SHA,
      fileCount: input.files.length,
      entrySingleTransactionEligible: true,
    },
    files,
    journal: {
      checked: true,
      deploymentId: input.deploymentId,
      complete: true,
      verifiedFilesMatch: true,
      transactionsOk: true,
      allMinedBeforePin: true,
      entryWrittenLast: true,
      transactionCount: 6,
      totalGasUsed: "16451000",
      issues: [],
    },
    finality: {
      pinnedBlockNumber: input.pinnedBlockNumber,
      safeBlockNumber: input.pinnedBlockNumber - 12,
      finalizedBlockNumber: input.pinnedBlockNumber - 40,
      pinnedBlockIsSafe: true,
      pinnedBlockIsFinalized: true,
    },
    warnings: [],
  };
}

export const seedVerifications: Readonly<Record<string, VerificationReport>> = {
  [MOCK_DEPLOYMENT_IDS.live]: makeVerificationReport({
    deploymentId: MOCK_DEPLOYMENT_IDS.live,
    container: MOCK_CONTAINER_ONE,
    releaseId: RELEASE_LIVE,
    commitSha: COMMIT_LIVE,
    pinnedBlockNumber: 48214990,
    observedAt: "2026-10-18T09:29:00Z",
    completedAt: "2026-10-18T09:31:00Z",
    durationMs: 12300,
    files: liveFiles,
  }),
  [MOCK_DEPLOYMENT_IDS.verified]: makeVerificationReport({
    deploymentId: MOCK_DEPLOYMENT_IDS.verified,
    container: MOCK_CONTAINER_ONE,
    releaseId: RELEASE_VERIFIED,
    commitSha: COMMIT_VERIFIED,
    pinnedBlockNumber: 48214810,
    observedAt: "2026-10-18T15:57:00Z",
    completedAt: "2026-10-18T15:58:00Z",
    durationMs: 11700,
    files: verifiedFiles,
  }),
};

function makeSessions(prefix: string, seeds: readonly Omit<OperatorSession, "id">[]): OperatorSession[] {
  return seeds.map((seed, index) => ({ id: `os-${prefix}-${String(index + 1).padStart(2, "0")}`, ...seed }));
}

export const seedContainers: readonly ContainerDetail[] = [
  {
    id: MOCK_CONTAINER_IDS.one,
    chainId: 196,
    address: MOCK_CONTAINER_ONE,
    ownerAddress: MOCK_OWNER_ONE,
    factoryAddress: MOCK_FACTORY,
    processorIndex: 0,
    processorAddress: MOCK_PROCESSOR,
    tokenId: "2",
    openerAddress: MOCK_OPENER,
    registryAddress: MOCK_REGISTRY,
    bindingAddress: MOCK_BINDING,
    opened: true,
    openedAt: "2026-09-02T10:00:00Z",
    lastCheckedBlock: "48214990",
    lastObservedOwner: MOCK_OWNER_ONE,
    lastRegistryImpl: MOCK_REGISTRY_IMPL,
    lastBindingImpl: MOCK_BINDING_IMPL,
    operatorSessions: makeSessions("one", [
      {
        signerAddress: MOCK_OPERATOR_ONE,
        approvalId: "ap-one-01",
        expiresAt: "2026-10-19T14:00:00Z",
        revokedAt: null,
        createdAt: "2026-10-18T09:20:00Z",
      },
      {
        signerAddress: MOCK_OPERATOR_TWO,
        approvalId: "ap-one-02",
        expiresAt: "2026-10-22T08:00:00Z",
        revokedAt: null,
        createdAt: "2026-10-18T16:00:00Z",
      },
      {
        signerAddress: MOCK_OPERATOR_THREE,
        approvalId: null,
        expiresAt: "2026-10-18T12:00:00Z",
        revokedAt: "2026-10-18T10:05:00Z",
        createdAt: "2026-10-18T08:00:00Z",
      },
    ]),
  },
  {
    id: MOCK_CONTAINER_IDS.two,
    chainId: 196,
    address: MOCK_CONTAINER_TWO,
    ownerAddress: MOCK_OWNER_TWO,
    factoryAddress: MOCK_FACTORY,
    processorIndex: 0,
    processorAddress: MOCK_PROCESSOR,
    tokenId: "5",
    openerAddress: MOCK_OPENER,
    registryAddress: MOCK_REGISTRY,
    bindingAddress: MOCK_BINDING,
    opened: true,
    openedAt: "2026-09-20T09:30:00Z",
    lastCheckedBlock: "48210050",
    lastObservedOwner: MOCK_OWNER_TWO,
    lastRegistryImpl: MOCK_REGISTRY_IMPL,
    lastBindingImpl: MOCK_BINDING_IMPL,
    operatorSessions: makeSessions("two", [
      {
        signerAddress: MOCK_OPERATOR_TWO,
        approvalId: "ap-two-01",
        expiresAt: "2026-10-19T18:00:00Z",
        revokedAt: null,
        createdAt: "2026-10-19T07:13:00Z",
      },
    ]),
  },
];

export const MOCK_DEMO_PROJECT_COUNT = seedProjects.length;

// ---------------------------------------------------------------------------
// Domain binding fixtures (`GET /v1/containers/:address/binding`)
// ---------------------------------------------------------------------------

/**
 * Pinned "now" for the binding fixtures (unix seconds). EXPIRED must not depend
 * on the wall clock, so the fixture compares against this constant.
 */
export const MOCK_BINDING_NOW_S = Math.floor(Date.parse("2026-10-25T00:00:00Z") / 1000);
/** `monthlyFee()` reads 0 on X Layer 196 (see the plan): the bind costs gas only. */
export const MOCK_MONTHLY_FEE_WEI = "0";
/** Unix seconds (uint40) exactly as `paidUntil(nameHash, container)` returns it. */
export const MOCK_BINDING_PAID_UNTIL_S = String(
  Math.floor(Date.parse("2027-01-05T00:00:00Z") / 1000),
);
/** A paid-until value that is already in the past for the pinned `now`. */
export const MOCK_BINDING_EXPIRED_PAID_UNTIL_S = String(MOCK_BINDING_NOW_S - 86_400 * 10);
/** Deterministic stand-in for the operator path's transaction hash. */
export const MOCK_BIND_TX_HASH: Hex = hashFrom("b17d0e5a");

export interface MockBindingFixture {
  readonly name: string;
  readonly isLive: boolean;
  readonly isContainerLive: boolean;
  readonly paidUntil: string | null;
  readonly monthlyFeeWei: string | null;
  readonly canWrite: boolean;
  readonly writeBlockedReason: string | null;
  readonly nameRecorded: boolean;
}

/**
 * Keep `MOCK_BINDING` (the `DomainBinding` proxy) in agreement with
 * `seedContainers`, which references the same address on the container page.
 */
const BINDING_FIXTURES: Readonly<Record<string, MockBindingFixture>> = {
  // Container one: "2.2.0.tape" is bound and the gateway serves it.
  [MOCK_CONTAINER_ONE]: {
    name: "2.2.0.tape",
    isLive: true,
    isContainerLive: true,
    paidUntil: MOCK_BINDING_PAID_UNTIL_S,
    monthlyFeeWei: MOCK_MONTHLY_FEE_WEI,
    canWrite: true,
    writeBlockedReason: null,
    nameRecorded: true,
  },
  // Container two: never bound, and the demo operator may not write to it.
  [MOCK_CONTAINER_TWO]: {
    name: "5.2.0.tape",
    isLive: false,
    isContainerLive: false,
    paidUntil: null,
    monthlyFeeWei: MOCK_MONTHLY_FEE_WEI,
    canWrite: false,
    writeBlockedReason: "The operator key is not authorized for this container in demo mode.",
    nameRecorded: false,
  },
};

export function mockBindingFixtureFor(containerAddress: string): MockBindingFixture | undefined {
  return BINDING_FIXTURES[containerAddress.toLowerCase()];
}

export const MOCK_BINDING_SUGGESTED_NAME_FOR = {
  one: "2.2.0.tape",
  two: "5.2.0.tape",
} as const;

/** X Layer 196 area code used by every TapeKit name (`<tokenId>.<area>.<processorIndex>.tape`). */
export const MOCK_AREA_CODE = 2;

/**
 * Read-only fixture for `GET /v1/containers/:address/binding`.
 *
 * `requestedName` is the `?name=` value the page forwards. The fixture derives the
 * state from the same platform reads the real route uses (`isLive`, `paidUntil`),
 * so naming a different name is NOT_ACTIVATED rather than a fabricated ACTIVE.
 */
export function mockContainerBinding(
  containerAddress: string,
  requestedName?: string,
): ContainerBindingStatus {
  const address = containerAddress.toLowerCase();
  const container = seedContainers.find(
    (candidate) => candidate.address.toLowerCase() === address,
  );
  const fixture = BINDING_FIXTURES[address];
  if (container === undefined || fixture === undefined) {
    throw bindingNotFound(`Container ${containerAddress} was not found.`);
  }
  const suggested = suggestedBindingName(container.tokenId, container.processorIndex);
  const requested =
    requestedName === undefined || requestedName.length === 0 ? null : requestedName.toLowerCase();
  const name = requested ?? fixture.name;
  const nameMatches = name === fixture.name;
  const isLive = fixture.isLive && nameMatches;
  const paidUntil = paidUntilFor(fixture, nameMatches);
  const state = bindingStateOf(isLive, paidUntil);
  return {
    containerAddress: container.address,
    bindingAddress: MOCK_BINDING,
    name,
    suggestedName: suggested,
    nameRecorded: nameMatches && fixture.nameRecorded,
    state,
    isLive,
    isContainerLive: fixture.isContainerLive && nameMatches,
    paidUntil,
    monthlyFeeWei: fixture.monthlyFeeWei,
    canWrite: fixture.canWrite,
    writeBlockedReason: fixture.writeBlockedReason,
  };
}

export function suggestedBindingName(tokenId: string | number, processorIndex: number): string {
  return `${String(tokenId)}.${String(MOCK_AREA_CODE)}.${String(processorIndex)}.tape`;
}

/** When a different name is requested, only the container-wide payment remains. */
function paidUntilFor(fixture: MockBindingFixture, nameMatches: boolean): string | null {
  if (nameMatches) return fixture.paidUntil;
  return fixture.paidUntil === null ? null : MOCK_BINDING_EXPIRED_PAID_UNTIL_S;
}

function bindingStateOf(
  isLive: boolean,
  paidUntil: string | null,
): ContainerBindingStatus["state"] {
  if (isLive) return "ACTIVE";
  if (paidUntil !== null && Number(paidUntil) <= MOCK_BINDING_NOW_S) return "EXPIRED";
  return "NOT_ACTIVATED";
}

function bindingNotFound(message: string): ApiError {
  return new ApiError(message, {
    status: 404,
    code: "NOT_FOUND",
    retryable: false,
    requestId: null,
  });
}

// ---------------------------------------------------------------------------
// Resource discovery fixtures (`GET /v1/resources/*`) — SPEC §7.2, §8
//
// Four wallet addresses select the four page states by their last byte, so every
// state is reachable from the URL without editing fixtures:
//   …01 ready, with rows (including not_found, unavailable and "not derived")
//   …02 partial scan (`complete: false`)
//   …03 RPC unavailable (no boolean may be rendered from it)
//   …04 ready and genuinely empty (the only "no circuits" case, W2)
// ---------------------------------------------------------------------------

const RESOURCE_OBSERVED_BLOCK = "42891188";
const RESOURCE_INDEXED_BLOCK = "42890412";
const RESOURCE_HEAD_BLOCK = "42891200";

export const MOCK_RESOURCES_READY_ADDRESS: Hex =
  "0x12c4e6a8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f801";
export const MOCK_RESOURCES_PARTIAL_ADDRESS: Hex =
  "0x12c4e6a8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f802";
export const MOCK_RESOURCES_UNAVAILABLE_ADDRESS: Hex =
  "0x12c4e6a8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f803";
export const MOCK_RESOURCES_EMPTY_ADDRESS: Hex =
  "0x12c4e6a8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f804";

export const MOCK_PROCESSOR_TWO: Hex = "0x9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b";
export const MOCK_RESOURCE_CONTAINER_THREE: Hex =
  "0x3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d";

export const MOCK_RESOURCE_PROCESSORS: readonly ProcessorRef[] = [
  { processorIndex: 0, processor: MOCK_PROCESSOR },
  { processorIndex: 1, processor: MOCK_PROCESSOR_TWO },
];

export const MOCK_RESOURCE_CATALOGUE: ProcessorCatalogue = {
  chainId: 196,
  processors: MOCK_RESOURCE_PROCESSORS,
  syncStatus: "ready",
  complete: true,
  indexedThroughBlock: RESOURCE_INDEXED_BLOCK,
  observedBlock: RESOURCE_HEAD_BLOCK,
};

/**
 * One row per read outcome: verified true/true, verified true/false, `not_found`,
 * `unavailable` (all-null), a real `false` with no derived container, and a token id
 * long enough to prove it is never coerced to `Number`.
 */
const MOCK_RESOURCE_ONE: WalletResource = {
  resource: { chainId: 196, processor: MOCK_PROCESSOR, tokenId: "1" },
  processorIndex: 0,
  container: MOCK_CONTAINER_ONE,
  owner: MOCK_OWNER_ONE,
  deployed: true,
  opened: true,
  observedBlock: RESOURCE_OBSERVED_BLOCK,
  readStatus: "verified",
};

const MOCK_RESOURCE_TWO: WalletResource = {
  resource: { chainId: 196, processor: MOCK_PROCESSOR, tokenId: "2" },
  processorIndex: 0,
  container: MOCK_CONTAINER_TWO,
  owner: MOCK_OWNER_ONE,
  deployed: true,
  opened: false,
  observedBlock: RESOURCE_OBSERVED_BLOCK,
  readStatus: "verified",
};

const MOCK_RESOURCE_ABSENT: WalletResource = {
  resource: { chainId: 196, processor: MOCK_PROCESSOR, tokenId: "7" },
  processorIndex: 0,
  container: null,
  owner: null,
  deployed: null,
  opened: null,
  observedBlock: RESOURCE_OBSERVED_BLOCK,
  readStatus: "not_found",
};

const MOCK_RESOURCE_UNREADABLE: WalletResource = {
  resource: { chainId: 196, processor: MOCK_PROCESSOR_TWO, tokenId: "3" },
  processorIndex: 1,
  container: null,
  owner: null,
  deployed: null,
  opened: null,
  observedBlock: null,
  readStatus: "unavailable",
};

const MOCK_RESOURCE_NOT_DEPLOYED: WalletResource = {
  resource: { chainId: 196, processor: MOCK_PROCESSOR_TWO, tokenId: "4" },
  processorIndex: 1,
  container: null,
  owner: MOCK_OWNER_TWO,
  deployed: false,
  opened: false,
  observedBlock: RESOURCE_OBSERVED_BLOCK,
  readStatus: "verified",
};

const MOCK_RESOURCE_LARGE_TOKEN: WalletResource = {
  resource: {
    chainId: 196,
    processor: MOCK_PROCESSOR_TWO,
    tokenId: "123456789012345678901234567890",
  },
  processorIndex: 1,
  container: MOCK_RESOURCE_CONTAINER_THREE,
  owner: MOCK_OWNER_ONE,
  deployed: true,
  opened: true,
  observedBlock: RESOURCE_OBSERVED_BLOCK,
  readStatus: "verified",
};

export const MOCK_RESOURCE_ROWS: readonly WalletResource[] = [
  MOCK_RESOURCE_ONE,
  MOCK_RESOURCE_TWO,
  MOCK_RESOURCE_ABSENT,
  MOCK_RESOURCE_UNREADABLE,
  MOCK_RESOURCE_NOT_DEPLOYED,
  MOCK_RESOURCE_LARGE_TOKEN,
];

export const MOCK_WALLET_RESOURCES_READY: WalletResourcePage = {
  address: MOCK_RESOURCES_READY_ADDRESS,
  chainId: 196,
  resources: MOCK_RESOURCE_ROWS,
  nextCursor: null,
  syncStatus: "ready",
  complete: true,
  indexedThroughBlock: RESOURCE_INDEXED_BLOCK,
  observedBlock: RESOURCE_OBSERVED_BLOCK,
};

export const MOCK_WALLET_RESOURCES_PARTIAL: WalletResourcePage = {
  address: MOCK_RESOURCES_PARTIAL_ADDRESS,
  chainId: 196,
  resources: MOCK_RESOURCE_ROWS.slice(0, 2),
  nextCursor: null,
  syncStatus: "partial",
  complete: false,
  indexedThroughBlock: "42880000",
  observedBlock: RESOURCE_HEAD_BLOCK,
};

/** No row may carry a boolean here: the read failed, so nothing is known (W5). */
export const MOCK_WALLET_RESOURCES_UNAVAILABLE: WalletResourcePage = {
  address: MOCK_RESOURCES_UNAVAILABLE_ADDRESS,
  chainId: 196,
  resources: [],
  nextCursor: null,
  syncStatus: "unavailable",
  complete: false,
  indexedThroughBlock: null,
  observedBlock: null,
};

export const MOCK_WALLET_RESOURCES_EMPTY: WalletResourcePage = {
  address: MOCK_RESOURCES_EMPTY_ADDRESS,
  chainId: 196,
  resources: [],
  nextCursor: null,
  syncStatus: "ready",
  complete: true,
  indexedThroughBlock: RESOURCE_INDEXED_BLOCK,
  observedBlock: RESOURCE_OBSERVED_BLOCK,
};

export function mockWalletResourcePageFor(address: Hex): WalletResourcePage {
  const page = (() => {
    switch (address.toLowerCase().slice(-2)) {
      case "02":
        return MOCK_WALLET_RESOURCES_PARTIAL;
      case "03":
        return MOCK_WALLET_RESOURCES_UNAVAILABLE;
      case "04":
        return MOCK_WALLET_RESOURCES_EMPTY;
      default:
        return MOCK_WALLET_RESOURCES_READY;
    }
  })();
  return { ...page, address };
}

/** Manual-lookup fixture rows; keyed by the base-10 token id from the form. */
const MOCK_INSPECTION_ROWS: Readonly<Record<string, WalletResource>> = {
  "0": {
    resource: { chainId: 196, processor: MOCK_PROCESSOR, tokenId: "0" },
    processorIndex: 0,
    container: null,
    owner: null,
    deployed: null,
    opened: null,
    observedBlock: RESOURCE_OBSERVED_BLOCK,
    readStatus: "not_found",
  },
  "1": MOCK_RESOURCE_ONE,
  "2": MOCK_RESOURCE_TWO,
  "4": MOCK_RESOURCE_NOT_DEPLOYED,
  "5": MOCK_RESOURCE_UNREADABLE,
};

/**
 * `POST /v1/resources/inspect` fixture. An unlisted processor is rejected exactly
 * like the route does (422), and `tokenId` stays a string end to end.
 */
export function mockResourceInspection(processor: Hex, tokenId: string): WalletResource {
  const entry = MOCK_RESOURCE_PROCESSORS.find(
    (candidate) => candidate.processor.toLowerCase() === processor.toLowerCase(),
  );
  if (entry === undefined) {
    throw new ApiError(`processor ${processor} is not in the factory catalogue`, {
      status: 422,
      code: "PROCESSOR_NOT_REGISTERED",
      retryable: false,
      requestId: null,
      details: { processor },
    });
  }
  const row = MOCK_INSPECTION_ROWS[tokenId];
  const base: WalletResource =
    row ?? {
      resource: { chainId: 196, processor, tokenId },
      processorIndex: entry.processorIndex,
      container: null,
      owner: null,
      deployed: null,
      opened: null,
      observedBlock: RESOURCE_OBSERVED_BLOCK,
      readStatus: "not_found",
    };
  return {
    ...base,
    resource: { chainId: 196, processor, tokenId },
    processorIndex: entry.processorIndex,
  };
}
