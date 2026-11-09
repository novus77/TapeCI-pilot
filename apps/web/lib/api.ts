import { cookies } from "next/headers";

import type { DeploymentActionCapabilities, DeploymentActionResult } from "./action-types";
import { bindingState, parseBindMonths, validateBindName } from "./binding";
import { ApiError, apiErrorFromBody, isNotFound } from "./errors";
import * as mock from "./mock";
import { isDeploymentState } from "./states";
import type {
  AuditEventRow,
  BindRequestInput,
  BindResult,
  BindSubmission,
  BindSubmissionInput,
  ContainerBindingStatus,
  NotificationRow,
  ProjectMember,
  ReleaseComparison,
  WebhookDeliveryRow,
  ApprovalTypedData,
  ChainTransaction,
  ContainerDetail,
  GithubInstallationSummary,
  GithubRepositorySummary,
  CreateProjectInput,
  DeploymentDetail,
  DeploymentPreparation,
  PreparationCost,
  ReleasePreparationRequest,
  DeploymentEvent,
  DeploymentFilter,
  DeploymentPlan,
  DeploymentState,
  DeploymentSummary,
  Hex,
  OperatorSession,
  Project,
  Release,
  ReleaseFile,
  VerificationReport,
  PublicationSummary,
  PreparationQuote,
  PreparationTask,
  PreparedStepAction,
} from "./types";

/**
 * Server-side typed client for the P2 API (`docs/P2_API.md`).
 *
 * This module is imported by Server Components and Server Actions only; it uses
 * `next/headers` to forward the session cookie and must never be imported from a
 * client component. In mock mode it delegates to deterministic in-memory
 * fixtures instead of touching the network.
 *
 * The route table does not pin response envelopes, so the adapters below match
 * the API implementation in `apps/api/src/routes` (`{ project }`, `{ projects }`,
 * `{ deployments }`, `{ verifyReport }`, …) and project them into the UI types.
 */

const DEFAULT_API_URL = "http://127.0.0.1:8787";

export function isMockMode(): boolean {
  return process.env.NEXT_PUBLIC_TAPECI_MOCK === "1" || process.env.TAPECI_MOCK === "1";
}

export function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? process.env.TAPECI_API_URL ?? DEFAULT_API_URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(label: string): ApiError {
  return new ApiError(`The TapeCI API returned an unexpected ${label} payload.`, {
    status: 502,
    code: "INVALID_API_RESPONSE",
    retryable: false,
    requestId: null,
  });
}

async function requestCookieHeader(): Promise<string | null> {
  try {
    const store = await cookies();
    const value = store.toString();
    return value.length > 0 ? value : null;
  } catch {
    // Server actions invoked outside a request scope (or build-time rendering)
    // simply call the API without a session cookie.
    return null;
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const baseUrl = apiBaseUrl();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const cookie = await requestCookieHeader();
  if (cookie !== null) headers.set("cookie", cookie);
  // Dev-only bridge: the current API resolves TAPECI_DEV_AUTH=1 users from these
  // headers per request (docs/P2_API.md describes a session cookie instead).
  // Never set these in a production deployment.
  const devLogin = process.env.TAPECI_DEV_GITHUB_LOGIN;
  if (devLogin !== undefined && devLogin.length > 0) {
    headers.set("x-tapeci-github-login", devLogin);
  }
  const devUserId = process.env.TAPECI_DEV_GITHUB_USER_ID;
  if (devUserId !== undefined && devUserId.length > 0) {
    headers.set("x-tapeci-github-user-id", devUserId);
  }

  let response: Response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch (error) {
    throw new ApiError(`The TapeCI API at ${baseUrl} is unreachable.`, {
      status: 0,
      code: "API_UNREACHABLE",
      retryable: true,
      requestId: null,
      details: error instanceof Error ? error.message : undefined,
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    throw apiErrorFromBody(response.status, body, response.headers.get("x-request-id"));
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Raw API DTOs (apps/api/src/routes)
// ---------------------------------------------------------------------------

interface RawProjectContainer {
  readonly id: string;
  readonly address: string;
  readonly processorIndex: number;
  readonly processor: string;
  readonly tokenId: string;
  readonly factory: string;
  readonly opener: string;
  readonly registry: string;
  readonly binding: string;
  readonly owner: string | null;
}

interface RawProject {
  readonly id: string;
  readonly organizationId?: string | null;
  readonly githubRepositoryId: number;
  readonly repoFullName: string;
  readonly defaultBranch: string;
  readonly buildCommand: string;
  readonly installCommand: string;
  readonly outputDirectory: string;
  readonly strictDewebMode: boolean;
  readonly isArchived: boolean;
  readonly createdAt: string;
  readonly container: RawProjectContainer;
}

interface RawReleaseFile {
  readonly id: string;
  readonly deploymentId: string;
  readonly targetPath: string;
  readonly sourceRelativePath: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly chunkCount: number;
  readonly contentType: string;
  readonly state: string;
  readonly lastConfirmedChunkIndex: number;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawChainTransaction {
  readonly id: string;
  readonly deploymentId: string;
  readonly releaseFileId: string | null;
  readonly chainId: number;
  readonly signerAddress: string;
  readonly toAddress: string;
  readonly operation: string;
  readonly operationFingerprint: string;
  readonly nonce: string | null;
  readonly gasLimit: string | null;
  readonly gasUsed: string | null;
  readonly effectiveGasPriceWei: string | null;
  readonly txHash: string | null;
  readonly state: string;
  readonly receiptBlockNumber: string | null;
  readonly receiptBlockHash: string | null;
  readonly replacementFor: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RawDeployment {
  readonly id: string;
  readonly projectId: string;
  readonly containerId: string;
  readonly triggerKind: string;
  readonly commitSha: string;
  readonly state: string;
  readonly stateVersion: number;
  readonly artifactSha256: string | null;
  readonly manifestSha256: string | null;
  readonly estimatedCostWei: string | null;
  readonly approvedCostCapWei: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly releaseFiles?: readonly RawReleaseFile[];
  readonly chainTransactions?: readonly RawChainTransaction[];
}

interface RawEvent {
  readonly id: string | number;
  readonly oldState: string | null;
  readonly newState: string | null;
  readonly eventType: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly payload?: unknown;
  readonly createdAt: string;
}

interface RawRelease {
  readonly id: string;
  readonly releaseId: string;
  readonly commitSha: string;
  readonly manifestSha256: string;
  readonly entrySha256: string;
  readonly entryPath: string;
  readonly verifiedBlockNumber: string;
  readonly activatedAt: string;
  readonly isCurrent: boolean;
}

interface RawContainerSession {
  readonly id: string;
  readonly signerAddress: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

interface RawContainer {
  readonly id: string;
  readonly address: string;
  readonly chainId: number;
  readonly factory: string;
  readonly opener: string;
  readonly registry: string;
  readonly binding: string;
  readonly processorIndex: number;
  readonly processor: string;
  readonly tokenId: string;
  readonly owner: string;
  readonly opened: boolean;
  readonly lastCheckedBlock: string | number | null;
  readonly operatorSessions: readonly RawContainerSession[];
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

function requireAddress(value: unknown, label: string): Hex {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value as Hex;
  throw invalidResponse(label);
}

function optionalHash(value: unknown): Hex | null {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) return value as Hex;
  return null;
}

function requireHash(value: unknown, label: string): Hex {
  const hash = optionalHash(value);
  if (hash === null) throw invalidResponse(label);
  return hash;
}

function asDeploymentState(value: unknown): DeploymentState {
  if (isDeploymentState(value)) return value;
  throw invalidResponse("deployment state");
}

function asNullableState(value: unknown): DeploymentState | null {
  if (value === null) return null;
  return asDeploymentState(value);
}

function asProject(raw: RawProject): Project {
  return {
    id: raw.id,
    repoFullName: raw.repoFullName,
    defaultBranch: raw.defaultBranch,
    buildCommand: raw.buildCommand,
    installCommand: raw.installCommand,
    outputDirectory: raw.outputDirectory,
    strictDewebMode: raw.strictDewebMode,
    isArchived: raw.isArchived,
    ...(raw.organizationId === undefined ? {} : { organizationId: raw.organizationId }),
    container: {
      address: requireAddress(raw.container.address, "container address"),
      chainId: 196,
      ownerAddress:
        raw.container.owner === null
          ? null
          : requireAddress(raw.container.owner, "container owner"),
      registryAddress: requireAddress(raw.container.registry, "registry address"),
      // GET /v1/projects does not expose the opened flag; do not guess.
      opened: null,
    },
    // GET /v1/projects does not expose installations; omit instead of claiming none.
    createdAt: raw.createdAt,
    updatedAt: raw.createdAt,
  };
}

function asDeployment(
  raw: RawDeployment,
  project: DeploymentSummary["project"],
  containerAddress: Hex | null,
): DeploymentSummary {
  return {
    id: raw.id,
    projectId: raw.projectId,
    project,
    containerId: raw.containerId,
    containerAddress,
    triggerKind: raw.triggerKind,
    commitSha: raw.commitSha,
    state: asDeploymentState(raw.state),
    stateVersion: raw.stateVersion,
    targetChainId: 196,
    registryAddress: null,
    artifactSha256: optionalHash(raw.artifactSha256),
    manifestSha256: optionalHash(raw.manifestSha256),
    releaseId: null,
    entryPath: null,
    errorCode: raw.errorCode,
    errorMessage: raw.errorMessage,
    approvedCostCapWei: raw.approvedCostCapWei,
    estimatedCostWei: raw.estimatedCostWei,
    requestedAt: raw.requestedAt,
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    updatedAt: raw.finishedAt ?? raw.startedAt ?? raw.requestedAt,
  };
}

function asEvent(raw: RawEvent, deploymentId: string): DeploymentEvent {
  return {
    id: String(raw.id),
    deploymentId,
    oldState: asNullableState(raw.oldState),
    newState: asNullableState(raw.newState),
    eventType: raw.eventType,
    actorKind:
      raw.actorKind === "user" || raw.actorKind === "worker" || raw.actorKind === "webhook"
        ? raw.actorKind
        : "system",
    actorId: raw.actorId,
    payload: isRecord(raw.payload) ? raw.payload : {},
    createdAt: raw.createdAt,
  };
}

function asRelease(raw: RawRelease): Release {
  return {
    id: raw.id,
    releaseId: raw.releaseId,
    commitSha: raw.commitSha,
    manifestSha256: requireHash(raw.manifestSha256, "release manifest hash"),
    entrySha256: requireHash(raw.entrySha256, "release entry hash"),
    entryPath: raw.entryPath,
    verifiedBlockNumber: String(raw.verifiedBlockNumber),
    activatedAt: raw.activatedAt,
    isCurrent: raw.isCurrent,
  };
}

function asSession(raw: RawContainerSession): OperatorSession {
  return {
    id: raw.id,
    signerAddress: requireAddress(raw.signerAddress, "operator signer"),
    approvalId: null,
    expiresAt: raw.expiresAt,
    revokedAt: raw.revokedAt,
    createdAt: null,
  };
}

function asContainer(raw: RawContainer): ContainerDetail {
  const owner = requireAddress(raw.owner, "container owner");
  return {
    id: raw.id,
    chainId: raw.chainId,
    address: requireAddress(raw.address, "container address"),
    ownerAddress: owner,
    factoryAddress: requireAddress(raw.factory, "factory address"),
    processorIndex: raw.processorIndex,
    processorAddress: requireAddress(raw.processor, "processor address"),
    tokenId: String(raw.tokenId),
    openerAddress: requireAddress(raw.opener, "opener address"),
    registryAddress: requireAddress(raw.registry, "registry address"),
    bindingAddress: requireAddress(raw.binding, "binding address"),
    opened: raw.opened,
    openedAt: null,
    lastCheckedBlock:
      raw.lastCheckedBlock === null || raw.lastCheckedBlock === undefined
        ? "unknown"
        : String(raw.lastCheckedBlock),
    lastObservedOwner: owner,
    lastRegistryImpl: null,
    lastBindingImpl: null,
    operatorSessions: raw.operatorSessions.map(asSession),
  };
}

function asPlan(value: unknown): DeploymentPlan {
  if (!isRecord(value) || !isRecord(value["totals"]) || !isRecord(value["fees"])) {
    throw invalidResponse("plan");
  }
  return value as unknown as DeploymentPlan;
}

function asVerification(value: unknown): VerificationReport {
  if (!isRecord(value) || typeof value["releaseMatch"] !== "boolean") {
    throw invalidResponse("verification report");
  }
  return value as unknown as VerificationReport;
}

function projectRef(project: Project): NonNullable<DeploymentSummary["project"]> {
  return {
    id: project.id,
    repoFullName: project.repoFullName,
    defaultBranch: project.defaultBranch,
  };
}

function projectIndex(
  projects: readonly Project[],
): ReadonlyMap<
  string,
  { readonly ref: NonNullable<DeploymentSummary["project"]>; readonly address: Hex }
> {
  const index = new Map<
    string,
    { readonly ref: NonNullable<DeploymentSummary["project"]>; readonly address: Hex }
  >();
  for (const project of projects) {
    index.set(project.id, { ref: projectRef(project), address: project.container.address });
  }
  return index;
}

function isNotReady(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "PLAN_NOT_READY" || error.code === "VERIFICATION_NOT_READY")
  );
}

// ---------------------------------------------------------------------------
// Public client
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<readonly Project[]> {
  if (isMockMode()) return mock.listProjects();
  const response = await apiFetch<{ projects: RawProject[] }>("/v1/projects");
  return response.projects.map(asProject);
}

export async function getProject(projectId: string): Promise<Project> {
  if (isMockMode()) return mock.getProject(projectId);
  const response = await apiFetch<{ project: RawProject }>(
    `/v1/projects/${encodeURIComponent(projectId)}`,
  );
  return asProject(response.project);
}

/**
 * SPEC §12.4 publication summary. Read-only and derived server-side: the client sends
 * only the project id, so it cannot influence which URL is probed.
 */
/**
 * SPEC §7.2: price an `open` step for an existing circuit.
 *
 * The request carries only the asset key — the container, the fee and the block are all
 * server-derived, so nothing here can choose what gets priced.
 */
export async function createResourceQuote(input: {
  readonly processor: string;
  readonly tokenId: string;
  readonly recipient: string;
}): Promise<PreparationQuote> {
  if (isMockMode()) return mock.createResourceQuote(input);
  const response = await apiFetch<{ quote: PreparationQuote }>("/v1/resource-quotes", {
    method: "POST",
    body: JSON.stringify({
      chainId: 196,
      processor: input.processor,
      tokenId: input.tokenId,
      recipient: input.recipient,
    }),
  });
  return response.quote;
}

/** SPEC §7.3: accept a quote and open a preparation task. Idempotent per request digest. */
export async function createPreparation(input: {
  readonly quoteId: string;
  readonly idempotencyKey: string;
}): Promise<PreparationTask> {
  if (isMockMode()) return mock.createPreparation(input);
  const response = await apiFetch<{ task: PreparationTask }>("/v1/preparations", {
    method: "POST",
    headers: { "idempotency-key": input.idempotencyKey },
    body: JSON.stringify({ quoteId: input.quoteId }),
  });
  return response.task;
}

export async function getPreparation(taskId: string): Promise<PreparationTask> {
  if (isMockMode()) return mock.getPreparation(taskId);
  const response = await apiFetch<{ task: PreparationTask }>(
    `/v1/preparations/${encodeURIComponent(taskId)}`,
  );
  return response.task;
}

/**
 * SPEC §7.3: run the pre-flight and save the intent. Repeating this returns the SAME
 * `intentId` and the same calldata — it never mints a second intent.
 */
export async function prepareStep(input: {
  readonly taskId: string;
  readonly stepId: string;
  readonly expectedVersion: number;
}): Promise<PreparedStepAction> {
  if (isMockMode()) return mock.prepareStep(input);
  return apiFetch<PreparedStepAction>(
    `/v1/preparations/${encodeURIComponent(input.taskId)}/steps/${encodeURIComponent(input.stepId)}/prepare`,
    { method: "POST", body: JSON.stringify({ expectedVersion: input.expectedVersion }) },
  );
}

/** Register a hash the wallet returned. 202 means recorded, never "confirmed". */
export async function recordStepTransaction(input: {
  readonly taskId: string;
  readonly stepId: string;
  readonly intentId: string;
  readonly txHash: string;
  readonly expectedVersion: number;
}): Promise<PreparationTask> {
  if (isMockMode()) return mock.recordStepTransaction(input);
  const response = await apiFetch<{ task: PreparationTask }>(
    `/v1/preparations/${encodeURIComponent(input.taskId)}/steps/${encodeURIComponent(input.stepId)}/transactions`,
    {
      method: "POST",
      body: JSON.stringify({
        intentId: input.intentId,
        txHash: input.txHash,
        expectedVersion: input.expectedVersion,
      }),
    },
  );
  return response.task;
}

/** Ask the server to re-check an attempt. Synchronous, and its result is not a confirmation. */
export async function reconcilePreparation(input: {
  readonly taskId: string;
  readonly expectedVersion: number;
}): Promise<PreparationTask> {
  if (isMockMode()) return mock.reconcilePreparation(input);
  const response = await apiFetch<{ task: PreparationTask }>(
    `/v1/preparations/${encodeURIComponent(input.taskId)}/reconcile`,
    { method: "POST", body: JSON.stringify({ expectedVersion: input.expectedVersion }) },
  );
  return response.task;
}

export async function getProjectPublication(projectId: string): Promise<PublicationSummary> {
  if (isMockMode()) return mock.getProjectPublication(projectId);
  return apiFetch<PublicationSummary>(`/v1/projects/${encodeURIComponent(projectId)}/publication`);
}

export async function listProjectReleases(projectId: string): Promise<readonly Release[]> {
  if (isMockMode()) return mock.listProjectReleases(projectId);
  const response = await apiFetch<{ releases: RawRelease[] }>(
    `/v1/projects/${encodeURIComponent(projectId)}/releases`,
  );
  return response.releases.map(asRelease);
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  if (isMockMode()) return mock.createProject(input);
  const response = await apiFetch<{ project: RawProject }>("/v1/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return asProject(response.project);
}

export interface DeploymentPage {
  readonly deployments: readonly DeploymentSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

/**
 * Paged deployment list. The server returns the real total, so the pager can
 * describe the whole result set rather than the page it received.
 */
export async function listDeploymentPage(
  filter: DeploymentFilter & {
    readonly page?: number;
    readonly pageSize?: number;
    readonly sort?: "requestedAt" | "state" | "project";
    readonly dir?: "asc" | "desc";
  } = {},
): Promise<DeploymentPage> {
  if (isMockMode()) {
    const pageSize = filter.pageSize ?? filter.limit ?? 50;
    const page = filter.page ?? 1;
    // Ask the mock for the WHOLE filtered set (no limit) so `total` is the real
    // count; passing `limit` here would make every result look like a single page.
    const all = await mock.listDeployments({
      projectId: filter.projectId,
      state: filter.state,
      sort: filter.sort,
      dir: filter.dir,
    });
    const start = (page - 1) * pageSize;
    return {
      deployments: all.slice(start, start + pageSize),
      page,
      pageSize,
      total: all.length,
      totalPages: Math.max(Math.ceil(all.length / pageSize), 1),
    };
  }
  const search = new URLSearchParams();
  if (filter.projectId !== undefined) search.set("projectId", filter.projectId);
  if (filter.state !== undefined) search.set("state", filter.state);
  if (filter.limit !== undefined) search.set("limit", String(filter.limit));
  if (filter.pageSize !== undefined) search.set("pageSize", String(filter.pageSize));
  if (filter.page !== undefined) search.set("page", String(filter.page));
  if (filter.sort !== undefined) search.set("sort", filter.sort);
  if (filter.dir !== undefined) search.set("dir", filter.dir);
  const query = search.toString();
  const [response, projects] = await Promise.all([
    apiFetch<{
      deployments: RawDeployment[];
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    }>(`/v1/deployments${query.length > 0 ? `?${query}` : ""}`),
    listProjects().catch((): readonly Project[] => []),
  ]);
  const index = projectIndex(projects);
  return {
    deployments: response.deployments.map((raw) => {
      const project = index.get(raw.projectId);
      return asDeployment(raw, project?.ref ?? null, project?.address ?? null);
    }),
    page: response.page,
    pageSize: response.pageSize,
    total: response.total,
    totalPages: response.totalPages,
  };
}

export async function listDeployments(
  filter: DeploymentFilter = {},
): Promise<readonly DeploymentSummary[]> {
  if (isMockMode()) return mock.listDeployments(filter);
  const search = new URLSearchParams();
  if (filter.projectId !== undefined) search.set("projectId", filter.projectId);
  if (filter.state !== undefined) search.set("state", filter.state);
  if (filter.limit !== undefined) search.set("limit", String(filter.limit));
  const query = search.toString();
  const [response, projects] = await Promise.all([
    apiFetch<{ deployments: RawDeployment[] }>(
      `/v1/deployments${query.length > 0 ? `?${query}` : ""}`,
    ),
    // The deployment DTO does not join the project; enrich it for the table.
    listProjects().catch((): readonly Project[] => []),
  ]);
  const index = projectIndex(projects);
  return response.deployments.map((raw) => {
    const project = index.get(raw.projectId);
    return asDeployment(raw, project?.ref ?? null, project?.address ?? null);
  });
}

export async function getDeployment(deploymentId: string): Promise<DeploymentDetail> {
  if (isMockMode()) return mock.getDeployment(deploymentId);
  const response = await apiFetch<{ deployment: RawDeployment }>(
    `/v1/deployments/${encodeURIComponent(deploymentId)}`,
  );
  const projects = await listProjects().catch((): readonly Project[] => []);
  const project = projects.find((candidate) => candidate.id === response.deployment.projectId);
  const mapped = asDeployment(
    response.deployment,
    project === undefined ? null : projectRef(project),
    project?.container.address ?? null,
  );
  return {
    ...mapped,
    ...(response.deployment.releaseFiles === undefined
      ? {}
      : {
          releaseFiles: response.deployment.releaseFiles.map((file) => ({
            ...file,
            sha256: requireHash(file.sha256, "release file sha256"),
            state: file.state as ReleaseFile["state"],
          })),
        }),
    ...(response.deployment.chainTransactions === undefined
      ? {}
      : {
          transactions: response.deployment.chainTransactions.map((transaction) => ({
            ...transaction,
            signerAddress: requireAddress(transaction.signerAddress, "transaction signer"),
            toAddress: requireAddress(transaction.toAddress, "transaction to"),
            operationFingerprint: requireHash(
              transaction.operationFingerprint,
              "operation fingerprint",
            ),
            txHash:
              transaction.txHash === null
                ? null
                : requireHash(transaction.txHash, "transaction hash"),
            receiptBlockHash:
              transaction.receiptBlockHash === null
                ? null
                : requireHash(transaction.receiptBlockHash, "receipt block hash"),
            state: transaction.state as ChainTransaction["state"],
          })),
        }),
  };
}

export async function listDeploymentEvents(
  deploymentId: string,
): Promise<readonly DeploymentEvent[]> {
  if (isMockMode()) return mock.listDeploymentEvents(deploymentId);
  const response = await apiFetch<{ events: RawEvent[] }>(
    `/v1/deployments/${encodeURIComponent(deploymentId)}/events`,
  );
  return response.events.map((event) => asEvent(event, deploymentId));
}

export async function getDeploymentPlan(
  deploymentId: string,
): Promise<DeploymentPlan | null> {
  if (isMockMode()) return mock.getDeploymentPlan(deploymentId);
  try {
    const response = await apiFetch<{ deploymentId: string; plan: unknown }>(
      `/v1/deployments/${encodeURIComponent(deploymentId)}/plan`,
    );
    return asPlan(response.plan);
  } catch (error) {
    if (isNotFound(error) || isNotReady(error)) return null;
    throw error;
  }
}

export async function getVerificationReport(
  deploymentId: string,
): Promise<VerificationReport | null> {
  if (isMockMode()) return mock.getVerificationReport(deploymentId);
  try {
    const response = await apiFetch<{ verifyReport: unknown }>(
      `/v1/deployments/${encodeURIComponent(deploymentId)}/verification`,
    );
    return asVerification(response.verifyReport);
  } catch (error) {
    if (isNotFound(error) || isNotReady(error)) return null;
    throw error;
  }
}

export async function getContainer(containerAddress: string): Promise<ContainerDetail> {
  if (isMockMode()) return mock.getContainer(containerAddress);
  const response = await apiFetch<{ container: RawContainer }>(
    `/v1/containers/${encodeURIComponent(containerAddress)}`,
  );
  return asContainer(response.container);
}

interface RawContainerBinding {
  readonly containerAddress?: unknown;
  readonly bindingAddress?: unknown;
  readonly name?: unknown;
  readonly suggestedName?: unknown;
  readonly state?: unknown;
  readonly isLive?: unknown;
  readonly isContainerLive?: unknown;
  readonly paidUntil?: unknown;
  readonly monthlyFeeWei?: unknown;
  readonly canWrite?: unknown;
  readonly writeBlockedReason?: unknown;
  readonly nameRecorded?: unknown;
  readonly pendingSubmission?: unknown;
  readonly recentEvents?: unknown;
}

/**
 * One recorded bind attempt from the binding payload. Anything malformed is
 * dropped rather than guessed: a `pending` claim must be backed by a real hash,
 * and a confirmed one by a real block number.
 */
function asBindSubmission(value: unknown): BindSubmission | null {
  if (!isRecord(value)) return null;
  const txHash = optionalHash(value["txHash"]);
  if (txHash === null) return null;
  const state = value["state"] === "confirmed" ? "confirmed" : value["state"] === "pending" ? "pending" : null;
  if (state === null) return null;
  const name = typeof value["name"] === "string" ? value["name"] : null;
  if (name === null) return null;
  const months = typeof value["months"] === "number" && Number.isSafeInteger(value["months"]) ? value["months"] : null;
  if (months === null) return null;
  return {
    txHash,
    state,
    name,
    months,
    valueWei: optionalWei(value["valueWei"]) ?? "0",
    paidUntil: typeof value["paidUntil"] === "string" ? value["paidUntil"] : null,
    blockNumber: typeof value["blockNumber"] === "string" ? value["blockNumber"] : null,
    gasUsed: typeof value["gasUsed"] === "string" ? value["gasUsed"] : null,
    createdAt: typeof value["createdAt"] === "string" ? value["createdAt"] : "",
  };
}

function optionalWei(value: unknown): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/** A payload that carries none of the binding reads is not a binding response. */
function hasBindingFields(raw: RawContainerBinding): boolean {
  return (
    typeof raw.isLive === "boolean" ||
    typeof raw.isContainerLive === "boolean" ||
    typeof raw.state === "string" ||
    typeof raw.name === "string"
  );
}

function bindingStateOf(
  raw: RawContainerBinding,
  isLive: boolean,
  paidUntil: string | null,
): ContainerBindingStatus["state"] {
  // Trust an explicit enum from the API; otherwise derive it from the same reads
  // the gateway performs so the UI can never overstate activation.
  if (raw.state === "ACTIVE" || raw.state === "NOT_ACTIVATED" || raw.state === "EXPIRED") {
    return raw.state;
  }
  return bindingState({ isLive, paidUntil, nowSeconds: Math.floor(Date.now() / 1000) });
}

/**
 * `GET /v1/containers/:address/binding` (apps/api/src/routes/containers.ts).
 *
 * The route returns the contract fields at the top level and the same object under
 * `binding`; only the nested object is read, and the top-level fields are the
 * fallback if an older build omits it.
 *
 * Returns `null` when the route is missing (404 / 405 / 501) or the API is
 * unreachable: the container page then renders a neutral "status unavailable"
 * line rather than failing the whole page.
 */
export async function getContainerBinding(
  containerAddress: string,
  options: { readonly name?: string; readonly allowMock?: boolean } = {},
): Promise<ContainerBindingStatus | null> {
  if (isMockMode()) {
    if (options.allowMock === false) return null;
    return mock.getContainerBinding(containerAddress, options.name);
  }
  const search = new URLSearchParams();
  if (options.name !== undefined && options.name.length > 0) search.set("name", options.name);
  const query = search.toString();
  try {
    const response = await apiFetch<Record<string, unknown>>(
      `/v1/containers/${encodeURIComponent(containerAddress)}/binding${query.length > 0 ? `?${query}` : ""}`,
    );
    // Both shapes are answered: `binding` (what the console reads) and the same
    // contract fields at the top level.
    const nested = response["binding"];
    const raw: RawContainerBinding = isRecord(nested) ? nested : response;
    if (!hasBindingFields(raw)) return null;
    const isLive = raw.isLive === true;
    const paidUntil = typeof raw.paidUntil === "string" ? raw.paidUntil : null;
    const name = typeof raw.name === "string" ? raw.name : (options.name ?? "");
    const submissions = Array.isArray(raw.recentEvents)
      ? raw.recentEvents.map(asBindSubmission).filter((row): row is BindSubmission => row !== null)
      : [];
    const pending =
      asBindSubmission(raw.pendingSubmission) ??
      submissions.find((row) => row.state === "pending") ??
      null;
    return {
      containerAddress: requireAddress(raw.containerAddress, "binding container"),
      bindingAddress: requireAddress(raw.bindingAddress, "binding address"),
      name,
      suggestedName: typeof raw.suggestedName === "string" ? raw.suggestedName : name,
      nameRecorded: raw.nameRecorded === true,
      state: bindingStateOf(raw, isLive, paidUntil),
      isLive,
      isContainerLive: raw.isContainerLive === true,
      paidUntil,
      monthlyFeeWei: optionalWei(raw.monthlyFeeWei),
      canWrite: raw.canWrite === true,
      writeBlockedReason: typeof raw.writeBlockedReason === "string" ? raw.writeBlockedReason : null,
      pendingSubmission: pending,
      recentEvents: submissions,
    };
  } catch (error) {
    if (
      isNotFound(error) ||
      (error instanceof ApiError &&
        (error.status === 405 || error.status === 501 || error.code === "API_UNREACHABLE"))
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * `POST /v1/containers/:address/bind` — the operator path. The server action is
 * the only caller; the browser never holds the operator key.
 */
export async function bindContainer(
  containerAddress: string,
  input: BindRequestInput,
): Promise<BindResult> {
  if (isMockMode()) return mock.bindContainer(containerAddress, input);
  const nameError = validateBindName(input.name);
  if (nameError !== null) {
    return { ok: false, message: nameError, txHash: null, alreadyLive: false };
  }
  const months = parseBindMonths(input.months);
  if (months === null) {
    return { ok: false, message: "Months must be a whole number between 1 and 120.", txHash: null, alreadyLive: false };
  }
  let response: { txHash?: unknown; paidUntil?: unknown; valueWei?: unknown; state?: unknown };
  try {
    response = await apiFetch(`/v1/containers/${encodeURIComponent(containerAddress)}/bind`, {
      method: "POST",
      body: JSON.stringify({ name: input.name, months }),
    });
  } catch (error) {
    // ALREADY_LIVE is a 409 on the route, not a 200 flag: report it as success
    // because the outcome (the name is live) is what the caller asked for.
    if (error instanceof ApiError && error.code === "ALREADY_LIVE") {
      return {
        ok: true,
        message: error.message,
        txHash: null,
        alreadyLive: true,
      };
    }
    throw error;
  }
  const txHash = optionalHash(response.txHash);
  // `state` is the route's tracked state. A 202 (hash stored, receipt unknown)
  // is a real outcome, not a failure: `ok` stays true so the console can show
  // "pending" instead of telling the user to send a second transaction.
  const state = response.state === "pending" || response.state === "confirmed" ? response.state : undefined;
  return {
    ok: txHash !== null,
    message:
      txHash === null
        ? "The bind response carried no transaction hash."
        : state === "pending"
          ? `The operator broadcast bind(${input.name}, ${containerAddress}, ${String(months)}); its receipt is not known yet.`
          : `The operator sent bind(${input.name}, ${containerAddress}, ${String(months)}).`,
    txHash,
    alreadyLive: false,
    ...(state === undefined ? {} : { state }),
  };
}

/**
 * `POST /v1/containers/:address/bind/submissions` — register a hash the user's
 * own wallet broadcast (§3.3 / §9.4).
 *
 * The direct-wallet path signs in the browser, so without this call the bind
 * leaves no server record: the console could not show pending/confirmed and a
 * refresh would lose the attempt. Registration is never a confirmation — the
 * API reads the receipt itself and returns `pending` until it succeeds.
 */
export async function registerBindSubmission(
  containerAddress: string,
  input: BindSubmissionInput,
): Promise<BindResult> {
  const nameError = validateBindName(input.name);
  if (nameError !== null) {
    return { ok: false, message: nameError, txHash: null, alreadyLive: false };
  }
  const months = parseBindMonths(input.months);
  if (months === null) {
    return {
      ok: false,
      message: "Months must be a whole number between 1 and 120.",
      txHash: null,
      alreadyLive: false,
    };
  }
  const txHash = optionalHash(input.txHash);
  if (txHash === null) {
    return {
      ok: false,
      message: "A transaction hash is 0x followed by 64 hex characters.",
      txHash: null,
      alreadyLive: false,
    };
  }
  if (isMockMode()) {
    return {
      ok: true,
      message: "Demo mode recorded the hash locally. No transaction was broadcast and none was verified.",
      txHash,
      alreadyLive: false,
      state: "pending",
    };
  }
  const response = await apiFetch<{ state?: unknown; submission?: { state?: unknown } }>(
    `/v1/containers/${encodeURIComponent(containerAddress)}/bind/submissions`,
    {
      method: "POST",
      body: JSON.stringify({ name: input.name, months, txHash }),
    },
  );
  const rawState = response.state ?? response.submission?.state;
  const state = rawState === "pending" || rawState === "confirmed" ? rawState : "pending";
  return {
    ok: true,
    message:
      state === "confirmed"
        ? "The bind transaction is mined and the activation was re-read."
        : "The hash is recorded. The receipt is not known yet; re-check before doing anything else.",
    txHash,
    alreadyLive: false,
    state,
  };
}

/**
 * Capability probe for the action panels. The route table has no dedicated
 * capability endpoint, so the server derives it from the deployment state.
 */
/**
 * §12.3: ask the server to resume an interrupted attempt. A refusal is a normal answer
 * carrying the capability that explains it, not an exception to swallow.
 */
export async function requestDeploymentResume(
  deploymentId: string,
): Promise<{ readonly ok: boolean; readonly message: string; readonly deploymentId: string }> {
  if (isMockMode()) {
    return {
      ok: true,
      message: "Resume requested. The worker continues from the stored plan.",
      deploymentId,
    };
  }
  const body = await apiFetch<{ blocked: boolean; deploymentId?: string }>(
    `/v1/deployments/${encodeURIComponent(deploymentId)}/resume`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return {
    ok: !body.blocked,
    message: body.blocked
      ? "The server refused to resume this attempt."
      : "Resume requested. The worker continues from the stored plan.",
    deploymentId: body.deploymentId ?? deploymentId,
  };
}

/**
 * §12.2: request a fresh approval window. The response may name a *different*
 * deployment (a continuation attempt), which is the one that must be approved.
 */
export async function requestDeploymentReapproval(
  deploymentId: string,
): Promise<{ readonly ok: boolean; readonly message: string; readonly deploymentId: string }> {
  if (isMockMode()) {
    return {
      ok: true,
      message: "Reapproval opened. Sign the new payload for the same plan.",
      deploymentId,
    };
  }
  const body = await apiFetch<{ blocked: boolean; deploymentId?: string }>(
    `/v1/deployments/${encodeURIComponent(deploymentId)}/reapproval`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return {
    ok: !body.blocked,
    message: body.blocked
      ? "The server refused to reopen approval for this attempt."
      : "Reapproval opened. Sign the new payload for the same plan.",
    deploymentId: body.deploymentId ?? deploymentId,
  };
}

export async function getDeploymentActionCapabilities(
  deploymentId: string,
): Promise<DeploymentActionCapabilities> {
  if (isMockMode()) return mock.getDeploymentActionCapabilities(deploymentId);
  // §12.2/§12.3: the server owns the answer. Deriving it here from the state string is
  // what let the UI offer actions the API would refuse (AC-P6-17).
  const raw = await apiFetch<{
    canApprove: boolean;
    canExecute: boolean;
    canRollback: boolean;
    canResume: boolean;
    canReapprove: boolean;
    reasons: {
      approve: string | null;
      execute: string | null;
      rollback: string | null;
      resume: string | null;
      reapprove: string | null;
    };
    blockedReason: string | null;
  }>(`/v1/deployments/${encodeURIComponent(deploymentId)}/capabilities`);
  return {
    canApprove: raw.canApprove,
    canExecute: raw.canExecute,
    canRollback: raw.canRollback,
    canResume: raw.canResume,
    canReapprove: raw.canReapprove,
    reasons: raw.reasons,
    blockedReason: raw.blockedReason,
    demoMode: false,
    requiresSignature: true,
  };
}

export async function approveDeployment(
  deploymentId: string,
): Promise<DeploymentActionResult> {
  if (isMockMode()) return mock.approveDeployment(deploymentId);
  throw new ApiError(
    "Approval requires an EIP-712 wallet signature, which this console build cannot produce. Use the CLI.",
    {
      status: 501,
      code: "WALLET_SIGNING_UNAVAILABLE",
      retryable: false,
      requestId: null,
    },
  );
}

export async function executeDeployment(
  deploymentId: string,
): Promise<DeploymentActionResult> {
  if (isMockMode()) return mock.executeDeployment(deploymentId);
  await apiFetch<unknown>(`/v1/deployments/${encodeURIComponent(deploymentId)}/execute`, {
    method: "POST",
  });
  return {
    ok: true,
    message: "Execution queued. The worker state machine owns the next state transition.",
    deploymentId,
  };
}

export async function rollbackDeployment(
  deploymentId: string,
): Promise<DeploymentActionResult> {
  if (isMockMode()) return mock.rollbackDeployment(deploymentId);
  const deployment = await getDeployment(deploymentId);
  const releases = await listProjectReleases(deployment.projectId);
  const current = releases.find((release) => release.isCurrent) ?? releases[0];
  if (current === undefined) {
    return {
      ok: false,
      message: "No current release is available to roll back to.",
      deploymentId,
    };
  }
  // POST /v1/projects/:id/rollback expects the human release id (r-…), not the DB row id.
  const result = await apiFetch<{ deploymentId?: string; state?: DeploymentState }>(
    `/v1/projects/${encodeURIComponent(deployment.projectId)}/rollback`,
    {
      method: "POST",
      body: JSON.stringify({ releaseId: current.releaseId }),
    },
  );
  return {
    ok: true,
    message: "Rollback deployment created in AWAITING_APPROVAL.",
    deploymentId: result.deploymentId ?? null,
  };
}

export interface CurrentUser {
  readonly id: string;
  readonly githubLogin: string;
  readonly githubUserId: number;
  readonly isAdmin: boolean;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (isMockMode()) {
    return { id: "mock-user", githubLogin: "dev-user", githubUserId: 4242, isAdmin: false };
  }
  try {
    const response = await apiFetch<{ id: string; githubLogin: string; githubUserId: number; isAdmin?: boolean }>(
      "/v1/me",
    );
    return {
      id: response.id,
      githubLogin: response.githubLogin,
      githubUserId: response.githubUserId,
      isAdmin: response.isAdmin === true,
    };
  } catch {
    return null;
  }
}

export async function listGithubInstallations(): Promise<readonly GithubInstallationSummary[]> {
  if (isMockMode()) return [];
  const response = await apiFetch<{
    installations: Array<{
      id: string;
      installationId: number;
      accountLogin: string;
      suspended: boolean;
    }>;
  }>("/v1/github/installations");
  return response.installations.map((row) => ({
    id: row.id,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    suspended: row.suspended,
  }));
}

export async function listInstallationRepositories(
  installationId: string,
): Promise<readonly GithubRepositorySummary[]> {
  if (isMockMode()) return [];
  const response = await apiFetch<{
    repositories: Array<{
      id: number;
      fullName: string;
      defaultBranch: string;
      private: boolean;
      archived: boolean;
    }>;
  }>(`/v1/github/installations/${encodeURIComponent(installationId)}/repositories`);
  return response.repositories.map((row) => ({
    id: row.id,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    private: row.private,
    archived: row.archived,
  }));
}

export async function getApprovalPayload(deploymentId: string): Promise<ApprovalTypedData> {
  if (isMockMode()) return mock.getApprovalPayload(deploymentId);
  return apiFetch<ApprovalTypedData>(
    `/v1/deployments/${encodeURIComponent(deploymentId)}/approval-payload`,
  );
}

export async function approveDeploymentWithSignature(
  deploymentId: string,
  signerAddress: string,
  signature: string,
  approval: ApprovalTypedData["approval"],
): Promise<DeploymentActionResult> {
  if (isMockMode()) {
    return mock.approveDeploymentWithSignature(deploymentId, signerAddress, signature, approval);
  }
  await apiFetch<unknown>(`/v1/deployments/${encodeURIComponent(deploymentId)}/approve`, {
    method: "POST",
    body: JSON.stringify({ signerAddress, signature, approval }),
  });
  return {
    ok: true,
    message: "Approval recorded. The deployment can be executed from this console.",
    deploymentId,
  };
}

export async function listProjectMembers(projectId: string): Promise<{
  readonly members: readonly ProjectMember[];
  readonly canManage: boolean;
  readonly protectedUserId?: string;
}> {
  if (isMockMode()) {
    const organization = await mock.getOrganization("mock-managed-org");
    return {
      members: organization.members.map((member) => ({ ...member, avatarUrl: null,
        role: member.role === "admin" ? "maintainer" : member.role,
        source: member.role === "admin" ? "inherited" as const : "direct" as const,
        directRole: member.role === "admin" ? null : member.role })),
      canManage: true,
      protectedUserId: organization.members.find((member) => member.role === "owner")?.userId,
    };
  }
  return apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/members`);
}

export async function updateProjectSettings(
  projectId: string,
  input: {
    buildCommand?: string;
    installCommand?: string;
    outputDirectory?: string;
    isArchived?: boolean;
    organizationId?: string | null;
    pathMode?: "versioned" | "root";
  },
): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function addProjectMember(projectId: string, githubLogin: string, role: "owner" | "member"): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/members`, {
    method: "POST",
    body: JSON.stringify({ githubLogin, role }),
  });
}

export async function updateProjectMemberRole(projectId: string, userId: string, role: "owner" | "member"): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export async function listAuditEvents(
  filter: { limit?: number; status?: number; scope?: "self" | "all"; projectId?: string } = {},
): Promise<readonly AuditEventRow[]> {
  if (isMockMode()) return [];
  const search = new URLSearchParams();
  if (filter.limit !== undefined) search.set("limit", String(filter.limit));
  if (filter.status !== undefined) search.set("status", String(filter.status));
  if (filter.scope !== undefined) search.set("scope", filter.scope);
  if (filter.projectId !== undefined) search.set("projectId", filter.projectId);
  const response = await apiFetch<{ events: AuditEventRow[] }>(`/v1/audit?${search.toString()}`);
  return response.events;
}

export async function markNotificationsRead(deploymentIds: readonly string[] = []): Promise<number> {
  if (isMockMode()) return 0;
  const response = await apiFetch<{ marked: number }>("/v1/notifications/read", {
    method: "POST",
    body: JSON.stringify({ deploymentIds }),
  });
  return response.marked;
}

export async function listWebhookDeliveries(): Promise<readonly WebhookDeliveryRow[]> {
  if (isMockMode()) return [];
  const response = await apiFetch<{ deliveries: WebhookDeliveryRow[] }>("/v1/github/webhook-deliveries?limit=100");
  return response.deliveries;
}

export async function listNotifications(): Promise<readonly NotificationRow[]> {
  if (isMockMode()) return [];
  const response = await apiFetch<{ notifications: NotificationRow[] }>("/v1/notifications");
  return response.notifications;
}

export async function compareProjectReleases(
  projectId: string,
  base: string,
  target: string,
): Promise<ReleaseComparison> {
  if (isMockMode()) {
    return {
      base: { releaseId: base, commitSha: "", manifestSha256: "" },
      target: { releaseId: target, commitSha: "", manifestSha256: "" },
      changes: [],
    };
  }
  const search = new URLSearchParams({ base, target });
  return apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/releases/compare?${search.toString()}`);
}

export interface ProjectBudget {
  readonly monthlyCapWei: string | null;
  readonly spentThisMonthWei: string;
}

export async function getProjectBudget(projectId: string): Promise<ProjectBudget> {
  if (isMockMode()) return { monthlyCapWei: null, spentThisMonthWei: "0" };
  return apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/budget`);
}

export async function updateProjectBudget(projectId: string, monthlyCapWei: string | null): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/budget`, {
    method: "PATCH",
    body: JSON.stringify({ monthlyCapWei }),
  });
}

export interface ApprovalPolicy {
  readonly requiredRole: "owner" | "maintainer" | "member";
  readonly maxCostCapWei: string | null;
  readonly expiresInSeconds: number;
}

export async function getApprovalPolicy(projectId: string): Promise<ApprovalPolicy> {
  if (isMockMode()) return { requiredRole: "owner", maxCostCapWei: null, expiresInSeconds: 900 };
  return apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/approval-policy`);
}

export async function updateApprovalPolicy(projectId: string, policy: ApprovalPolicy): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/approval-policy`, {
    method: "PATCH",
    body: JSON.stringify(policy),
  });
}

export interface NotificationChannel {
  readonly id: string;
  readonly kind: "slack" | "email";
  readonly target: string;
  readonly enabled: boolean;
}

export async function listNotificationChannels(projectId: string): Promise<readonly NotificationChannel[]> {
  if (isMockMode()) return [];
  const response = await apiFetch<{ channels: NotificationChannel[] }>(`/v1/projects/${encodeURIComponent(projectId)}/notification-channels`);
  return response.channels;
}

export async function createNotificationChannel(projectId: string, kind: "slack" | "email", target: string): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/notification-channels`, {
    method: "POST",
    body: JSON.stringify({ kind, target }),
  });
}

export async function deleteNotificationChannel(projectId: string, channelId: string): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(`/v1/projects/${encodeURIComponent(projectId)}/notification-channels/${encodeURIComponent(channelId)}`, { method: "DELETE" });
}

export async function testNotificationChannels(projectId: string): Promise<readonly { id: string; kind: string; ok: boolean; error?: string }[]> {
  if (isMockMode()) return [];
  const response = await apiFetch<{ results: Array<{ id: string; kind: string; ok: boolean; error?: string }> }>(`/v1/projects/${encodeURIComponent(projectId)}/notification-channels/test`, { method: "POST" });
  return response.results;
}

export interface OrganizationSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: "owner" | "admin" | "member" | string;
  readonly createdAt: string;
}

export interface OrganizationDetail {
  readonly organization: { readonly id: string; readonly name: string; readonly slug: string };
  readonly role: string;
  readonly canManage: boolean;
  readonly protectedUserId?: string;
  readonly members: readonly { userId: string; githubLogin: string; role: string; createdAt: string; lastActivityAt?: string | null }[];
  readonly projects: readonly { id: string; repoFullName: string; defaultBranch: string }[];
  readonly projectCount: number;
}

export async function listOrganizations(): Promise<readonly OrganizationSummary[]> {
  if (isMockMode()) return [];
  const response = await apiFetch<{ organizations: OrganizationSummary[] }>("/v1/organizations");
  return response.organizations;
}

export async function searchUsers(
  term: string,
): Promise<readonly { id: string; githubLogin: string }[]> {
  if (isMockMode()) {
    const needle = term.trim().toLowerCase();
    if (needle.length < 2) return [];
    const known: readonly { id: string; githubLogin: string }[] = [
      { id: "11111111-1111-4111-8111-111111111111", githubLogin: "novus77" },
      { id: "22222222-2222-4222-8222-222222222222", githubLogin: "tapeci-bot" },
      { id: "33333333-3333-4333-8333-333333333333", githubLogin: "reviewer-olga" },
    ];
    return known.filter((member) => member.githubLogin.toLowerCase().includes(needle));
  }
  const response = await apiFetch<{ users: { id: string; githubLogin: string }[] }>(
    `/v1/users?q=${encodeURIComponent(term)}`,
  );
  return response.users;
}

export async function getOrganization(orgId: string): Promise<OrganizationDetail> {
  if (isMockMode()) return mock.getOrganization(orgId);
  return apiFetch(`/v1/organizations/${encodeURIComponent(orgId)}`);
}

export async function createOrganization(name: string): Promise<void> {
  if (isMockMode()) return;
  await apiFetch("/v1/organizations", { method: "POST", body: JSON.stringify({ name }) });
}

export async function updateOrganizationMemberRole(
  orgId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(
    `/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
    { method: "PATCH", body: JSON.stringify({ role }) },
  );
}

export async function addOrganizationMember(orgId: string, githubLogin: string, role: "admin" | "member"): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(`/v1/organizations/${encodeURIComponent(orgId)}/members`, {
    method: "POST",
    body: JSON.stringify({ githubLogin, role }),
  });
}

export async function removeOrganizationMember(orgId: string, userId: string): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(`/v1/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

export interface OrganizationBudget {
  readonly monthlyCapWei: string | null;
  readonly spentThisMonthWei: string;
  readonly projectCount: number;
}

export async function getOrganizationBudget(orgId: string): Promise<OrganizationBudget> {
  if (isMockMode()) return { monthlyCapWei: null, spentThisMonthWei: "0", projectCount: 0 };
  return apiFetch(`/v1/organizations/${encodeURIComponent(orgId)}/budget`);
}

export async function updateOrganizationBudget(orgId: string, monthlyCapWei: string | null): Promise<void> {
  if (isMockMode()) return;
  await apiFetch(`/v1/organizations/${encodeURIComponent(orgId)}/budget`, {
    method: "PATCH",
    body: JSON.stringify({ monthlyCapWei }),
  });
}

export async function getOrganizationAudit(orgId: string): Promise<readonly AuditEventRow[]> {
  if (isMockMode()) return [];
  const response = await apiFetch<{ events: AuditEventRow[] }>(`/v1/organizations/${encodeURIComponent(orgId)}/audit?limit=100`);
  return response.events;
}

// ---------------------------------------------------------------------------
// Resource discovery (SPEC §7.2, §8; DTOs frozen in packages/shared/src/resources.ts)
//
// These are public reads: the routes never look at the session, so the page can
// show an address it did not verify (W9) and must not say "your circuits". The
// DTO's job is to keep `false` (a real chain answer) apart from `null` (not
// established): the UI must not collapse them (§8.6, W5).
// ---------------------------------------------------------------------------

export type ResourceSyncStatus = "syncing" | "ready" | "partial" | "unavailable";

export interface ResourceRef {
  readonly chainId: 196;
  readonly processor: Hex;
  /** Base-10 integer string; `"0"` is a legal query (§5). */
  readonly tokenId: string;
}

export interface WalletResource {
  readonly resource: ResourceRef;
  /** Factory catalogue ordinal — never an ownership proof. */
  readonly processorIndex: number;
  readonly container: Hex | null;
  readonly owner: Hex | null;
  readonly deployed: boolean | null;
  readonly opened: boolean | null;
  /** Base-10 block number; `null` means nothing was read at a block. */
  readonly observedBlock: string | null;
  readonly readStatus: "verified" | "unavailable" | "not_found";
}

export interface WalletResourcePage {
  readonly address: Hex;
  readonly chainId: 196;
  readonly resources: readonly WalletResource[];
  readonly nextCursor: string | null;
  readonly syncStatus: ResourceSyncStatus;
  /** `true` only when the index covered the whole catalogue range (§8.4). */
  readonly complete: boolean;
  readonly indexedThroughBlock: string | null;
  readonly observedBlock: string | null;
}

export interface ProcessorRef {
  readonly processorIndex: number;
  readonly processor: Hex;
}

export interface ProcessorCatalogue {
  readonly chainId: 196;
  readonly processors: readonly ProcessorRef[];
  readonly syncStatus: ResourceSyncStatus;
  readonly complete: boolean;
  readonly indexedThroughBlock: string | null;
  readonly observedBlock: string | null;
}

/** One page of an address's circuits. `limit` is bounded by the route to 1–100. */
export async function getWalletResources(
  address: string,
  options: { readonly cursor?: string | null; readonly limit?: number } = {},
): Promise<WalletResourcePage> {
  if (isMockMode()) return mock.getWalletResourcePage(address, options.cursor ?? null);
  const query = new URLSearchParams({
    chainId: "196",
    limit: String(options.limit ?? 100),
  });
  const cursor = options.cursor ?? null;
  if (cursor !== null && cursor.length > 0) query.set("cursor", cursor);
  return apiFetch<WalletResourcePage>(
    `/v1/resources/wallets/${encodeURIComponent(address)}?${query.toString()}`,
  );
}

/** One processor that can mint, with the prices read from its own contracts (§12). */
export interface MintableProcessor {
  readonly cpuIndex: number;
  readonly processor: string;
  readonly transistors: string;
  readonly available: string;
  readonly mintPriceWei: string;
  readonly protocolFeeWei: string;
  readonly tapeoutFeeWei: string;
  readonly mintCostWei: string;
  readonly totalBeforeOpenWei: string;
  readonly nextId: string;
}

export interface MintableProcessorList {
  readonly chainId: 196;
  readonly processors: readonly MintableProcessor[];
  readonly examined: number;
  readonly soldOut: number;
  readonly observedBlock: string | null;
  readonly syncStatus: "verified" | "unavailable";
}

/** The two authorised transactions for minting one circuit, and what they cost. */
export interface SelfMintQuote {
  readonly sourceId: string;
  readonly chainId: 196;
  readonly processor: {
    readonly cpuIndex: number;
    readonly address: string;
    readonly transistors: string;
    readonly available: string;
  };
  readonly steps: readonly {
    readonly kind: "mint" | "tapeout";
    readonly to: string;
    readonly data: string;
    readonly valueWei: string;
    readonly functionName: string;
  }[];
  readonly prices: {
    readonly mintCostWei: string;
    readonly tapeoutFeeWei: string;
    readonly openerFeeWei: string;
    readonly totalWei: string;
  };
  readonly observedBlock: string;
  readonly expiresAt: string;
  readonly openQuotedSeparately: true;
  readonly predictedTokenId: string;
  readonly termsVersion: string;
}

/**
 * Processors that can actually mint, cheapest first.
 *
 * Sold-out processors are omitted by the API rather than returned with zero stock, so every
 * entry here is one a mint would not revert on.
 */
export async function listMintableProcessors(input?: {
  readonly limit?: number;
  readonly take?: number;
}): Promise<MintableProcessorList> {
  if (isMockMode()) return mock.listMintableProcessors(input);
  const params = new URLSearchParams({ chainId: "196" });
  if (input?.limit !== undefined) params.set("limit", String(input.limit));
  if (input?.take !== undefined) params.set("take", String(input.take));
  return apiFetch<MintableProcessorList>(`/v1/resources/mintable-processors?${params.toString()}`);
}

/**
 * Price a mint on the processor the user picked.
 *
 * Non-binding: the response authorises nothing and the open is quoted separately, because the
 * token id does not exist until the tapeout lands.
 */
export async function createSelfMintQuote(cpuIndex: number): Promise<SelfMintQuote> {
  if (isMockMode()) return mock.createSelfMintQuote(cpuIndex);
  const body = await apiFetch<{ quote: SelfMintQuote }>("/v1/resources/self-mint-quote", {
    method: "POST",
    body: JSON.stringify({ chainId: 196, cpuIndex }),
  });
  return body.quote;
}

export async function listResourceProcessors(): Promise<ProcessorCatalogue> {
  if (isMockMode()) return mock.listResourceProcessors();
  return apiFetch<ProcessorCatalogue>("/v1/resources/processors?chainId=196");
}

/**
 * Manual `(processor, tokenId)` lookup. The container is derived server-side from
 * the opener, so no address is ever accepted from this client (SPEC §2).
 */
export async function inspectResource(processor: string, tokenId: string): Promise<WalletResource> {
  if (isMockMode()) return mock.inspectResource(processor, tokenId);
  return apiFetch<WalletResource>("/v1/resources/inspect", {
    method: "POST",
    body: JSON.stringify({ chainId: 196, processor, tokenId }),
  });
}

// Re-exported for the preparation screens, which import their shapes from here.
export type { PreparationQuote, PreparationTask, PreparedStepAction } from "./types";

export async function getDeploymentPreparation(deploymentId: string): Promise<DeploymentPreparation> {
  if (isMockMode()) {
    // Derive the cost from the deployment's own plan rather than returning `null`: the page
    // renders that plan directly below this panel, so claiming "no plan" while showing one
    // would be a demo that contradicts itself.
    const plan = await mock.getDeploymentPlan(deploymentId);
    const cost: PreparationCost | null =
      plan === null
        ? null
        : {
            strategy: "original",
            physicalFiles: plan.totals.files,
            writeFiles: plan.totals.writes,
            reusedFiles: plan.totals.unchanged,
            plannedBytes: plan.totals.bytes,
            plannedChunks: plan.totals.chunks,
            estimatedGas: plan.fees.estimatedGas,
            estimatedCostWei: plan.fees.estimatedCostWei,
            recommendedCapWei: plan.fees.recommendedCapWei,
            costCapWei: plan.fees.costCapWei ?? "0",
            withinBudget: plan.fees.withinBudget,
          };
    return {
      request: { schemaVersion: "tapeci.preparation.v1", mode: "original", spaFallback: false },
      snapshotSha256: null,
      manifestSha256: null,
      // Demo mode cannot prepare or sign; that reason is separate from the cost.
      canPrepare: false,
      unavailableReason: "DEMO_MODE",
      gateways: [],
      cost,
      automaticSelection: {
        strategy: "original",
        reason: cost === null ? "cost-unknown" : "production-simulation-required",
      },
      quoteType: "model-estimate",
    };
  }
  return apiFetch(`/v1/deployments/${encodeURIComponent(deploymentId)}/preparation`);
}

export async function requestPreparationPlan(deploymentId: string, requestId: string, preparation: ReleasePreparationRequest): Promise<{ deploymentId: string }> {
  if (isMockMode()) throw new Error("Preparation planning is unavailable in demo mode");
  return apiFetch(`/v1/deployments/${encodeURIComponent(deploymentId)}/preparation`, {
    method: "POST", body: JSON.stringify({ requestId, preparation }),
  });
}
