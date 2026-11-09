/**
 * Shared I/O glue for the P2-10 release / rollback tools.
 *
 * Only the two CLIs import this module; the pure helpers live in
 * `mainnet-tooling.ts` so unit tests never load `pg`, `bullmq` or a database.
 *
 * Hard rule for this module: no signing, no `walletClient`, no
 * `sendTransaction`. The only writes it performs are (a) a local object store
 * `put` of the artifact tar, (b) a `deployments` INSERT in `BUILT`, (c) a
 * BullMQ `plan` enqueue, and (d) read-only HTTP GETs against the API.
 */
import { eq } from "drizzle-orm";
import {
  containers,
  createDatabase,
  deployments,
  projects,
  releases,
  users,
} from "@tapeci/database";
import { LocalObjectStore, objectKeyForSha256 } from "@tapeci/github";
import {
  DEPLOYMENT_STATES,
  createDeploymentQueues,
  enqueueDeployment,
  isTerminalState,
} from "@tapeci/queue";
import { TapeCiError, type Hex } from "@tapeci/shared";
import {
  DEFAULT_POLL_INTERVAL_MS,
  pollStatus,
  readPlanFees,
  type PlanFeeSummary,
} from "./mainnet-tooling.js";

export const DEFAULT_DATABASE_URL = "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci";
export const DEFAULT_REDIS_URL = "redis://127.0.0.1:56379";
export const DEFAULT_API_URL = "http://127.0.0.1:8787";
export const DEFAULT_OBJECT_STORE_DIR = ".tapeci/objects";

/** Terminal vocabulary from `@tapeci/queue` — never duplicated here. */
export const TERMINAL_STATES: readonly string[] = Object.freeze(
  DEPLOYMENT_STATES.filter((state) => isTerminalState(state)),
);

export interface ToolEnvironment {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly apiUrl: string;
  readonly objectStoreDir: string;
  /** Dev-only header values; `null` when the API requires a real session cookie. */
  readonly devLogin: string | null;
  readonly devUserId: string | null;
}

function text(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? fallback : trimmed;
}

export function readEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ToolEnvironment {
  const devLogin = text(env["TAPECI_DEV_GITHUB_LOGIN"], "");
  const devUserId = text(env["TAPECI_DEV_GITHUB_USER_ID"], "");
  return {
    databaseUrl: text(env["DATABASE_URL"], DEFAULT_DATABASE_URL),
    redisUrl: text(env["REDIS_URL"], DEFAULT_REDIS_URL),
    apiUrl: text(env["TAPECI_PUBLIC_API_URL"], DEFAULT_API_URL).replace(/\/+$/, ""),
    // The API reads OBJECT_STORE_DIR; TAPECI_OBJECT_STORE_DIR is accepted for the
    // older seed script. Both must point at the same directory as the worker.
    objectStoreDir: text(
      text(env["OBJECT_STORE_DIR"], ""),
      text(env["TAPECI_OBJECT_STORE_DIR"], DEFAULT_OBJECT_STORE_DIR),
    ),
    devLogin: devLogin === "" ? null : devLogin,
    devUserId: devUserId === "" ? null : devUserId,
  };
}

// ---------------------------------------------------------------------------
// Database access
// ---------------------------------------------------------------------------

export interface DatabaseHandle {
  readonly db: Database;
  readonly close: () => Promise<void>;
}

export type Database = ReturnType<typeof createDatabase>["db"];
type ProjectRow = typeof projects.$inferSelect;
type ContainerRow = typeof containers.$inferSelect;
type DeploymentRow = typeof deployments.$inferSelect;
type ReleaseRow = typeof releases.$inferSelect;

export function openDatabase(databaseUrl: string): DatabaseHandle {
  const { db, pool } = createDatabase(databaseUrl);
  return { db, close: async () => pool.end() };
}

export interface ProjectContext {
  readonly project: ProjectRow;
  readonly container: ContainerRow;
}

/** Load the project + its container, refusing archived projects like the API does. */
export async function loadProjectContext(
  db: Database,
  projectId: string,
): Promise<ProjectContext> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (project === undefined) {
    throw new TapeCiError("INVALID_CONFIG", `project ${projectId} does not exist`, {
      details: { projectId },
    });
  }
  if (project.isArchived) {
    throw new TapeCiError("INVALID_CONFIG", "archived projects cannot create deployments", {
      details: { projectId },
    });
  }
  const [container] = await db
    .select()
    .from(containers)
    .where(eq(containers.id, project.containerId))
    .limit(1);
  if (container === undefined) {
    throw new TapeCiError("INTERNAL", "project container is missing", { details: { projectId } });
  }
  return { project, container };
}

/** The dev-auth user that owns the canary project (`x-tapeci-github-login`). */
export async function findUserIdByLogin(
  db: Database,
  githubLogin: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.githubLogin, githubLogin))
    .limit(1);
  return row?.id ?? null;
}

export interface InsertBuiltInput {
  readonly project: ProjectRow;
  readonly container: ContainerRow;
  readonly createdByUserId: string | null;
  readonly commitSha: string;
  readonly artifactStorageKey: string;
  readonly artifactSha256: Hex;
  /** Unique per attempt so a retry never collides with the partial unique index. */
  readonly sourceEventKey: string;
}

/**
 * Insert the `BUILT` deployment row. `stateVersion` starts at 2 to mirror the
 * canary seeding path (`RECEIVED`→`BUILDING`→`BUILT`), and `registryAddress` is
 * copied from the container so the approval domain is correct.
 */
export async function insertBuiltDeployment(
  db: Database,
  input: InsertBuiltInput,
): Promise<DeploymentRow> {
  const [deployment] = await db
    .insert(deployments)
    .values({
      projectId: input.project.id,
      containerId: input.container.id,
      createdByUserId: input.createdByUserId,
      triggerKind: "manual",
      commitSha: input.commitSha,
      state: "BUILT",
      stateVersion: 2,
      registryAddress: input.container.registryAddress,
      artifactStorageKey: input.artifactStorageKey,
      artifactSha256: input.artifactSha256,
      sourceEventKey: input.sourceEventKey,
    })
    .returning();
  if (deployment === undefined) {
    throw new TapeCiError("INTERNAL", "deployment insert returned no row");
  }
  return deployment;
}

export async function loadDeployment(db: Database, deploymentId: string): Promise<DeploymentRow> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (row === undefined) {
    throw new TapeCiError("INTERNAL", `deployment ${deploymentId} does not exist`, {
      details: { deploymentId },
    });
  }
  return row;
}

/**
 * Resolve a release by its public id (`r-…`) or its database row id, scoped to
 * the project — the same lookup `POST /v1/projects/:id/rollback` performs.
 */
export async function resolveRelease(
  db: Database,
  projectId: string,
  releaseRef: string,
): Promise<ReleaseRow> {
  const rows = await db
    .select()
    .from(releases)
    .where(eq(releases.releaseId, releaseRef))
    .limit(1);
  const byPublicId = rows.find((row) => row.projectId === projectId);
  if (byPublicId !== undefined) return byPublicId;

  const byRowId = await db.select().from(releases).where(eq(releases.id, releaseRef)).limit(1);
  const row = byRowId.find((candidate) => candidate.projectId === projectId);
  if (row === undefined) {
    throw new TapeCiError("INVALID_CONFIG", "release is not stored for this project", {
      details: { projectId, release: releaseRef },
    });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Object store
// ---------------------------------------------------------------------------

export interface StoredArtifact {
  readonly objectKey: string;
  readonly sha256: Hex;
  readonly sizeBytes: number;
}

/** Content-addressed local store; `put` re-verifies the hash before writing. */
export async function storeArtifact(
  objectStoreDir: string,
  bytes: Uint8Array,
  sha256: Hex,
): Promise<StoredArtifact> {
  const objectKey = objectKeyForSha256(sha256);
  const store = new LocalObjectStore(objectStoreDir);
  await store.put(objectKey, bytes);
  return { objectKey, sha256, sizeBytes: bytes.length };
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Enqueue the read-only plan job (`jobId = deploymentId`, so it is idempotent). */
export async function enqueuePlanJob(redisUrl: string, deploymentId: string): Promise<void> {
  const queues = createDeploymentQueues({ redisUrl });
  try {
    await enqueueDeployment(queues.plan, deploymentId);
  } finally {
    await queues.close();
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export interface PollOptions {
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  /** Injected in tests; the CLIs pass a real DB read. */
  readonly readState: () => Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type PollResult =
  | { readonly status: "READY"; readonly state: string }
  | { readonly status: "TERMINAL"; readonly state: string }
  | { readonly status: "TIMEOUT"; readonly state: string };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll the deployment row until `PLAN_READY`, a terminal state or the timeout.
 * The terminal vocabulary comes from `@tapeci/queue` (single source of truth).
 */
export async function pollDeploymentState(options: PollOptions): Promise<PollResult> {
  const interval = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const state = await options.readState();
    const status = pollStatus(state, TERMINAL_STATES);
    if (status === "READY") return { status: "READY", state };
    if (status === "TERMINAL") return { status: "TERMINAL", state };
    if (Date.now() >= deadline) return { status: "TIMEOUT", state };
    await sleep(interval);
  }
}

// ---------------------------------------------------------------------------
// API (read-only)
// ---------------------------------------------------------------------------

export interface ApiClient {
  readonly get: (path: string) => Promise<unknown>;
}

function apiHeaders(environment: ToolEnvironment): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (environment.devLogin !== null) headers["x-tapeci-github-login"] = environment.devLogin;
  if (environment.devUserId !== null) headers["x-tapeci-github-user-id"] = environment.devUserId;
  return headers;
}

/**
 * Read-only API client. Only `GET` is exposed on purpose: approve/execute live
 * on `POST` endpoints and must stay manual.
 */
export function createReadOnlyApiClient(
  environment: ToolEnvironment,
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  return {
    get: async (path: string): Promise<unknown> => {
      const url = new URL(path, `${environment.apiUrl}/`).toString();
      const response = await fetchImpl(url, { method: "GET", headers: apiHeaders(environment) });
      const text = await response.text();
      let body: unknown = null;
      if (text !== "") {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new TapeCiError("INTERNAL", `API returned non-JSON for ${path}`, {
            details: { path, status: response.status },
          });
        }
      }
      if (!response.ok) {
        const errorBody = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
        const code =
          typeof errorBody?.code === "string" ? errorBody.code : `HTTP_${response.status}`;
        const message =
          typeof errorBody?.message === "string" ? errorBody.message : `GET ${path} failed`;
        throw new TapeCiError("INTERNAL", `${code}: ${message}`, {
          retryable: false,
          details: { path, status: response.status },
        });
      }
      return body;
    },
  };
}

export type ApprovalPayload = Record<string, unknown>;

/**
 * Fetch the EIP-712 approval payload for a `PLAN_READY` deployment. The nonce
 * and `expiresAt` are short-lived, so this is fetched last and printed for the
 * owner to sign in their own wallet.
 */
export async function fetchApprovalPayload(
  api: ApiClient,
  deploymentId: string,
): Promise<ApprovalPayload> {
  const body = await api.get(`/v1/deployments/${deploymentId}/approval-payload`);
  if (typeof body !== "object" || body === null) {
    throw new TapeCiError("INTERNAL", "approval payload is not an object", {
      details: { deploymentId },
    });
  }
  return body as ApprovalPayload;
}

/** Extract the `costCapWei` the API suggested, without trusting its type. */
export function approvalCostCapWei(payload: ApprovalPayload): string | null {
  const message = payload["message"];
  if (typeof message !== "object" || message === null) return null;
  const value = (message as { costCapWei?: unknown }).costCapWei;
  return typeof value === "string" ? value : null;
}

/** Fee block of the stored `plan_json`, for printing. */
export function planFees(planJson: unknown): PlanFeeSummary | null {
  return readPlanFees(planJson);
}
