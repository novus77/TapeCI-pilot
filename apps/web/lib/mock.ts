import type { DeploymentActionCapabilities, DeploymentActionResult } from "./action-types";
import type { ProcessorCatalogue, WalletResource, WalletResourcePage } from "./api";
import {
  APPROVAL_CHAIN_ID,
  APPROVAL_DOMAIN_NAME,
  APPROVAL_DOMAIN_VERSION,
  APPROVAL_PRIMARY_TYPE,
  APPROVAL_TYPES,
} from "./approval-signature";
import { parseBindMonths, validateBindName } from "./binding";
import { ApiError } from "./errors";
import * as mockData from "./mock-data";
import {
  seedContainers,
  seedDeployments,
  seedEvents,
  seedPlans,
  seedProjects,
  seedReleaseFiles,
  seedReleases,
  seedTransactions,
  seedVerifications,
} from "./mock-data";
import type {
  ApprovalTypedData,
  BindRequestInput,
  BindResult,
  ChainTransaction,
  ContainerBindingStatus,
  ContainerDetail,
  ContainerSummary,
  CreateProjectInput,
  DeploymentDetail,
  DeploymentEvent,
  DeploymentFilter,
  DeploymentPlan,
  DeploymentState,
  DeploymentSummary,
  OperatorSession,
  Project,
  Release,
  ReleaseFile,
  VerificationReport,
  PublicationSummary,
  PreparedStepAction,
  PreparationQuote,
  PreparationTask,
} from "./types";
import type {
  MintableProcessor,
  MintableProcessorList,
  SelfMintQuote,
} from "./api";

/**
 * In-memory fixture backend used when `NEXT_PUBLIC_TAPECI_MOCK=1`.
 * Mutating calls are demo simulations: they change this process's fixture store
 * and never sign or broadcast anything.
 */

interface MockStore {
  projects: Project[];
  deployments: DeploymentSummary[];
  events: DeploymentEvent[];
  files: ReleaseFile[];
  transactions: ChainTransaction[];
  plans: Record<string, DeploymentPlan>;
  verifications: Record<string, VerificationReport>;
  containers: ContainerDetail[];
  releases: Release[];
}

function cloneSession(session: OperatorSession): OperatorSession {
  return { ...session };
}

function cloneContainer(container: ContainerDetail): ContainerDetail {
  return { ...container, operatorSessions: container.operatorSessions.map(cloneSession) };
}

const store: MockStore = {
  projects: seedProjects.map((project) => ({
    ...project,
    container: { ...project.container },
    installations: (project.installations ?? []).map((installation) => ({ ...installation })),
  })),
  deployments: seedDeployments.map((deployment) => ({ ...deployment })),
  events: seedEvents.map((event) => ({ ...event, payload: { ...event.payload } })),
  files: seedReleaseFiles.map((file) => ({ ...file })),
  transactions: seedTransactions.map((transaction) => ({ ...transaction })),
  plans: { ...seedPlans },
  verifications: { ...seedVerifications },
  containers: seedContainers.map(cloneContainer),
  releases: seedReleases.map((release) => ({ ...release })),
};

function notFound(message: string): ApiError {
  return new ApiError(message, {
    status: 404,
    code: "NOT_FOUND",
    retryable: false,
    requestId: null,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function findDeployment(deploymentId: string): DeploymentSummary {
  const deployment = store.deployments.find((candidate) => candidate.id === deploymentId);
  if (deployment === undefined) throw notFound(`Deployment ${deploymentId} was not found.`);
  return deployment;
}

function updateDeployment(
  deploymentId: string,
  patch: Partial<DeploymentSummary>,
): DeploymentSummary {
  const existing = findDeployment(deploymentId);
  const updated: DeploymentSummary = { ...existing, ...patch };
  store.deployments = store.deployments.map((candidate) =>
    candidate.id === deploymentId ? updated : candidate,
  );
  return updated;
}

function appendEvent(input: {
  readonly deploymentId: string;
  readonly oldState: DeploymentState | null;
  readonly newState: DeploymentState | null;
  readonly eventType: string;
  readonly actorKind: DeploymentEvent["actorKind"];
  readonly actorId: string | null;
  readonly payload: Record<string, unknown>;
}): void {
  store.events.push({
    id: `ev-runtime-${String(store.events.length + 1).padStart(4, "0")}`,
    deploymentId: input.deploymentId,
    oldState: input.oldState,
    newState: input.newState,
    eventType: input.eventType,
    actorKind: input.actorKind,
    actorId: input.actorId,
    payload: input.payload,
    createdAt: nowIso(),
  });
}

function containerSummary(container: ContainerDetail): ContainerSummary {
  return {
    address: container.address,
    chainId: container.chainId,
    ownerAddress: container.ownerAddress,
    registryAddress: container.registryAddress,
    opened: container.opened,
  };
}

function withCollections(deployment: DeploymentSummary): DeploymentDetail {
  return {
    ...deployment,
    releaseFiles: store.files.filter((file) => file.deploymentId === deployment.id),
    transactions: store.transactions.filter(
      (transaction) => transaction.deploymentId === deployment.id,
    ),
  };
}

export async function getOrganization(orgId: string) {
  return {
    // The slug follows the requested id so the breadcrumb does not claim a
    // different organization than the URL.
    organization: { id: orgId, name: "Mock org", slug: orgId },
    role: "owner" as const,
    canManage: orgId === "mock-managed-org",
    members: mockData.MOCK_ORGANIZATION_MEMBERS.map((member) => ({ ...member })),
    projects: [
      {
        id: mockData.MOCK_PROJECT_IDS.tapekit,
        repoFullName: "tapeoutprotocol/tapekit-site",
        defaultBranch: "main",
      },
    ],
    projectCount: 1,
  };
}

export async function listProjects(): Promise<readonly Project[]> {
  return store.projects.map((project) => ({
    ...project,
    container: { ...project.container },
    installations: [...(project.installations ?? [])],
  }));
}

export async function getProject(projectId: string): Promise<Project> {
  const project = store.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) throw notFound(`Project ${projectId} was not found.`);
  return {
    ...project,
    container: { ...project.container },
    installations: [...(project.installations ?? [])],
  };
}

/**
 * §12.4 fixture. Deliberately exercises the *partial* fact cases rather than a happy
 * path: a verified release with an expired binding and an unreachable gateway is what the
 * UI must render honestly, and a fixture that only shows "everything green" would hide
 * exactly the bugs this section is about.
 */
/* ------------------------------------------------------------------ *
 * P3 preparation (SPEC §7.2, §7.3). Deterministic fixtures that keep the
 * two price lines separate and never claim a site is live.
 * ------------------------------------------------------------------ */

const MOCK_RECIPIENT = "0x12c4e6a8b0d2f4a6c8e0b2d4f6a8c0e2b4d6f801" as const;
const MOCK_OPENER = "0x536add8f30f03b69f6fbf29d425a816a0dc50106" as const;

export async function createResourceQuote(input: {
  readonly processor: string;
  readonly tokenId: string;
  /** The delivery wallet. The quote must be priced FOR it, not for a fixture address. */
  readonly recipient?: string;
}): Promise<PreparationQuote> {
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  // Honour the caller's recipient: returning a hardcoded address made the mock journey
  // incoherent — the quote succeeded for one wallet while the task then reported a
  // recipient mismatch, which is fixture noise rather than a real product state.
  const recipient = (input.recipient ?? MOCK_RECIPIENT) as `0x${string}`;
  return {
    id: `quote-${input.tokenId}`,
    userId: "user-demo",
    recipient,
    chainId: 196,
    sourceId: "opener",
    offerId: null,
    resource: { chainId: 196, processor: input.processor as `0x${string}`, tokenId: input.tokenId },
    steps: [
      {
        id: `step-${input.tokenId}`,
        ordinal: 0,
        kind: "open",
        resource: { chainId: 196, processor: input.processor as `0x${string}`, tokenId: input.tokenId },
        prices: [],
      },
    ],
    // Two separate lines, deliberately: the fee is exact and the gas is an estimate.
    prices: [
      {
        kind: "open",
        currency: "OKB",
        amountWei: "80000000000000000",
        estimated: false,
        payer: recipient,
        payee: MOCK_OPENER,
      },
      {
        kind: "gas",
        currency: "OKB",
        amountWei: "21000000000000",
        estimated: true,
        payer: recipient,
        payee: null,
      },
    ],
    observedBlock: "74329800",
    expiresAt,
    termsVersion: "open.v1",
  };
}

const MOCK_TASKS = new Map<string, PreparationTask>();

export async function createPreparation(input: {
  readonly quoteId: string;
}): Promise<PreparationTask> {
  const id = `task-${input.quoteId}`;
  const existing = MOCK_TASKS.get(id);
  if (existing !== undefined) return existing;
  const now = new Date().toISOString();
  const task: PreparationTask = {
    id,
    state: "waiting_user",
    recipient: MOCK_RECIPIENT,
    chainId: 196,
    initialQuoteId: input.quoteId,
    currentQuoteId: input.quoteId,
    version: 1,
    steps: [
      {
        id: `step-${input.quoteId}`,
        ordinal: 0,
        kind: "open",
        // The first step starts `waiting`; `prepare` moves it to awaiting_signature.
        state: "waiting",
        resource: null,
        quoteId: input.quoteId,
        intentId: null,
        transactions: [],
        errorCode: null,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  MOCK_TASKS.set(id, task);
  return task;
}

export async function getPreparation(taskId: string): Promise<PreparationTask> {
  const task = MOCK_TASKS.get(taskId);
  if (task !== undefined) return task;
  // A stable fixture so the page renders on a direct visit, in the state that needs the
  // wallet — the point of the screen.
  const now = new Date().toISOString();
  return {
    id: taskId,
    state: "waiting_user",
    recipient: MOCK_RECIPIENT,
    chainId: 196,
    initialQuoteId: "quote-demo",
    currentQuoteId: "quote-demo",
    version: 1,
    steps: [
      {
        id: "step-demo",
        ordinal: 0,
        kind: "open",
        state: "awaiting_signature",
        resource: null,
        quoteId: "quote-demo",
        intentId: "intent-demo",
        transactions: [],
        errorCode: null,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export async function prepareStep(input: {
  readonly taskId: string;
  readonly stepId: string;
}): Promise<PreparedStepAction> {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  return {
    kind: "transaction",
    intent: {
      intentId: `intent-${input.taskId}`,
      taskId: input.taskId,
      stepId: input.stepId,
      quoteId: "quote-demo",
      chainId: 196,
      from: MOCK_RECIPIENT,
      to: MOCK_OPENER,
      value: "80000000000000000",
      maxValueWei: "80000000000000000",
      data: "0x8f2b1c4a",
      gasLimit: "180000",
      gasPriceWei: "150000000",
      maxGasCostWei: "27000000000000",
      expiresAt,
    },
  };
}

export async function recordStepTransaction(input: {
  readonly taskId: string;
}): Promise<PreparationTask> {
  const task = await getPreparation(input.taskId);
  // Recording a hash means "submitted", never "confirmed" — the server decides that later.
  return {
    ...task,
    version: task.version + 1,
    steps: task.steps.map((step) => ({
      ...step,
      state: "submitted" as const,
      transactions: [
        {
          id: `tx-${step.id}`,
          intentId: step.intentId ?? "intent-demo",
          txHash: "0x9c1f0e5b2d4a6c8e0b2d4f6a8c0e2b4d6f801234567890abcdef1234567890ab",
          status: "submitted" as const,
          blockNumber: null,
          valueWei: "80000000000000000",
        },
      ],
    })),
  };
}

export async function reconcilePreparation(input: {
  readonly taskId: string;
}): Promise<PreparationTask> {
  // Reconciliation reports; it does not confirm. The step stays `submitted` here.
  return getPreparation(input.taskId);
}

export async function getProjectPublication(projectId: string): Promise<PublicationSummary> {
  const releases = await listProjectReleases(projectId);
  const current = releases.find((release) => release.isCurrent) ?? null;
  if (current === null) {
    return {
      release: null,
      binding: null,
      publicUrl: null,
      gatewayCheck: "unknown",
      checkedAt: null,
      missing: ["NO_CURRENT_RELEASE"],
    };
  }
  return {
    release: {
      // `deploymentId` is optional on the summary type because a release row can outlive
      // the deployment view; the fixture always has one.
      deploymentId: current.deploymentId ?? current.id,
      releaseId: current.releaseId,
      commitSha: current.commitSha,
      manifestSha256: current.manifestSha256,
      entryPath: current.entryPath,
      verified: true,
      verifiedBlockNumber: current.verifiedBlockNumber,
      activatedAt: current.activatedAt,
    },
    // Expired on purpose: the release is verified, the name is not — two facts.
    binding: { state: "expired", name: "2.2.0.tape", paidUntil: "2026-09-01T00:00:00.000Z" },
    publicUrl: "https://2-2-0.tapekit.org/",
    gatewayCheck: "unreachable",
    checkedAt: "2026-10-27T12:00:00.000Z",
    missing: ["GATEWAY_UNREACHABLE", "BINDING_EXPIRED"],
  };
}

export async function listProjectReleases(projectId: string): Promise<readonly Release[]> {
  const project = store.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) throw notFound(`Project ${projectId} was not found.`);
  return store.releases.filter((release) => release.projectId === projectId);
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const address = input.containerAddress.toLowerCase();
  let container = store.containers.find(
    (candidate) => candidate.address.toLowerCase() === address,
  );
  if (container === undefined) {
    const sequence = String(store.containers.length + 1).padStart(2, "0");
    container = {
      id: `eeeeeeee-eeee-4eee-8eee-${sequence.padStart(12, "0")}`,
      chainId: 196,
      address: input.containerAddress,
      ownerAddress: "0x7a8b9c0d1e2f30415263748596a7b8c9d0e1f203",
      factoryAddress: "0xc4a1e7f39b2d5068a0c4e6f8b1d3a5c7e9f0b2d4",
      processorIndex: 0,
      processorAddress: "0x4d3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0",
      tokenId: "1",
      openerAddress: "0x6b1d3f5a7c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d",
      registryAddress: "0x8f2b9d6a4c1e3f5079b2d8c4a6e0f1b3c5d7e9a2",
      bindingAddress: "0xa0b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d",
      opened: true,
      openedAt: nowIso(),
      lastCheckedBlock: "48214990",
      lastObservedOwner: "0x7a8b9c0d1e2f30415263748596a7b8c9d0e1f203",
      lastRegistryImpl: "0x5e9f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b",
      lastBindingImpl: "0x8d7c6b5a4938271605f4e3d2c1b0a99887766554",
      operatorSessions: [],
    };
    store.containers.push(container);
  }
  const now = nowIso();
  const sequence = String(store.projects.length + 1).padStart(12, "0");
  const project: Project = {
    id: `33333333-3333-4333-8333-${sequence}`,
    repoFullName: input.repoFullName,
    defaultBranch: input.defaultBranch,
    buildCommand: input.buildCommand,
    installCommand: input.installCommand,
    outputDirectory: input.outputDirectory,
    strictDewebMode: true,
    isArchived: false,
    container: containerSummary(container),
    installations: [
      {
        id: `inst-demo-${sequence}`,
        installationId: 81234567,
        accountLogin: "demo-user",
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  store.projects.unshift(project);
  return project;
}

export async function listDeployments(
  filter: DeploymentFilter = {},
): Promise<readonly DeploymentSummary[]> {
  let rows = [...store.deployments];
  if (filter.projectId !== undefined) {
    rows = rows.filter((deployment) => deployment.projectId === filter.projectId);
  }
  if (filter.state !== undefined) {
    rows = rows.filter((deployment) => deployment.state === filter.state);
  }
  // Mirror the server: the mock must honour sort/dir or mock-mode e2e cannot
  // verify that clicking a header reorders anything.
  const sort = filter.sort ?? "requestedAt";
  const dir = filter.dir ?? "desc";
  const sign = dir === "asc" ? 1 : -1;
  rows.sort((left, right) => {
    if (sort === "state") return sign * left.state.localeCompare(right.state);
    if (sort === "project") {
      return sign * (left.project?.repoFullName ?? "").localeCompare(right.project?.repoFullName ?? "");
    }
    return sign * left.requestedAt.localeCompare(right.requestedAt);
  });
  const limit = filter.limit ?? filter.pageSize ?? 50;
  return rows.slice(0, limit).map((deployment) => ({ ...deployment }));
}

export async function getDeployment(deploymentId: string): Promise<DeploymentDetail> {
  return withCollections(findDeployment(deploymentId));
}

export async function listDeploymentEvents(
  deploymentId: string,
): Promise<readonly DeploymentEvent[]> {
  findDeployment(deploymentId);
  return store.events
    .filter((event) => event.deploymentId === deploymentId)
    .sort((left, right) => {
      const byTime = left.createdAt.localeCompare(right.createdAt);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    })
    .map((event) => ({ ...event, payload: { ...event.payload } }));
}

export async function getDeploymentPlan(deploymentId: string): Promise<DeploymentPlan | null> {
  findDeployment(deploymentId);
  return store.plans[deploymentId] ?? null;
}

/**
 * Deterministic stand-in for `GET /v1/deployments/:id/approval-payload`.
 *
 * Demo mode never signs and never submits, so the nonce is derived from the
 * deployment (not random) to keep fixtures reproducible. The shape matches the
 * API response exactly; only the values are fixtures.
 */
export async function getApprovalPayload(deploymentId: string): Promise<ApprovalTypedData> {
  const deployment = findDeployment(deploymentId);
  const plan = store.plans[deploymentId] ?? null;
  const manifestHash = deployment.manifestSha256;
  if (manifestHash === null || plan === null) {
    throw new ApiError("The deployment has no signed plan yet.", {
      status: 409,
      code: "PLAN_NOT_READY",
      retryable: false,
      requestId: null,
    });
  }
  const container = store.containers.find(
    (candidate) => candidate.id === deployment.containerId,
  );
  const approval = {
    manifestHash,
    container: deployment.containerAddress ?? plan.container,
    costCapWei: plan.fees.recommendedCapWei,
    nonce: `demo-${deploymentId}`,
    expiresAt: String(Math.floor(Date.now() / 1000) + 3_600),
  };
  return {
    domain: {
      name: APPROVAL_DOMAIN_NAME,
      version: APPROVAL_DOMAIN_VERSION,
      chainId: APPROVAL_CHAIN_ID,
      verifyingContract: deployment.registryAddress ?? plan.siteRegistry,
    },
    types: APPROVAL_TYPES,
    primaryType: APPROVAL_PRIMARY_TYPE,
    message: { deploymentId: deployment.id, ...approval },
    approval,
    expectedSigner: container?.lastObservedOwner ?? plan.containerOwner,
  };
}

export async function approveDeploymentWithSignature(
  deploymentId: string,
  _signerAddress: string,
  _signature: string,
  _approval: ApprovalTypedData["approval"],
): Promise<DeploymentActionResult> {
  return {
    ok: false,
    message:
      "Demo mode never accepts a signature: this build holds no key and cannot write to a chain. Use a live API build to record a real approval.",
    deploymentId,
  };
}

export async function getVerificationReport(
  deploymentId: string,
): Promise<VerificationReport | null> {
  findDeployment(deploymentId);
  return store.verifications[deploymentId] ?? null;
}

export async function getContainer(containerAddress: string): Promise<ContainerDetail> {
  const address = containerAddress.toLowerCase();
  const container = store.containers.find(
    (candidate) => candidate.address.toLowerCase() === address,
  );
  if (container === undefined) throw notFound(`Container ${containerAddress} was not found.`);
  return cloneContainer(container);
}

/** Read-only activation status; delegates to the deterministic fixtures. */
export async function getContainerBinding(
  containerAddress: string,
  requestedName?: string,
): Promise<ContainerBindingStatus> {
  // `getContainer` also enforces the 404 contract for unknown addresses.
  await getContainer(containerAddress);
  return mockData.mockContainerBinding(containerAddress, requestedName);
}

/**
 * Demo stand-in for `POST /v1/containers/:address/bind`. It validates the input
 * exactly like the real route and then records a local "live" state; it never
 * signs and never broadcasts anything.
 */
export async function bindContainer(
  containerAddress: string,
  input: BindRequestInput,
): Promise<BindResult> {
  await getContainer(containerAddress);
  const address = containerAddress.toLowerCase();
  const fixture = mockData.mockBindingFixtureFor(address);
  if (fixture === undefined) throw notFound(`Container ${containerAddress} was not found.`);
  const nameError = validateBindName(input.name);
  if (nameError !== null) {
    return { ok: false, message: nameError, txHash: null, alreadyLive: false };
  }
  const months = parseBindMonths(input.months);
  if (months === null) {
    return { ok: false, message: "Months must be a whole number between 1 and 120.", txHash: null, alreadyLive: false };
  }
  if (!fixture.canWrite) {
    return {
      ok: false,
      message: fixture.writeBlockedReason ?? "The operator may not write to this container.",
      txHash: null,
      alreadyLive: false,
    };
  }
  const status = mockData.mockContainerBinding(address, input.name);
  if (status.isLive) {
    return {
      ok: true,
      message: `The name ${input.name} is already live for this container.`,
      txHash: null,
      alreadyLive: true,
    };
  }
  return {
    ok: true,
    message: `Demo mode simulated bind(${input.name}, ${containerAddress}, ${String(months)}). No transaction was broadcast.`,
    txHash: mockData.MOCK_BIND_TX_HASH,
    alreadyLive: false,
  };
}

export async function getDeploymentActionCapabilities(
  deploymentId: string,
): Promise<DeploymentActionCapabilities> {
  const deployment = findDeployment(deploymentId);
  const currentRelease =
    store.releases.find(
      (release) => release.projectId === deployment.projectId && release.isCurrent,
    ) ?? null;
  const inFlight = store.deployments.some(
    (candidate) =>
      candidate.id !== deployment.id &&
      candidate.containerId === deployment.containerId &&
      ["APPROVED", "UPLOADING_ASSETS", "VERIFYING_ASSETS", "SWITCHING_ENTRY", "VERIFYING_RELEASE"].includes(
        candidate.state,
      ),
  );
  const canApprove =
    deployment.state === "AWAITING_APPROVAL" || deployment.state === "PLAN_READY";
  const canExecute = deployment.state === "APPROVED";
  const canRollback = deployment.state === "LIVE" && currentRelease !== null && !inFlight;
  // §12.2/§12.3: the fixture mirrors the server's deny-by-default capability, so the
  // demo cannot show a button the real API would refuse.
  const canResume = deployment.state === "UPLOAD_INTERRUPTED" && !inFlight;
  const canReapprove = deployment.state === "APPROVAL_EXPIRED";
  return {
    canApprove,
    canExecute,
    canRollback,
    canResume,
    canReapprove,
    blockedReason:
      canApprove || canExecute || canRollback || canResume || canReapprove
        ? null
        : "this deployment has no action the server would accept",
    reasons: {
      approve: canApprove
        ? "Sign the EIP-712 approval with the container owner wallet. In demo mode this is simulated."
        : "Approval is only available after the plan is ready and before execution starts.",
      execute: canExecute
        ? "Approved. Execute enqueues the deploy worker; it never signs in the browser."
        : deployment.state === "BUILD_FAILED"
          ? "The build failed, so there is no artifact to execute."
          : "Execution requires an approved EIP-712 approval.",
      resume: canResume
        ? "The stored plan and journal are usable; resume continues the unfinished writes."
        : null,
      reapprove: canReapprove
        ? "The approval expired; reapproval opens a fresh approval window for the same plan."
        : null,
      rollback: canRollback
        ? "Creates a new rollback deployment in AWAITING_APPROVAL. No transaction is sent from the console."
        : currentRelease === null
          ? "No current verified release is available to roll back to."
          : inFlight
            ? "Another chain-writing deployment is in flight for this container."
            : "Rollback is available for a Live deployment with a current release.",
    },
    demoMode: true,
    requiresSignature: true,
  };
}

export async function approveDeployment(
  deploymentId: string,
): Promise<DeploymentActionResult> {
  const deployment = findDeployment(deploymentId);
  if (deployment.state !== "AWAITING_APPROVAL" && deployment.state !== "PLAN_READY") {
    return {
      ok: false,
      message: `Approval is not available in state ${deployment.state}.`,
      deploymentId,
    };
  }
  const plan = store.plans[deploymentId] ?? null;
  const updated = updateDeployment(deploymentId, {
    state: "APPROVED",
    stateVersion: deployment.stateVersion + 1,
    approvedCostCapWei: plan?.fees.recommendedCapWei ?? null,
    updatedAt: nowIso(),
  });
  appendEvent({
    deploymentId,
    oldState: deployment.state,
    newState: "APPROVED",
    eventType: "approval.signed",
    actorKind: "user",
    actorId: "demo-user",
    payload: {
      demo: true,
      note: "simulated EIP-712 approval; no signature and no transaction",
      manifestSha256: updated.manifestSha256,
      approvedCostCapWei: updated.approvedCostCapWei,
    },
  });
  return {
    ok: true,
    message: `Approval recorded in demo mode (${deployment.state} → APPROVED). No wallet signature was produced and no chain transaction was sent.`,
    deploymentId,
  };
}

export async function executeDeployment(
  deploymentId: string,
): Promise<DeploymentActionResult> {
  const deployment = findDeployment(deploymentId);
  if (deployment.state !== "APPROVED") {
    return {
      ok: false,
      message: `Execution requires state APPROVED; this deployment is ${deployment.state}.`,
      deploymentId,
    };
  }
  updateDeployment(deploymentId, {
    state: "UPLOADING_ASSETS",
    stateVersion: deployment.stateVersion + 1,
    startedAt: nowIso(),
    updatedAt: nowIso(),
  });
  appendEvent({
    deploymentId,
    oldState: "APPROVED",
    newState: "UPLOADING_ASSETS",
    eventType: "chain.write.started",
    actorKind: "worker",
    actorId: "demo-worker",
    payload: { demo: true, note: "execution simulated; no transaction was broadcast" },
  });
  return {
    ok: true,
    message:
      "Execution simulated in demo mode: the deployment moved to UPLOADING_ASSETS. No transaction was broadcast.",
    deploymentId,
  };
}

export async function rollbackDeployment(
  deploymentId: string,
): Promise<DeploymentActionResult> {
  const deployment = findDeployment(deploymentId);
  if (deployment.state !== "LIVE") {
    return {
      ok: false,
      message: `A rollback can only be requested from LIVE; this deployment is ${deployment.state}.`,
      deploymentId,
    };
  }
  const release = store.releases.find(
    (candidate) => candidate.projectId === deployment.projectId && candidate.isCurrent,
  );
  if (release === undefined) {
    return { ok: false, message: "No current release is available to roll back to.", deploymentId };
  }
  const sequence = String(store.deployments.length + 1).padStart(12, "0");
  const now = nowIso();
  const rollback: DeploymentSummary = {
    ...deployment,
    id: `dddddddd-dddd-4ddd-8ddd-${sequence}`,
    triggerKind: "rollback",
    commitSha: release.commitSha,
    state: "AWAITING_APPROVAL",
    stateVersion: 0,
    releaseId: release.releaseId,
    manifestSha256: release.manifestSha256,
    releaseVerified: true,
    errorCode: null,
    errorMessage: null,
    approvedCostCapWei: null,
    estimatedCostWei: null,
    requestedAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  };
  store.deployments.push(rollback);
  appendEvent({
    deploymentId: rollback.id,
    oldState: null,
    newState: "AWAITING_APPROVAL",
    eventType: "deployment.created",
    actorKind: "user",
    actorId: "demo-user",
    payload: {
      demo: true,
      note: `rollback of ${deployment.id} to release ${release.releaseId}`,
    },
  });
  return {
    ok: true,
    message: `Rollback deployment created in AWAITING_APPROVAL (demo). It still needs approval and execution.`,
    deploymentId: rollback.id,
  };
}

// ---------------------------------------------------------------------------
// Resource discovery (`/v1/resources/*`) — read-only fixtures
// ---------------------------------------------------------------------------

export async function listResourceProcessors(): Promise<ProcessorCatalogue> {
  return mockData.MOCK_RESOURCE_CATALOGUE;
}

/**
 * Mock mintable processors.
 *
 * Deliberately includes **two** processors at different prices and **excludes** a sold-out one:
 * the screen's whole job is to make the choice visible, so a single-entry fixture would let the
 * "cheapest first" and "sold out is not offered" behaviours regress unnoticed.
 */
export async function listMintableProcessors(input?: {
  readonly take?: number;
}): Promise<MintableProcessorList> {
  // A deterministic spread that looks like the real catalogue: 398 processors exist and 357
  // have stock, with prices varying by more than an order of magnitude. Two fixtures made the
  // chooser look empty and hid the fact that this is a comparison over many options.
  const base = [
    { cpuIndex: 12, mintWei: 6_000_000_000_000n, left: "99819", nextId: "4" },
    { cpuIndex: 2, mintWei: 10_000_000_000_000_000n, left: "99819", nextId: "25" },
    { cpuIndex: 31, mintWei: 1_500_000_000_000_000n, left: "98540", nextId: "61" },
    { cpuIndex: 7, mintWei: 900_000_000_000_000n, left: "99967", nextId: "12" },
    { cpuIndex: 18, mintWei: 2_400_000_000_000_000n, left: "94120", nextId: "38" },
    { cpuIndex: 44, mintWei: 5_000_000_000_000_000n, left: "88004", nextId: "9" },
    { cpuIndex: 5, mintWei: 1_000_000_000_000_000n, left: "62631", nextId: "13" },
    { cpuIndex: 63, mintWei: 700_000_000_000_000n, left: "99711", nextId: "3" },
    { cpuIndex: 88, mintWei: 3_200_000_000_000_000n, left: "91230", nextId: "77" },
    { cpuIndex: 101, mintWei: 2_000_000_000_000_000n, left: "99500", nextId: "18" },
    { cpuIndex: 120, mintWei: 8_000_000_000_000_000n, left: "86010", nextId: "5" },
    { cpuIndex: 144, mintWei: 1_200_000_000_000_000n, left: "99880", nextId: "31" },
    { cpuIndex: 156, mintWei: 4_500_000_000_000_000n, left: "90240", nextId: "2" },
    { cpuIndex: 172, mintWei: 2_800_000_000_000_000n, left: "97003", nextId: "44" },
    { cpuIndex: 188, mintWei: 950_000_000_000_000n, left: "99920", nextId: "8" },
    { cpuIndex: 203, mintWei: 6_600_000_000_000_000n, left: "84120", nextId: "15" },
    { cpuIndex: 219, mintWei: 1_800_000_000_000_000n, left: "98771", nextId: "26" },
    { cpuIndex: 233, mintWei: 3_900_000_000_000_000n, left: "91405", nextId: "7" },
    { cpuIndex: 248, mintWei: 1_100_000_000_000_000n, left: "99660", nextId: "19" },
    { cpuIndex: 262, mintWei: 5_400_000_000_000_000n, left: "89002", nextId: "11" },
    { cpuIndex: 277, mintWei: 2_200_000_000_000_000n, left: "96840", nextId: "33" },
    { cpuIndex: 291, mintWei: 4_100_000_000_000_000n, left: "92511", nextId: "6" },
    { cpuIndex: 306, mintWei: 1_350_000_000_000_000n, left: "99780", nextId: "22" },
    { cpuIndex: 320, mintWei: 7_200_000_000_000_000n, left: "87330", nextId: "4" },
  ] as const;
  const protocolFeeWei = 660_000_000_000_000n;
  const tapeoutFeeWei = 1_300_000_000_000_000n;
  const processors: MintableProcessor[] = base
    .map((entry) => {
      const mintCostWei = entry.mintWei + protocolFeeWei;
      return {
        cpuIndex: entry.cpuIndex,
        processor: `0x${entry.cpuIndex.toString(16).padStart(4, "0")}${"a1b2c3d4e5f6".repeat(3)}`.slice(0, 42),
        transistors: `0x${entry.cpuIndex.toString(16).padStart(4, "0")}${"9f8e7d6c5b4a".repeat(3)}`.slice(0, 42),
        available: entry.left,
        mintPriceWei: entry.mintWei.toString(10),
        protocolFeeWei: protocolFeeWei.toString(10),
        tapeoutFeeWei: tapeoutFeeWei.toString(10),
        mintCostWei: mintCostWei.toString(10),
        totalBeforeOpenWei: (mintCostWei + tapeoutFeeWei).toString(10),
        nextId: entry.nextId,
      } satisfies MintableProcessor;
    })
    .sort((left, right) =>
      BigInt(left.totalBeforeOpenWei) === BigInt(right.totalBeforeOpenWei)
        ? left.cpuIndex - right.cpuIndex
        : BigInt(left.totalBeforeOpenWei) < BigInt(right.totalBeforeOpenWei)
          ? -1
          : 1,
    );
  return {
    chainId: 196,
    processors: input?.take === undefined ? processors : processors.slice(0, input.take),
    examined: 60,
    soldOut: 3,
    observedBlock: "74424410",
    syncStatus: "verified",
  };
}

export async function createSelfMintQuote(cpuIndex: number): Promise<SelfMintQuote> {
  const listed = await listMintableProcessors();
  const chosen =
    listed.processors.find((entry) => entry.cpuIndex === cpuIndex) ?? listed.processors[0];
  if (chosen === undefined) throw new Error("mock: no mintable processor");
  const openerFeeWei = "80000000000000000";
  return {
    sourceId: "builtin:self-mint",
    chainId: 196,
    processor: {
      cpuIndex: chosen.cpuIndex,
      address: chosen.processor,
      transistors: chosen.transistors,
      available: chosen.available,
    },
    steps: [
      { kind: "mint", to: chosen.transistors, data: "0x", valueWei: chosen.mintCostWei, functionName: "mint" },
      { kind: "tapeout", to: chosen.processor, data: "0x", valueWei: chosen.tapeoutFeeWei, functionName: "tapeout" },
    ],
    prices: {
      mintCostWei: chosen.mintCostWei,
      tapeoutFeeWei: chosen.tapeoutFeeWei,
      openerFeeWei,
      totalWei: (BigInt(chosen.mintCostWei) + BigInt(chosen.tapeoutFeeWei) + BigInt(openerFeeWei)).toString(10),
    },
    observedBlock: "74424410",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    openQuotedSeparately: true,
    predictedTokenId: (BigInt(chosen.nextId) + 1n).toString(10),
    termsVersion: "self-mint-v1",
  };
}

/**
 * The fixtures deliberately ignore `cursor`: there is one page per state, so a
 * crafted cursor cannot manufacture a second page. `nextCursor` stays null and the
 * page therefore renders no "next page" control.
 */
export async function getWalletResourcePage(
  address: string,
  _cursor: string | null,
): Promise<WalletResourcePage> {
  return mockData.mockWalletResourcePageFor(validateResourceAddress(address));
}

export async function inspectResource(processor: string, tokenId: string): Promise<WalletResource> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(processor)) {
    throw new ApiError("processor must be a 20-byte hex address", {
      status: 400,
      code: "INVALID_BODY",
      retryable: false,
      requestId: null,
    });
  }
  if (!/^(0|[1-9][0-9]*)$/.test(tokenId)) {
    throw new ApiError("tokenId must be a base-10 integer string", {
      status: 400,
      code: "INVALID_BODY",
      retryable: false,
      requestId: null,
    });
  }
  return mockData.mockResourceInspection(processor.toLowerCase() as `0x${string}`, tokenId);
}

function validateResourceAddress(address: string): `0x${string}` {
  const normalized = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new ApiError("wallet address must be 0x + 40 hex characters", {
      status: 400,
      code: "INVALID_PATH",
      retryable: false,
      requestId: null,
    });
  }
  return normalized as `0x${string}`;
}
