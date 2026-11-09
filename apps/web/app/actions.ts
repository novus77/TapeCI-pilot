"use server";

import type {
  CreateProjectResult,
  DeploymentActionCapabilities,
  DeploymentActionResult,
  ProjectFormValues,
} from "@/lib/action-types";
import type {
  ApprovalTypedData,
  BindResult,
  GithubRepositorySummary,
  PreparationQuote,
  ReleasePreparationRequest,
  PreparationTask,
  PreparedStepAction,
} from "@/lib/types";
import {
  approveDeployment,
  requestPreparationPlan,
  bindContainer,
  approveDeploymentWithSignature,
  createPreparation,
  createProject,
  createResourceQuote,
  getApprovalPayload,
  executeDeployment,
  getPreparation,
  listInstallationRepositories,
  getDeploymentActionCapabilities,
  prepareStep,
  reconcilePreparation,
  recordStepTransaction,
  registerBindSubmission,
  rollbackDeployment,
  requestDeploymentResume,
  requestDeploymentReapproval,
  inspectResource,
} from "@/lib/api";
import type { MintableProcessorList, SelfMintQuote } from "@/lib/api";
import { ApiError, describeError } from "@/lib/errors";
import { hasFieldErrors, normalizeProjectValues, validateProjectForm } from "@/lib/validation";

/**
 * Server actions are the only mutation path for client components. The session
 * cookie stays on the server; no API token or secret reaches the browser.
 */

export async function createProjectAction(
  values: ProjectFormValues,
  githubRepositoryId?: number,
): Promise<CreateProjectResult> {
  const normalized = normalizeProjectValues(values);
  const fieldErrors = validateProjectForm(normalized);
  if (hasFieldErrors(fieldErrors)) {
    return {
      ok: false,
      message: "Check the highlighted fields and try again.",
      projectId: null,
      repoFullName: null,
      fieldErrors,
    };
  }
  try {
    const project = await createProject({
      repoFullName: normalized.repoFullName,
      defaultBranch: normalized.defaultBranch,
      containerAddress: normalized.containerAddress as `0x${string}`,
      installCommand: normalized.installCommand,
      buildCommand: normalized.buildCommand,
      outputDirectory: normalized.outputDirectory,
      ...(githubRepositoryId === undefined ? {} : { githubRepositoryId }),
    });
    return {
      ok: true,
      message: `Project created for ${project.repoFullName}. The next push to ${project.defaultBranch} starts a deployment.`,
      projectId: project.id,
      repoFullName: project.repoFullName,
      fieldErrors: {},
    };
  } catch (error) {
    return {
      ok: false,
      message: describeError(error),
      projectId: null,
      repoFullName: null,
      fieldErrors: {},
    };
  }
}

function unavailableCapabilities(message: string): DeploymentActionCapabilities {
  return {
    canApprove: false,
    canExecute: false,
    canRollback: false,
    canResume: false,
    canReapprove: false,
    reasons: {
      approve: message,
      execute: message,
      rollback: message,
      resume: null,
      reapprove: null,
    },
    blockedReason: message,
    demoMode: false,
    requiresSignature: true,
  };
}

export async function loadDeploymentActionCapabilities(
  deploymentId: string,
): Promise<DeploymentActionCapabilities> {
  try {
    return await getDeploymentActionCapabilities(deploymentId);
  } catch (error) {
    return unavailableCapabilities(describeError(error));
  }
}

export async function approveDeploymentAction(
  deploymentId: string,
): Promise<DeploymentActionResult> {
  try {
    return await approveDeployment(deploymentId);
  } catch (error) {
    return { ok: false, message: describeError(error), deploymentId };
  }
}

export async function executeDeploymentAction(
  deploymentId: string,
): Promise<DeploymentActionResult> {
  try {
    return await executeDeployment(deploymentId);
  } catch (error) {
    return { ok: false, message: describeError(error), deploymentId };
  }
}

export async function resumeDeploymentAction(
  deploymentId: string,
): Promise<DeploymentActionResult> {
  try {
    const result = await requestDeploymentResume(deploymentId);
    return { ok: result.ok, message: result.message, deploymentId: result.deploymentId };
  } catch (error) {
    return { ok: false, message: describeError(error), deploymentId };
  }
}

export async function reapproveDeploymentAction(
  deploymentId: string,
): Promise<DeploymentActionResult> {
  try {
    const result = await requestDeploymentReapproval(deploymentId);
    return { ok: result.ok, message: result.message, deploymentId: result.deploymentId };
  } catch (error) {
    return { ok: false, message: describeError(error), deploymentId };
  }
}

export async function rollbackDeploymentAction(
  deploymentId: string,
): Promise<DeploymentActionResult> {
  try {
    return await rollbackDeployment(deploymentId);
  } catch (error) {
    return { ok: false, message: describeError(error), deploymentId };
  }
}


export interface RepositoriesActionResult {
  readonly ok: boolean;
  readonly message: string;
  readonly repositories: readonly GithubRepositorySummary[];
}

export async function loadInstallationRepositoriesAction(
  installationId: string,
): Promise<RepositoriesActionResult> {
  try {
    const repositories = await listInstallationRepositories(installationId);
    return { ok: true, message: "", repositories };
  } catch (error) {
    return { ok: false, message: describeError(error), repositories: [] };
  }
}

export type ApprovalPayloadResult =
  | { readonly ok: true; readonly payload: ApprovalTypedData }
  | { readonly ok: false; readonly message: string };

export async function loadApprovalPayloadAction(
  deploymentId: string,
): Promise<ApprovalPayloadResult> {
  try {
    return { ok: true, payload: await getApprovalPayload(deploymentId) };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function approveDeploymentWithSignatureAction(
  deploymentId: string,
  signerAddress: string,
  signature: string,
  approval: ApprovalTypedData["approval"],
): Promise<DeploymentActionResult> {
  try {
    return await approveDeploymentWithSignature(deploymentId, signerAddress, signature, approval);
  } catch (error) {
    return { ok: false, message: describeError(error), deploymentId };
  }
}

/**
 * Operator bind (`POST /v1/containers/:address/bind`).
 *
 * The browser never holds the operator key: it posts the name and months here and
 * the API signs with its own key after re-checking ownership, the name format, the
 * simulated call and the project budget. A missing route surfaces as a readable
 * failure, never as a success.
 */
export async function bindContainerWithOperatorAction(
  containerAddress: string,
  name: string,
  months: number,
): Promise<BindResult> {
  try {
    return await bindContainer(containerAddress, { name: name.trim(), months });
  } catch (error) {
    return { ok: false, message: describeError(error), txHash: null, alreadyLive: false };
  }
}

/**
 * Register a bind hash the user's own wallet broadcast (`POST
 * /v1/containers/:address/bind/submissions`).
 *
 * The direct-wallet path signs in the browser, so this is the only way the API
 * learns about it. The route stores the hash before verifying and returns
 * `pending` until a receipt is seen; the console shows that state and a refresh
 * keeps it, which is what §3.3 requires. No key, no signature and no calldata
 * crosses this boundary — only the public hash the wallet already produced.
 */
export async function registerBindSubmissionAction(
  containerAddress: string,
  name: string,
  months: number,
  txHash: string,
): Promise<BindResult> {
  try {
    return await registerBindSubmission(containerAddress, {
      name: name.trim(),
      months,
      txHash: txHash as `0x${string}`,
    });
  } catch (error) {
    return { ok: false, message: describeError(error), txHash: null, alreadyLive: false };
  }
}

/**
 * §3.1 step 3: choosing a circuit must re-verify it rather than trusting the
 * snapshot the list was rendered from. The index is a point-in-time read; between
 * the page load and the click the circuit can be transferred or opened by someone
 * else, and a stale snapshot would then be acted on as if it were current.
 *
 * Returns the fresh facts so the caller can compare them with what it displayed.
 */
export async function reVerifyResource(input: {
  readonly processor: string;
  readonly tokenId: string;
}): Promise<
  | {
      ok: true;
      opened: boolean;
      owner: string | null;
      container: string | null;
      /** The block the fresh read was pinned to, so the UI can say when it read. */
      observedBlock: string | null;
    }
  | { ok: false; reason: string }
> {
  try {
    const fresh = await inspectResource(input.processor, input.tokenId);
    if (fresh.readStatus !== "verified") {
      // `not_found` and `unavailable` are different facts and neither may be acted
      // on as "still mine" (§8.6).
      return { ok: false, reason: fresh.readStatus };
    }
    return {
      ok: true,
      opened: fresh.opened === true,
      owner: fresh.owner,
      container: fresh.container,
      observedBlock: fresh.observedBlock,
    };
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }
}

/* ------------------------------------------------------------------ *
 * P3 preparation (SPEC §7.2, §7.3)
 *
 * These are the only mutation paths the prepare panel uses. Like every other
 * action here, the session cookie and the API stay on the server: the browser
 * sends the asset key, the wallet address the user connected, or a public hash —
 * never a token, a price or a recipient it chose for someone else.
 * ------------------------------------------------------------------ */

/** A refused action: the raw machine code survives so the UI can localize it. */
export interface ActionFailure {
  readonly ok: false;
  readonly message: string;
  /** The API code, or `null` when the failure never reached the API. */
  readonly code: string | null;
}

function actionFailure(error: unknown): ActionFailure {
  return {
    ok: false,
    message: describeError(error),
    code: error instanceof ApiError ? error.code : null,
  };
}

export type ResourceQuoteResult =
  | { readonly ok: true; readonly quote: PreparationQuote }
  | ActionFailure;

/** §7.2 — price the `open` step for `(processor, tokenId)`. The server re-reads first. */
export async function createResourceQuoteAction(input: {
  readonly processor: string;
  readonly tokenId: string;
  readonly recipient: string;
}): Promise<ResourceQuoteResult> {
  try {
    return { ok: true, quote: await createResourceQuote(input) };
  } catch (error) {
    return actionFailure(error);
  }
}

export type PreparationTaskResult =
  | { readonly ok: true; readonly task: PreparationTask }
  | ActionFailure;

/**
 * §7.3 — accept the quote and create the task.
 *
 * `idempotencyKey` is derived by the caller from the quote id, so a double click
 * (or a retried request) resolves to the same task instead of opening two. The
 * key is a digest input on the server, never an authorization claim.
 */
export async function createPreparationAction(
  quoteId: string,
  idempotencyKey: string,
): Promise<PreparationTaskResult> {
  try {
    return { ok: true, task: await createPreparation({ quoteId, idempotencyKey }) };
  } catch (error) {
    return actionFailure(error);
  }
}

/** Re-read the task, e.g. after `prepare` bumped its version. */
export async function loadPreparationAction(taskId: string): Promise<PreparationTaskResult> {
  try {
    return { ok: true, task: await getPreparation(taskId) };
  } catch (error) {
    return actionFailure(error);
  }
}

export type PreparedStepActionResult =
  | { readonly ok: true; readonly action: PreparedStepAction }
  | ActionFailure;

/**
 * §7.3 — run the pre-flight and persist the intent. Idempotent: repeating it
 * returns the same `intentId` and byte-identical calldata.
 */
export async function prepareStepAction(
  taskId: string,
  stepId: string,
  expectedVersion: number,
): Promise<PreparedStepActionResult> {
  try {
    return { ok: true, action: await prepareStep({ taskId, stepId, expectedVersion }) };
  } catch (error) {
    return actionFailure(error);
  }
}

/**
 * §7.3 — record the hash the wallet returned. A 202 here means "recorded and
 * queued for verification", never "confirmed"; the caller must not treat it as
 * a success terminal.
 */
export async function recordStepTransactionAction(input: {
  readonly taskId: string;
  readonly stepId: string;
  readonly intentId: string;
  readonly txHash: string;
  readonly expectedVersion: number;
}): Promise<PreparationTaskResult> {
  try {
    return { ok: true, task: await recordStepTransaction(input) };
  } catch (error) {
    return actionFailure(error);
  }
}

/**
 * §7.3 — ask the server to re-check an attempt. The result reports what the
 * chain and the server can prove; it is not a confirmation by itself.
 */
export async function reconcilePreparationAction(
  taskId: string,
  expectedVersion: number,
): Promise<PreparationTaskResult> {
  try {
    return { ok: true, task: await reconcilePreparation({ taskId, expectedVersion }) };
  } catch (error) {
    return actionFailure(error);
  }
}

/**
 * The processors that can mint, for the picker (SPEC §12 of the self-mint spec).
 *
 * A **server action** rather than a direct call: `lib/api.ts` reads the session cookie, and
 * SPEC §4 forbids a client component importing it. The picker is a client component because it
 * reacts to the user's choice, so this is the boundary.
 */
export async function loadMintableProcessors(input?: {
  readonly limit?: number;
  readonly take?: number;
}): Promise<{ ok: true; list: MintableProcessorList } | ActionFailure> {
  try {
    const { listMintableProcessors } = await import("@/lib/api");
    return { ok: true, list: await listMintableProcessors(input) };
  } catch (error) {
    return actionFailure(error);
  }
}

/** Price a mint on the processor the user picked. Non-binding; authorises nothing. */
export async function priceSelfMint(
  cpuIndex: number,
): Promise<{ ok: true; quote: SelfMintQuote } | ActionFailure> {
  try {
    const { createSelfMintQuote } = await import("@/lib/api");
    return { ok: true, quote: await createSelfMintQuote(cpuIndex) };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function requestPreparationPlanAction(deploymentId: string, requestId: string, preparation: ReleasePreparationRequest) {
  try {
    const result = await requestPreparationPlan(deploymentId, requestId, preparation);
    return { ok: true as const, deploymentId: result.deploymentId };
  } catch (error) {
    return { ok: false as const, message: describeError(error) };
  }
}
