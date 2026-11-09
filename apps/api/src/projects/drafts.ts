/**
 * Project draft lifecycle — SPEC §11.1, §11.2, §3.1 and issue P0-06.
 *
 * A project starts as a draft that lives in `project_drafts`, not in `projects`.
 * That is deliberate: a push can only be admitted against a `projects` row, so a
 * draft is structurally unable to admit a push or mint a build token (AC-P4-01).
 *
 * Two rules are easy to get wrong and are encoded here:
 * - The container is **never** client input. A draft stores the asset key
 *   `(chainId, processor, tokenId)`; the container address is derived from it at
 *   finalisation. A body carrying `containerAddress`/`containerId` is a 400, and
 *   the table has no column to store one (closes the P0-06 inversion).
 * - `pathMode` defaults to `versioned`. Choosing `root` requires the acknowledgement
 *   of the *current* text version, checked before the row is written: a UI that read an
 *   older text cannot satisfy the requirement (AC-P4-08, §11.1 step 4).
 *
 * Finalisation (§11.1 step 7) re-checks the four facts that can drift between the draft
 * and the project — installation, repository access, container derivation and the user's
 * write role on the container — against live state, and refuses unless every check is
 * `pass`. An unread check (`unknown`) refuses too: promoting on an unverified read would
 * create a project whose authorisation was never established (§11.1 R2). Promotion never
 * enables builds: `build_enabled` stays false until the readiness gate enables it (§11.2).
 *
 * Nothing in this module reads or writes build tokens, dispatches workflows or creates
 * deployments. Those belong to the build-run task and must go through admission.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ContractFunctionRevertedError, ContractFunctionZeroDataError, BaseError, isAddressEqual } from "viem";
import { XLAYER_MAINNET } from "@tapeci/config";
import {
  deriveContainer,
  findProcessorIndex,
  inspectContainer,
  type ProcessorToken,
  type ReadClient,
} from "@tapeci/chain";
import {
  containers,
  githubInstallationUsers,
  githubInstallations,
  projectDrafts,
  projectMembers,
  projects,
  wallets,
} from "@tapeci/database";
import {
  isGithubError,
  listInstallationRepositories,
  type GitHubRepositorySummary,
} from "@tapeci/github";
import type { Hex, ResourceRef } from "@tapeci/shared";
import { createOperatorClients } from "@tapeci/verifier";
import { requireUser } from "../auth.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import {
  assertInstallationAccess,
  installationToken,
  listInstallationsForUser,
} from "../github-app.js";
import { integerField, recordBody, stringField } from "../validation.js";

/** v1 is single-network (§1); the literal is part of the DTOs. */
const CHAIN_ID = 196;

/** Opaque acknowledgement revision compared, never parsed (AC-P4-08). */
export const ROOT_PATH_ACKNOWLEDGEMENT_VERSION = "root-path.v1";

/**
 * §11.1 step 4: the difference a `root` choice acknowledges. The UI renders it in both
 * locales; the server only records who read which version, because the text is copy and
 * the version is the contract.
 */
export const ROOT_PATH_ACKNOWLEDGEMENT_TEXT =
  "versioned keeps every build under its own release prefix, so rollback re-points the " +
  "entry to a previous release; root publishes files at their own paths, so a later " +
  "build overwrites same-named files in place and rollback can only restore files the " +
  "earlier release still has on chain.";

export type PathMode = "versioned" | "root";
export type ProjectDraftState = "draft" | "finalized";

/** One §11.1 finalisation re-check. `code` is `null` exactly when the state is `pass`. */
export type DraftCheckId =
  | "installation_active"
  | "repository_access"
  | "container_derivation"
  | "container_write_role";

export type DraftCheckState = "pass" | "fail" | "unknown";

export interface DraftCheck {
  readonly id: DraftCheckId;
  readonly state: DraftCheckState;
  readonly code: string | null;
  readonly reason: string | null;
}

export interface ProjectDraftDto {
  readonly id: string;
  readonly state: ProjectDraftState;
  /** §15.1 CAS token: send it back as `expectedVersion` on the next update. */
  readonly version: number;
  readonly githubInstallationId: string;
  readonly githubRepositoryId: number;
  readonly repoFullName: string;
  readonly defaultBranch: string;
  readonly installCommand: string;
  readonly buildCommand: string;
  readonly outputDirectory: string;
  readonly pathMode: PathMode;
  readonly rootPathAcknowledgedAt: string | null;
  readonly rootPathAcknowledgedBy: string | null;
  readonly rootPathAckVersion: string | null;
  /** The asset key only; the container is derived at finalisation, never stored here. */
  readonly resource: ResourceRef | null;
  readonly finalizedProjectId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Evidence that finalisation established. `opened` is recorded but is **not** a
 * finalisation gate: it is a release-stage fact, so an unopened container can own a
 * project that is built but not published (§11.1 R4).
 */
export interface FinalizedDraftContainer {
  readonly address: Hex;
  readonly processorIndex: number;
  readonly processor: Hex;
  readonly tokenId: string;
  readonly owner: Hex;
  readonly opened: boolean;
  readonly observedBlock: string;
}

export interface FinalizedProjectDraft {
  readonly draft: ProjectDraftDto;
  readonly project: {
    readonly id: string;
    readonly containerId: string;
    readonly containerAddress: Hex;
    readonly configVersion: number;
    readonly buildEnabled: boolean;
  };
  readonly container: FinalizedDraftContainer;
  readonly checks: readonly DraftCheck[];
}

export interface CreateProjectDraftOptions {
  readonly userId: string;
  /** The request body: this module owns field admission, so a route never re-validates it. */
  readonly body: Record<string, unknown>;
}

export interface UpdateProjectDraftOptions {
  readonly userId: string;
  readonly draftId: string;
  readonly body: Record<string, unknown>;
}

export interface FinalizeProjectDraftOptions {
  readonly userId: string;
  readonly draftId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

/**
 * Fields that would re-introduce the P0-06 inversion. They are rejected even when they
 * are `null`: accepting and ignoring them would let a caller believe the value stuck.
 */
const FORBIDDEN_DRAFT_FIELDS = ["containerAddress", "container", "containerId", "container_id"] as const;

/** Save a draft with no chain read, no `build_enabled` and therefore no admission target. */
export async function createProjectDraft(
  deps: ApiDeps,
  options: CreateProjectDraftOptions,
): Promise<ProjectDraftDto> {
  const parsed = readDraftBody(options.body);
  if (parsed.githubRepositoryId === null) {
    throw new ApiError(400, "INVALID_BODY", "githubRepositoryId is required");
  }
  if (parsed.repoFullName === null) {
    throw new ApiError(400, "INVALID_BODY", "repoFullName is required");
  }
  const installation = await requireUsableInstallation(
    deps,
    options.userId,
    parsed.githubInstallationId,
  );
  const now = deps.now?.() ?? new Date();
  const values: DraftValues = {
    organizationId: parsed.organizationId,
    githubInstallationId: installation.id,
    githubRepositoryId: parsed.githubRepositoryId,
    repoFullName: parsed.repoFullName,
    defaultBranch: parsed.defaultBranch ?? "main",
    installCommand: parsed.installCommand ?? "npm ci",
    buildCommand: parsed.buildCommand ?? "npm run build",
    outputDirectory: parsed.outputDirectory ?? "dist",
    ...pathPolicyValues({
      pathMode: parsed.pathMode ?? "versioned",
      acknowledged: parsed.rootPathAcknowledged,
      acknowledgementVersion: parsed.acknowledgementVersion,
      existing: null,
      userId: options.userId,
      now,
    }),
    ...resourceColumns(parsed.resource === undefined ? null : parsed.resource),
  };

  const [row] = await deps.db
    .insert(projectDrafts)
    .values({ ownerUserId: options.userId, ...values, createdAt: now, updatedAt: now })
    .returning();
  if (row === undefined) throw new ApiError(500, "INTERNAL", "could not store the project draft");
  return toDraftDto(row);
}

/** Save changes to an open draft. A finalised draft is immutable. */
export async function updateProjectDraft(
  deps: ApiDeps,
  options: UpdateProjectDraftOptions,
): Promise<ProjectDraftDto> {
  const parsed = readDraftBody(options.body);
  const draft = await loadOwnedDraft(deps, options.draftId, options.userId);
  if (draft.state !== "draft") {
    throw new ApiError(409, "DRAFT_ALREADY_FINALIZED", "a finalised draft cannot be changed", {
      projectId: draft.finalizedProjectId,
    });
  }
  if ((parsed.githubRepositoryId === null) !== (parsed.repoFullName === null)) {
    throw new ApiError(
      400,
      "INVALID_BODY",
      "githubRepositoryId and repoFullName must be provided together",
    );
  }
  const installationId =
    parsed.githubInstallationId === null
      ? draft.githubInstallationId
      : (await requireUsableInstallation(deps, options.userId, parsed.githubInstallationId)).id;
  const now = deps.now?.() ?? new Date();
  const key =
    parsed.resource === undefined
      ? {
          chainId: draft.chainId,
          processorAddress: storedAddress(draft.processorAddress),
          tokenId: draft.tokenId,
        }
      : resourceColumns(parsed.resource);
  const values: DraftValues = {
    organizationId: parsed.organizationId ?? draft.organizationId,
    githubInstallationId: installationId,
    githubRepositoryId: parsed.githubRepositoryId ?? draft.githubRepositoryId,
    repoFullName: parsed.repoFullName ?? draft.repoFullName,
    defaultBranch: parsed.defaultBranch ?? draft.defaultBranch,
    installCommand: parsed.installCommand ?? draft.installCommand,
    buildCommand: parsed.buildCommand ?? draft.buildCommand,
    outputDirectory: parsed.outputDirectory ?? draft.outputDirectory,
    ...pathPolicyValues({
      pathMode: parsed.pathMode ?? pathModeOf(draft.pathMode),
      acknowledged: parsed.rootPathAcknowledged,
      acknowledgementVersion: parsed.acknowledgementVersion,
      existing: draft,
      userId: options.userId,
      now,
    }),
    ...key,
  };

  // §15.1: a stale write must lose. The version is part of the WHERE clause, so two
  // concurrent updates cannot both succeed — the loser sees zero rows and is told why.
  const expectedVersion = parsed.expectedVersion;
  if (expectedVersion !== null && expectedVersion !== draft.version) {
    throw new ApiError(
      409,
      "DRAFT_CHANGED",
      "this draft changed since it was loaded; reload before saving",
      { expectedVersion, currentVersion: draft.version },
    );
  }
  const [row] = await deps.db
    .update(projectDrafts)
    .set({ ...values, version: draft.version + 1, updatedAt: now })
    .where(
      and(
        eq(projectDrafts.id, draft.id),
        eq(projectDrafts.state, "draft"),
        // Absent expectedVersion keeps the historical last-write-wins behaviour for
        // callers that never opted in; naming it is what makes the write guarded.
        expectedVersion === null
          ? undefined
          : eq(projectDrafts.version, expectedVersion),
      ),
    )
    .returning();
  if (row === undefined) {
    throw new ApiError(409, "DRAFT_CHANGED", "the draft changed while it was being saved; retry");
  }
  return toDraftDto(row);
}

/**
 * Promote a draft to a project, re-checking installation, repository, container
 * derivation and the user's write role on the container (§11.1 step 7).
 *
 * Promotion does not build, dispatch or enable anything: it only creates the `projects`
 * row a later admission decision can read, with `build_enabled` still false.
 */
export async function finalizeProjectDraft(
  deps: ApiDeps,
  options: FinalizeProjectDraftOptions,
): Promise<FinalizedProjectDraft> {
  const draft = await loadOwnedDraft(deps, options.draftId, options.userId);
  if (draft.state !== "draft") {
    throw new ApiError(409, "DRAFT_ALREADY_FINALIZED", "this draft is already a project", {
      projectId: draft.finalizedProjectId,
    });
  }

  const [installation] = await deps.db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, draft.githubInstallationId))
    .limit(1);
  const containerEvaluation = await evaluateDraftContainer(deps, draft);
  const checks: DraftCheck[] = [
    installationCheck(installation),
    await repositoryCheck(deps, draft, installation),
    ...containerEvaluation.checks,
  ];
  const blockers = checks.filter((check) => check.state !== "pass");
  if (blockers.length > 0) throw draftNotReadyError(blockers);
  const container = containerEvaluation.evidence;
  if (container === null) {
    // Unreachable: a passing derivation always carries evidence.
    throw new ApiError(500, "INTERNAL", "container evidence is missing after a passing check");
  }
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new ApiError(500, "INTERNAL", "no registry configured");
  const now = deps.now?.() ?? new Date();

  return deps.db.transaction(async (tx) => {
    // Lock the row and prove nothing changed since the checks ran: finalising a stale
    // snapshot would create a project for a circuit the user has already replaced.
    const [current] = await tx
      .select()
      .from(projectDrafts)
      .where(eq(projectDrafts.id, draft.id))
      .limit(1)
      .for("update");
    if (current === undefined) throw new ApiError(404, "DRAFT_NOT_FOUND", "project draft not found");
    if (current.state !== "draft") {
      throw new ApiError(409, "DRAFT_ALREADY_FINALIZED", "this draft is already a project", {
        projectId: current.finalizedProjectId,
      });
    }
    if (draftFingerprint(current) !== draftFingerprint(draft)) {
      throw new ApiError(409, "DRAFT_CHANGED", "the draft changed while it was being finalised; retry");
    }

    const [containerRow] = await tx
      .insert(containers)
      .values({
        chainId: CHAIN_ID,
        factoryAddress: XLAYER_MAINNET.factory.toLowerCase(),
        processorIndex: container.processorIndex,
        processorAddress: container.processor.toLowerCase(),
        tokenId: container.tokenId,
        containerAddress: container.address.toLowerCase(),
        registryAddress: registry.toLowerCase(),
        bindingAddress: XLAYER_MAINNET.binding.toLowerCase(),
        lastObservedOwner: container.owner.toLowerCase(),
        lastCheckedBlock: container.observedBlock,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [containers.chainId, containers.processorAddress, containers.tokenId],
        set: {
          processorIndex: container.processorIndex,
          containerAddress: container.address.toLowerCase(),
          lastObservedOwner: container.owner.toLowerCase(),
          lastCheckedBlock: container.observedBlock,
          updatedAt: now,
        },
      })
      .returning();
    if (containerRow === undefined) {
      throw new ApiError(500, "INTERNAL", "could not store the project container");
    }

    let project: typeof projects.$inferSelect;
    try {
      const [inserted] = await tx
        .insert(projects)
        .values({
          ownerUserId: draft.ownerUserId,
          githubInstallationId: draft.githubInstallationId,
          githubRepositoryId: draft.githubRepositoryId,
          repoFullName: draft.repoFullName,
          defaultBranch: draft.defaultBranch,
          buildCommand: draft.buildCommand,
          installCommand: draft.installCommand,
          outputDirectory: draft.outputDirectory,
          containerId: containerRow.id,
          pathMode: draft.pathMode,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (inserted === undefined) {
        throw new ApiError(500, "INTERNAL", "could not create the project");
      }
      project = inserted;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Only the (repository, branch, container) unique index is an expected conflict;
      // an outage must stay a 500 rather than being reported as "project already exists".
      if (!isUniqueViolation(error)) throw error;
      throw new ApiError(
        409,
        "PROJECT_EXISTS",
        "this repository, branch and container already have a project",
        { cause: describeError(error) },
      );
    }
    await tx
      .insert(projectMembers)
      .values({ projectId: project.id, userId: draft.ownerUserId, role: "owner" })
      .onConflictDoNothing();

    const [finalized] = await tx
      .update(projectDrafts)
      .set({ state: "finalized", finalizedProjectId: project.id, updatedAt: now })
      .where(and(eq(projectDrafts.id, draft.id), eq(projectDrafts.state, "draft")))
      .returning();
    if (finalized === undefined) {
      throw new ApiError(409, "DRAFT_CHANGED", "the draft changed while it was being finalised; retry");
    }

    return {
      draft: toDraftDto(finalized),
      project: {
        id: project.id,
        containerId: containerRow.id,
        containerAddress: container.address,
        configVersion: project.configVersion,
        buildEnabled: project.buildEnabled,
      },
      container,
      checks,
    };
  });
}

/**
 * The draft lifecycle over HTTP. Registered by the lead in `app.ts`; the routes only
 * authenticate and hand the raw body over, because this module owns field admission.
 */
export function registerProjectDraftRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post("/v1/project-drafts", async (request, reply) => {
    const user = requireUser(request);
    const draft = await createProjectDraft(deps, {
      userId: user.id,
      body: recordBody(request.body),
    });
    void reply.code(201);
    return { draft };
  });

  app.patch("/v1/project-drafts/:id", async (request) => {
    const user = requireUser(request);
    return {
      draft: await updateProjectDraft(deps, {
        userId: user.id,
        draftId: draftIdParam(request.params),
        body: recordBody(request.body),
      }),
    };
  });

  app.post("/v1/project-drafts/:id/finalize", async (request) => {
    const user = requireUser(request);
    return finalizeProjectDraft(deps, {
      userId: user.id,
      draftId: draftIdParam(request.params),
    });
  });
}

function draftIdParam(params: unknown): string {
  const value =
    typeof params === "object" && params !== null
      ? (params as { id?: unknown }).id
      : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, "INVALID_PATH", "draft id is required");
  }
  return value;
}

// ---------------------------------------------------------------------------
// Body admission: the only place a draft field is trusted
// ---------------------------------------------------------------------------

/** Every column a create/update writes, after body and database validation. */
interface DraftValues {
  /** Organization the finished project will belong to; null means personal (P4-08). */
  readonly organizationId: string | null;
  readonly githubInstallationId: string;
  readonly githubRepositoryId: number;
  readonly repoFullName: string;
  readonly defaultBranch: string;
  readonly installCommand: string;
  readonly buildCommand: string;
  readonly outputDirectory: string;
  readonly pathMode: PathMode;
  readonly rootPathAcknowledgedAt: Date | null;
  readonly rootPathAcknowledgedBy: string | null;
  readonly rootPathAckVersion: string | null;
  readonly chainId: number | null;
  readonly processorAddress: Hex | null;
  readonly tokenId: string | null;
}

interface ParsedDraftBody {
  /** §15.1 CAS token; `null` on create. */
  readonly expectedVersion: number | null;
  readonly organizationId: string | null;
  readonly githubInstallationId: string | null;
  readonly githubRepositoryId: number | null;
  readonly repoFullName: string | null;
  readonly defaultBranch: string | null;
  readonly installCommand: string | null;
  readonly buildCommand: string | null;
  readonly outputDirectory: string | null;
  readonly pathMode: PathMode | null;
  readonly rootPathAcknowledged: boolean;
  readonly acknowledgementVersion: string | null;
  /** `undefined` = not supplied (leave alone); `null` = clear the circuit. */
  readonly resource: ResourceRef | null | undefined;
}

function readDraftBody(body: Record<string, unknown>): ParsedDraftBody {
  for (const field of FORBIDDEN_DRAFT_FIELDS) {
    if (body[field] !== undefined) {
      throw new ApiError(
        400,
        "INVALID_BODY",
        `${field} is not accepted: the container is derived from (chainId, processor, tokenId)`,
      );
    }
  }
  const githubRepositoryId =
    body["githubRepositoryId"] === undefined ? null : integerField(body, "githubRepositoryId");
  const repoFullName =
    body["repoFullName"] === undefined
      ? null
      : readRepoFullName(requiredString(body, "repoFullName", 300));
  const acknowledgedValue = body["rootPathAcknowledged"];
  if (acknowledgedValue !== undefined && typeof acknowledgedValue !== "boolean") {
    throw new ApiError(400, "INVALID_BODY", "rootPathAcknowledged must be a boolean");
  }
  // §15.1 CAS: the client must name the version it read. Absent means "do not care" only
  // for create; the update path requires it.
  const expectedVersionValue = body["expectedVersion"];
  if (
    expectedVersionValue !== undefined &&
    (typeof expectedVersionValue !== "number" ||
      !Number.isSafeInteger(expectedVersionValue) ||
      expectedVersionValue < 1)
  ) {
    throw new ApiError(400, "INVALID_BODY", "expectedVersion must be a positive integer");
  }
  const organizationValue = body["organizationId"];
  if (
    organizationValue !== undefined &&
    organizationValue !== null &&
    (typeof organizationValue !== "string" || organizationValue.trim() === "")
  ) {
    throw new ApiError(400, "INVALID_BODY", "organizationId must be a non-empty string when present");
  }
  return {
    expectedVersion:
      typeof expectedVersionValue === "number" ? expectedVersionValue : null,
    organizationId:
      typeof organizationValue === "string" ? organizationValue.trim() : null,
    githubInstallationId:
      body["githubInstallationId"] === undefined
        ? null
        : readUuid(requiredString(body, "githubInstallationId"), "githubInstallationId"),
    githubRepositoryId,
    repoFullName,
    defaultBranch: optionalString(body, "defaultBranch", 255),
    installCommand: optionalString(body, "installCommand", 1024),
    buildCommand: optionalString(body, "buildCommand", 1024),
    outputDirectory:
      body["outputDirectory"] === undefined
        ? null
        : readOutputDirectory(requiredString(body, "outputDirectory", 1024)),
    pathMode: readPathMode(body["pathMode"]),
    rootPathAcknowledged: acknowledgedValue === true,
    acknowledgementVersion: optionalString(body, "acknowledgementVersion", 64),
    resource: readResourcePatch(body["resource"]),
  };
}

function readRepoFullName(value: string): string {
  if (!REPO_FULL_NAME_PATTERN.test(value)) {
    throw new ApiError(400, "INVALID_BODY", "repoFullName must look like owner/repo");
  }
  return value;
}

function readUuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) throw new ApiError(400, "INVALID_BODY", `${name} must be a UUID`);
  return value;
}

function readPathMode(value: unknown): PathMode | null {
  if (value === undefined) return null;
  if (value === "versioned" || value === "root") return value;
  throw new ApiError(400, "INVALID_BODY", 'pathMode must be "versioned" or "root"');
}

/** Canonical relative output directory; mirrors the table CHECK in migration 0016. */
function readOutputDirectory(value: string): string {
  const segments = value.split("/");
  if (
    value.includes("\\") ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ApiError(400, "INVALID_BODY", "outputDirectory must be a canonical relative directory");
  }
  return value;
}

/**
 * The asset key, in the §2 wire shape: chain literal, lowercase processor, decimal
 * string tokenId. A non-string tokenId is refused rather than coerced, because a JSON
 * number above 2^53 would already have lost the digits.
 */
function readResourcePatch(value: unknown): ResourceRef | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "resource must be an object or null");
  }
  const record = value as Record<string, unknown>;
  if (record["containerAddress"] !== undefined) {
    throw new ApiError(
      400,
      "INVALID_BODY",
      "resource.containerAddress is not accepted: the container is derived from the asset key",
    );
  }
  if (record["chainId"] !== CHAIN_ID) {
    throw new ApiError(422, "UNSUPPORTED_CHAIN", `only chain ${CHAIN_ID} is supported`, {
      chainId: record["chainId"],
    });
  }
  const processor = record["processor"];
  if (typeof processor !== "string" || !ADDRESS_PATTERN.test(processor)) {
    throw new ApiError(400, "INVALID_BODY", "resource.processor must be a 20-byte hex address");
  }
  const tokenId = record["tokenId"];
  if (typeof tokenId !== "string" || !DECIMAL_PATTERN.test(tokenId) || tokenId.length > 78) {
    throw new ApiError(400, "INVALID_BODY", "resource.tokenId must be a decimal string");
  }
  if (BigInt(tokenId) < 1n) {
    // Queryable as an asset, but `containers_token_id_check` requires >= 1 (P0-04).
    throw new ApiError(422, "RESOURCE_TOKEN_ZERO_UNSUPPORTED", "tokenId 0 cannot back a project", {
      processor,
      tokenId,
    });
  }
  return { chainId: CHAIN_ID, processor: processor.toLowerCase() as Hex, tokenId };
}

function requiredString(
  record: Record<string, unknown>,
  name: string,
  maxLength?: number,
): string {
  const value = stringField(record, name, maxLength === undefined ? {} : { maxLength });
  if (value === undefined) throw new ApiError(400, "INVALID_BODY", `${name} is required`);
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  name: string,
  maxLength?: number,
): string | null {
  const value = stringField(record, name, {
    optional: true,
    ...(maxLength === undefined ? {} : { maxLength }),
  });
  return value ?? null;
}

/**
 * §11.1 step 4: `versioned` is free; `root` needs the *current* acknowledgement text
 * version. Re-saving an already acknowledged root draft keeps its original who/when as
 * long as the text version has not changed.
 */
function pathPolicyValues(input: {
  readonly pathMode: PathMode;
  readonly acknowledged: boolean;
  readonly acknowledgementVersion: string | null;
  readonly existing: typeof projectDrafts.$inferSelect | null;
  readonly userId: string;
  readonly now: Date;
}): Pick<DraftValues, "pathMode" | "rootPathAcknowledgedAt" | "rootPathAcknowledgedBy" | "rootPathAckVersion"> {
  if (input.pathMode === "versioned") {
    return {
      pathMode: "versioned",
      rootPathAcknowledgedAt: null,
      rootPathAcknowledgedBy: null,
      rootPathAckVersion: null,
    };
  }
  if (
    input.acknowledged &&
    input.acknowledgementVersion === ROOT_PATH_ACKNOWLEDGEMENT_VERSION
  ) {
    return {
      pathMode: "root",
      rootPathAcknowledgedAt: input.now,
      rootPathAcknowledgedBy: input.userId,
      rootPathAckVersion: ROOT_PATH_ACKNOWLEDGEMENT_VERSION,
    };
  }
  const existing = input.existing;
  if (
    existing !== null &&
    existing.pathMode === "root" &&
    existing.rootPathAckVersion === ROOT_PATH_ACKNOWLEDGEMENT_VERSION &&
    existing.rootPathAcknowledgedAt !== null &&
    existing.rootPathAcknowledgedBy !== null
  ) {
    return {
      pathMode: "root",
      rootPathAcknowledgedAt: existing.rootPathAcknowledgedAt,
      rootPathAcknowledgedBy: existing.rootPathAcknowledgedBy,
      rootPathAckVersion: existing.rootPathAckVersion,
    };
  }
  throw new ApiError(
    409,
    "PATH_ACKNOWLEDGEMENT_REQUIRED",
    "root path mode requires acknowledging the overwrite and rollback differences first",
    {
      acknowledgementVersion: ROOT_PATH_ACKNOWLEDGEMENT_VERSION,
      acknowledgementText: ROOT_PATH_ACKNOWLEDGEMENT_TEXT,
    },
  );
}

function resourceColumns(
  resource: ResourceRef | null,
): Pick<DraftValues, "chainId" | "processorAddress" | "tokenId"> {
  if (resource === null) return { chainId: null, processorAddress: null, tokenId: null };
  return {
    chainId: resource.chainId,
    processorAddress: resource.processor,
    tokenId: resource.tokenId,
  };
}

// ---------------------------------------------------------------------------
// Finalisation checks (§11.1 step 7)
// ---------------------------------------------------------------------------

/** The installation must exist and be live; this is a local fact, so absence is `fail`. */
function installationCheck(
  installation: typeof githubInstallations.$inferSelect | undefined,
): DraftCheck {
  if (installation === undefined) {
    return failedCheck("installation_active", "AUTH_REVOKED", "the installation no longer exists");
  }
  if (installation.deletedAt !== null) {
    return failedCheck("installation_active", "AUTH_REVOKED", "the installation was deleted");
  }
  if (installation.suspendedAt !== null) {
    return failedCheck("installation_active", "AUTH_REVOKED", "the installation is suspended");
  }
  return passedCheck("installation_active");
}

/**
 * Repository access is a live read: the installation must still cover this repository id,
 * the user must still be linked to the installation, and the repository must be readable,
 * not archived and not renamed. A GitHub API failure is `unknown`, never `fail` (§11.1).
 */
async function repositoryCheck(
  deps: ApiDeps,
  draft: typeof projectDrafts.$inferSelect,
  installation: typeof githubInstallations.$inferSelect | undefined,
): Promise<DraftCheck> {
  if (installation === undefined || installation.deletedAt !== null) {
    return failedCheck("repository_access", "AUTH_REVOKED", "the installation no longer exists");
  }
  if (installation.suspendedAt !== null) {
    return failedCheck("repository_access", "AUTH_REVOKED", "the installation is suspended");
  }
  if (!deps.env.devAuth) {
    const [link] = await deps.db
      .select({ id: githubInstallationUsers.id })
      .from(githubInstallationUsers)
      .where(
        and(
          eq(githubInstallationUsers.installationId, installation.id),
          eq(githubInstallationUsers.userId, draft.ownerUserId),
        ),
      )
      .limit(1);
    if (link === undefined) {
      return failedCheck(
        "repository_access",
        "REPOSITORY_NOT_AUTHORIZED",
        "this installation is not linked to the draft owner's account",
      );
    }
  }
  if (deps.env.githubAppId === null || deps.env.githubAppPrivateKey === null) {
    return unknownCheck(
      "repository_access",
      "GITHUB_APP_NOT_CONFIGURED",
      "GitHub App credentials are not configured, so repository access could not be checked",
    );
  }
  let repositories: readonly GitHubRepositorySummary[];
  try {
    const token = await installationToken(deps.env, deps, installation.installationId);
    repositories = await listInstallationRepositories({
      token,
      apiBaseUrl: deps.github?.apiBaseUrl ?? deps.env.githubApiBaseUrl,
      ...(deps.github?.fetch === undefined ? {} : { fetch: deps.github.fetch }),
    });
  } catch (error) {
    if (isGithubError(error)) {
      return unknownCheck("repository_access", error.code, error.message);
    }
    throw error;
  }
  const repository = repositories.find((entry) => entry.id === draft.githubRepositoryId);
  if (repository === undefined) {
    return failedCheck(
      "repository_access",
      "REPOSITORY_NOT_AUTHORIZED",
      "the installation no longer covers this repository",
    );
  }
  if (repository.archived) {
    return failedCheck(
      "repository_access",
      "REPOSITORY_ARCHIVED",
      "the repository is archived and cannot be built",
    );
  }
  if (repository.fullName.toLowerCase() !== draft.repoFullName.toLowerCase()) {
    return failedCheck(
      "repository_access",
      "REPOSITORY_RENAMED",
      `the repository is now ${repository.fullName}; update the draft before finalising`,
    );
  }
  return passedCheck("repository_access");
}

/**
 * Container derivation and the user's write role on it. Both are chain/DB facts:
 * a transport failure is `unknown` (retryable), an explicit absence or mismatch is
 * `fail` — the draft's circuit is no longer usable.
 *
 * When the container cannot be derived there is no address to hold a write role, so the
 * second check mirrors the first: `unknown` stays retryable, `fail` stays terminal.
 */
async function evaluateDraftContainer(
  deps: ApiDeps,
  draft: typeof projectDrafts.$inferSelect,
): Promise<{
  readonly checks: readonly [DraftCheck, DraftCheck];
  readonly evidence: ContainerEvidence | null;
}> {
  const evidence = await deriveDraftContainer(deps, draft);
  if ("check" in evidence) {
    const derivation = evidence.check;
    return {
      evidence: null,
      checks: [
        derivation,
        {
          id: "container_write_role",
          state: derivation.state,
          code: derivation.code,
          reason: `${derivation.reason ?? "the container could not be derived"}; no verified container exists to hold a write role`,
        },
      ],
    };
  }
  const writeRole = await checkContainerWriteRole(deps, draft.ownerUserId, evidence.owner);
  return { evidence, checks: [passedCheck("container_derivation"), writeRole] };
}

type ContainerEvidence = FinalizedDraftContainer;

/**
 * Derive the container from the stored key and verify it, never from client input.
 * The successful result is the exact evidence finalisation persists inside its
 * transaction; a blocked result carries the one check that explains why.
 */
async function deriveDraftContainer(
  deps: ApiDeps,
  draft: typeof projectDrafts.$inferSelect,
): Promise<ContainerEvidence | { readonly check: DraftCheck }> {
  const resource = rowResource(draft);
  if (resource === null) {
    return {
      check: failedCheck(
        "container_derivation",
        "RESOURCE_REQUIRED",
        "no circuit has been attached to this draft",
      ),
    };
  }
  const client = readClientOf(deps);
  let head: bigint;
  try {
    head = await client.getBlockNumber();
  } catch (error) {
    return {
      check: unknownCheck(
        "container_derivation",
        "CONTAINER_READ_UNAVAILABLE",
        `the chain head could not be read: ${describeError(error)}`,
      ),
    };
  }

  let processorIndex: number | null;
  try {
    processorIndex = await findProcessorIndex(client, XLAYER_MAINNET, resource.processor, head);
  } catch (error) {
    return {
      check: unknownCheck(
        "container_derivation",
        "CONTAINER_READ_UNAVAILABLE",
        `the factory catalogue could not be read: ${describeError(error)}`,
      ),
    };
  }
  if (processorIndex === null) {
    return {
      check: failedCheck(
        "container_derivation",
        "PROCESSOR_NOT_REGISTERED",
        "the processor is not registered in the factory",
      ),
    };
  }

  let derived: ProcessorToken;
  try {
    derived = await deriveContainer(
      client,
      XLAYER_MAINNET,
      processorIndex,
      resource.tokenIdBig,
      head,
    );
  } catch (error) {
    if (isExplicitContractAnswer(error)) {
      return {
        check: failedCheck(
          "container_derivation",
          "RESOURCE_NOT_FOUND",
          `the chain has no circuit for this key: ${describeError(error)}`,
        ),
      };
    }
    return {
      check: unknownCheck(
        "container_derivation",
        "CONTAINER_READ_UNAVAILABLE",
        `the container derivation could not be read: ${describeError(error)}`,
      ),
    };
  }
  if (
    !isAddressEqual(derived.processor, resource.processor) ||
    derived.tokenId !== resource.tokenIdBig
  ) {
    return {
      check: failedCheck(
        "container_derivation",
        "RESOURCE_MISMATCH",
        "the factory returned a different circuit for this processor index",
      ),
    };
  }

  const inspection = await inspectContainer(client, XLAYER_MAINNET, derived.container, head);
  if (inspection.readStatus === "unavailable") {
    return {
      check: unknownCheck(
        "container_derivation",
        "CONTAINER_READ_UNAVAILABLE",
        `the container could not be read: ${inspection.failure.message}`,
      ),
    };
  }
  if (inspection.readStatus === "not_found") {
    return {
      check: failedCheck(
        "container_derivation",
        "CONTAINER_NOT_TAPEOUT",
        `the derived container is not a verified TapeOut container (${inspection.reason})`,
      ),
    };
  }
  // The inspection independently re-reads the container's own token; if it names another
  // circuit than the draft's key, the derivation belongs to a different asset. Refuse.
  if (
    !isAddressEqual(inspection.processor, resource.processor) ||
    inspection.tokenId !== resource.tokenIdBig
  ) {
    return {
      check: failedCheck(
        "container_derivation",
        "RESOURCE_MISMATCH",
        "the derived container belongs to a different circuit than the draft's key",
      ),
    };
  }
  return {
    // Normalize for storage and for the DTO: the chain's checksum casing is display-only,
    // while every persisted address is lowercase (§2).
    address: inspection.container.toLowerCase() as Hex,
    processorIndex,
    processor: inspection.processor.toLowerCase() as Hex,
    tokenId: inspection.tokenId.toString(10),
    owner: inspection.owner.toLowerCase() as Hex,
    opened: inspection.opened,
    observedBlock: inspection.observedBlock.toString(10),
  };
}

/** Only the current circuit holder can write; the holder must be a wallet this user proved. */
async function checkContainerWriteRole(
  deps: ApiDeps,
  userId: string,
  owner: Hex,
): Promise<DraftCheck> {
  const [wallet] = await deps.db
    .select({ address: wallets.address })
    .from(wallets)
    .where(
      and(
        eq(wallets.userId, userId),
        eq(wallets.chainId, CHAIN_ID),
        eq(wallets.address, owner.toLowerCase()),
      ),
    )
    .limit(1);
  if (wallet === undefined) {
    return failedCheck(
      "container_write_role",
      "OWNER_REQUIRED",
      "the container is not controlled by a wallet verified to this user",
    );
  }
  return passedCheck("container_write_role");
}

function draftNotReadyError(blockers: readonly DraftCheck[]): ApiError {
  const allUnknown = blockers.every((check) => check.state === "unknown");
  return new ApiError(
    allUnknown ? 503 : 409,
    allUnknown ? "DRAFT_CHECKS_UNKNOWN" : "DRAFT_CHECKS_FAILED",
    allUnknown
      ? "the draft could not be finalised because its checks could not run"
      : "the draft no longer matches the installation, repository, container or user permission",
    { checks: blockers },
    allUnknown,
  );
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------


async function loadOwnedDraft(
  deps: ApiDeps,
  draftId: string,
  userId: string,
): Promise<typeof projectDrafts.$inferSelect> {
  if (!UUID_PATTERN.test(draftId)) {
    throw new ApiError(400, "INVALID_PATH", "draft id must be a UUID");
  }
  const [draft] = await deps.db
    .select()
    .from(projectDrafts)
    .where(eq(projectDrafts.id, draftId))
    .limit(1);
  // A draft belongs to its creator only; another user's id is reported as absent.
  if (draft === undefined || draft.ownerUserId !== userId) {
    throw new ApiError(404, "DRAFT_NOT_FOUND", "project draft not found");
  }
  return draft;
}

/**
 * The installation named by the body (or the user's only installation in dev auth).
 * Saving requires a linked, live installation; finalisation re-checks it again.
 */
async function requireUsableInstallation(
  deps: ApiDeps,
  userId: string,
  requestedId: string | null,
): Promise<typeof githubInstallations.$inferSelect> {
  const installation = await findInstallation(deps, userId, requestedId);
  if (installation === undefined) {
    throw new ApiError(422, "REPOSITORY_NOT_AUTHORIZED", "no GitHub App installation is available");
  }
  await assertInstallationAccess(deps.db, userId, installation.id, deps.env.devAuth);
  if (installation.suspendedAt !== null || installation.deletedAt !== null) {
    throw new ApiError(409, "AUTH_REVOKED", "the GitHub App installation is suspended or deleted");
  }
  return installation;
}

async function findInstallation(
  deps: ApiDeps,
  userId: string,
  requestedId: string | null,
): Promise<typeof githubInstallations.$inferSelect | undefined> {
  if (requestedId !== null) {
    const [row] = await deps.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.id, requestedId))
      .limit(1);
    return row;
  }
  if (deps.env.devAuth) {
    // Local/test compatibility, mirroring POST /v1/projects: headers are the boundary.
    const [row] = await deps.db
      .select()
      .from(githubInstallations)
      .where(isNull(githubInstallations.deletedAt))
      .orderBy(desc(githubInstallations.createdAt))
      .limit(1);
    return row;
  }
  return (await listInstallationsForUser(deps.db, userId))[0];
}

// ---------------------------------------------------------------------------
// Small typed projections
// ---------------------------------------------------------------------------

function toDraftDto(row: typeof projectDrafts.$inferSelect): ProjectDraftDto {
  return {
    id: row.id,
    state: draftStateOf(row.state),
    version: row.version,
    githubInstallationId: row.githubInstallationId,
    githubRepositoryId: row.githubRepositoryId,
    repoFullName: row.repoFullName,
    defaultBranch: row.defaultBranch,
    installCommand: row.installCommand,
    buildCommand: row.buildCommand,
    outputDirectory: row.outputDirectory,
    pathMode: pathModeOf(row.pathMode),
    rootPathAcknowledgedAt: row.rootPathAcknowledgedAt?.toISOString() ?? null,
    rootPathAcknowledgedBy: row.rootPathAcknowledgedBy,
    rootPathAckVersion: row.rootPathAckVersion,
    resource: resourceOf(row),
    finalizedProjectId: row.finalizedProjectId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function resourceOf(row: typeof projectDrafts.$inferSelect): ResourceRef | null {
  const processor = storedAddress(row.processorAddress);
  if (row.chainId === null || processor === null || row.tokenId === null) return null;
  return { chainId: CHAIN_ID, processor, tokenId: row.tokenId };
}

/** The same key with its `bigint` tokenId for chain calls; the wire DTO stays a string. */
interface DraftResourceKey extends ResourceRef {
  readonly tokenIdBig: bigint;
}

function rowResource(row: typeof projectDrafts.$inferSelect): DraftResourceKey | null {
  const resource = resourceOf(row);
  if (resource === null) return null;
  if (!DECIMAL_PATTERN.test(resource.tokenId)) {
    throw new ApiError(500, "INTERNAL", "the stored token_id is not a decimal integer");
  }
  return { ...resource, tokenIdBig: BigInt(resource.tokenId) };
}

function storedAddress(value: string | null): Hex | null {
  if (value === null) return null;
  if (!ADDRESS_PATTERN.test(value)) {
    throw new ApiError(500, "INTERNAL", "a stored draft address is not a 20-byte hex value");
  }
  return value.toLowerCase() as Hex;
}

function pathModeOf(value: string): PathMode {
  if (value === "versioned" || value === "root") return value;
  throw new ApiError(500, "INTERNAL", `unexpected stored path_mode: ${value}`);
}

function draftStateOf(value: string): ProjectDraftState {
  if (value === "draft" || value === "finalized") return value;
  throw new ApiError(500, "INTERNAL", `unexpected stored draft state: ${value}`);
}

/** The fields finalisation copies; any change between check and insert must refuse. */
function draftFingerprint(row: typeof projectDrafts.$inferSelect): string {
  return JSON.stringify([
    row.githubInstallationId,
    row.githubRepositoryId,
    row.repoFullName,
    row.defaultBranch,
    row.installCommand,
    row.buildCommand,
    row.outputDirectory,
    row.pathMode,
    row.rootPathAckVersion,
    row.chainId,
    row.processorAddress,
    row.tokenId,
  ]);
}

function passedCheck(id: DraftCheckId): DraftCheck {
  return { id, state: "pass", code: null, reason: null };
}

function failedCheck(id: DraftCheckId, code: string, reason: string): DraftCheck {
  return { id, state: "fail", code, reason };
}

function unknownCheck(id: DraftCheckId, code: string, reason: string): DraftCheck {
  return { id, state: "unknown", code, reason };
}

// ---------------------------------------------------------------------------
// Chain access and error classification
// ---------------------------------------------------------------------------

function readClientOf(deps: ApiDeps): ReadClient {
  if (deps.readClient !== undefined) return deps.readClient();
  const [primary] = createOperatorClients(XLAYER_MAINNET);
  if (primary === undefined) {
    throw new ApiError(503, "CONTAINER_READ_UNAVAILABLE", "no RPC operator is configured", {}, true);
  }
  return primary.client;
}

/** `true` only when the chain itself answered (revert/empty), never for a transport error. */
function isExplicitContractAnswer(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError,
    ) !== null
  );
}

/** PostgreSQL unique violation (23505) anywhere on the driver error's cause chain. */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === "23505") return true;
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}

function describeError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}
