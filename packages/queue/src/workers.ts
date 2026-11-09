import { UnrecoverableError, Worker } from "bullmq";
import type { ConnectionOptions, Job } from "bullmq";
import { TapeCiError, isTapeCiError } from "@tapeci/shared";
import {
  getDeployment,
  getDeploymentWithContainer,
  type Database,
} from "./db.js";
import {
  ContainerLock,
  withContainerLock,
  type ContainerLockLike,
} from "./lock.js";
import { redisUrlFromEnv } from "./redis.js";
import { QUEUE_NAMES, type DeploymentJobData, type QueueName } from "./queues.js";
import {
  ERROR_TERMINAL_STATES,
  isTerminalState,
  type DeploymentState,
} from "./states.js";
import { canTransition, transitionDeployment } from "./state-machine.js";
import { assertUuid } from "./validation.js";

/** Context handed to injected handlers (plan/deploy/verify implementations). */
export interface WorkerHandlerContext {
  readonly deploymentId: string;
  readonly queue: QueueName;
  readonly job: Job<DeploymentJobData, WorkerJobResult>;
  /** 1-based attempt number (`jobs.attemptsMade + 1`). */
  readonly attempt: number;
  readonly attempts: number;
  readonly db: Database;
}

/** Handler contract: perform work and apply success-state transitions itself. */
export type DeploymentJobHandler = (context: WorkerHandlerContext) => Promise<void>;

export interface WorkerHandlerMap {
  readonly plan?: DeploymentJobHandler;
  readonly deploy?: DeploymentJobHandler;
  readonly verify?: DeploymentJobHandler;
}

export interface DeploymentWorkersOptions {
  readonly db: Database;
  readonly redisUrl?: string;
  readonly connection?: ConnectionOptions;
  readonly prefix?: string;
  readonly handlers?: WorkerHandlerMap;
  /** Injectable lock (tests can use a fake); defaults to a real Redis `ContainerLock`. */
  readonly lock?: ContainerLockLike;
  readonly concurrency?: Partial<Record<QueueName, number>>;
  readonly lockTtlMs?: number;
  readonly lockAcquireTimeoutMs?: number;
}

export type WorkerOutcomeStatus = "HANDLED" | "SKIPPED";

export interface WorkerJobResult {
  readonly status: WorkerOutcomeStatus;
  readonly deploymentId: string;
  readonly state?: DeploymentState;
}

type DeploymentWorker = Worker<DeploymentJobData, WorkerJobResult>;

const DEFAULT_CONCURRENCY: Readonly<Record<QueueName, number>> = {
  plan: 2,
  deploy: 2,
  verify: 2,
};

const ERROR_CODE_TO_STATE: Readonly<Record<string, DeploymentState>> = {
  VERIFICATION_FAILED: "VERIFY_FAILED",
  NOT_CURRENT_OWNER: "OWNERSHIP_CHANGED",
  CHAIN_MISMATCH: "CHAIN_REORG_PENDING",
};

const ERROR_STATE_SET: ReadonlySet<string> = new Set(ERROR_TERMINAL_STATES);

/** Map a handler failure to the deployment state reported for that queue. */
export function failureStateFor(queueName: QueueName, error: unknown): DeploymentState {
  if (isTapeCiError(error)) {
    const mapped = ERROR_CODE_TO_STATE[error.code];
    if (mapped !== undefined) return mapped;
    if (ERROR_STATE_SET.has(error.code)) return error.code as DeploymentState;
  }
  switch (queueName) {
    case "plan":
      return "PLAN_REJECTED";
    case "deploy":
      return "UPLOAD_INTERRUPTED";
    case "verify":
      return "VERIFY_FAILED";
  }
}

function errorCodeOf(error: unknown): string {
  return isTapeCiError(error) ? error.code : "INTERNAL";
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryable(error: unknown): boolean {
  return isTapeCiError(error) ? error.retryable : true;
}

function defaultHandler(queueName: QueueName): DeploymentJobHandler {
  return async () => {
    throw new TapeCiError(
      "INTERNAL",
      `${queueName} worker handler is not implemented; wire the real plan/deploy/verify handler in the service layer`,
      { retryable: false, details: { queue: queueName } },
    );
  };
}

/**
 * Best-effort failure bookkeeping. The worker's job failure is the primary signal;
 * a state transition is recorded when the transition map allows it. A concurrent
 * actor (e.g. a revocation worker) may already have moved the deployment, in which
 * case the CAS failure is ignored rather than masking the original error.
 */
async function recordWorkerFailure(
  db: Database,
  queueName: QueueName,
  deploymentId: string,
  error: unknown,
  job: Job<DeploymentJobData, WorkerJobResult>,
): Promise<DeploymentState | null> {
  try {
    const current = await getDeployment(db, deploymentId);
    if (current === null || isTerminalState(current.state)) return null;
    const target = failureStateFor(queueName, error);
    if (!canTransition(current.state, target)) return null;
    await transitionDeployment(db, {
      deploymentId,
      expectedVersion: current.stateVersion,
      toState: target,
      eventType: `worker.${queueName}.failed`,
      actorKind: "worker",
      actorId: queueName,
      payload: {
        queue: queueName,
        errorCode: errorCodeOf(error),
        errorMessage: errorMessageOf(error),
        retryable: isRetryable(error),
        attemptsMade: job.attemptsMade,
        attempts: job.opts.attempts ?? 1,
      },
      errorCode: errorCodeOf(error),
      errorMessage: errorMessageOf(error),
    });
    return target;
  } catch {
    return null;
  }
}

async function handleJob(
  dependencies: {
    readonly db: Database;
    readonly lock: ContainerLockLike;
    readonly handlers: Required<WorkerHandlerMap>;
    readonly lockTtlMs: number;
    readonly lockAcquireTimeoutMs: number;
  },
  queueName: QueueName,
  job: Job<DeploymentJobData, WorkerJobResult>,
): Promise<WorkerJobResult> {
  const rawDeploymentId: unknown = job.data?.deploymentId;
  if (typeof rawDeploymentId !== "string") {
    throw new UnrecoverableError(`${queueName} job ${String(job.id)} has no deploymentId`);
  }
  let deploymentId: string;
  try {
    deploymentId = assertUuid(rawDeploymentId, "deploymentId");
  } catch (error) {
    throw new UnrecoverableError(errorMessageOf(error));
  }

  const before = await getDeployment(dependencies.db, deploymentId);
  if (before === null) {
    throw new UnrecoverableError(`deployment ${deploymentId} not found`);
  }
  // Idempotent retries: never re-run work (or replay events) for a terminal deployment.
  if (isTerminalState(before.state)) {
    return { status: "SKIPPED", deploymentId, state: before.state };
  }

  const attempts = job.opts.attempts ?? 1;
  const context: WorkerHandlerContext = {
    deploymentId,
    queue: queueName,
    job,
    attempt: job.attemptsMade + 1,
    attempts,
    db: dependencies.db,
  };
  const handler = dependencies.handlers[queueName];

  try {
    if (queueName === "deploy") {
      const withContainer = await getDeploymentWithContainer(dependencies.db, deploymentId);
      if (withContainer === null) {
        throw new UnrecoverableError(`deployment ${deploymentId} has no container`);
      }
      await withContainerLock(
        dependencies.lock,
        withContainer.containerAddress,
        () => handler(context),
        {
          ttlMs: dependencies.lockTtlMs,
          timeoutMs: dependencies.lockAcquireTimeoutMs,
        },
      );
    } else {
      await handler(context);
    }

    const after = await getDeployment(dependencies.db, deploymentId);
    return after === null
      ? { status: "HANDLED", deploymentId }
      : { status: "HANDLED", deploymentId, state: after.state };
  } catch (error) {
    const finalAttempt = job.attemptsMade + 1 >= attempts;
    const retryable = isRetryable(error);
    if (retryable && !finalAttempt) throw error;
    await recordWorkerFailure(dependencies.db, queueName, deploymentId, error, job);
    if (!retryable && !(error instanceof UnrecoverableError)) {
      throw new UnrecoverableError(errorMessageOf(error));
    }
    throw error;
  }
}

/** Collection of started workers plus owned resources. Close with `stopWorkers`. */
export class DeploymentWorkerSet {
  readonly workers: Readonly<Record<QueueName, DeploymentWorker>>;
  private readonly ownedLock: ContainerLock | null;
  private closed = false;

  constructor(
    workers: Record<QueueName, DeploymentWorker>,
    ownedLock: ContainerLock | null,
  ) {
    this.workers = workers;
    this.ownedLock = ownedLock;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled(QUEUE_NAMES.map((name) => this.workers[name].close()));
    if (this.ownedLock !== null) await this.ownedLock.close();
  }
}

/**
 * Start BullMQ workers for `plan`, `deploy`, `verify`.
 *
 * - handlers are injectable; the default handlers throw `NOT_IMPLEMENTED`-style
 *   `INTERNAL` errors so the API layer must wire real planning/deploy/verify code;
 * - the deploy worker wraps its handler in the per-container Redis lock;
 * - retryable errors retry with BullMQ backoff; on the final attempt (or for a
 *   non-retryable error) the deployment is moved to the mapped failure state;
 * - terminal deployments are skipped, so at-least-once delivery cannot replay them.
 */
export async function startWorkers(
  options: DeploymentWorkersOptions,
): Promise<DeploymentWorkerSet> {
  const redisUrl = options.redisUrl ?? redisUrlFromEnv();
  const connection: ConnectionOptions = options.connection ?? {
    url: redisUrl,
    maxRetriesPerRequest: null,
  };
  let ownedLock: ContainerLock | null = null;
  let lock: ContainerLockLike;
  if (options.lock === undefined) {
    ownedLock = new ContainerLock({ redisUrl });
    lock = ownedLock;
  } else {
    lock = options.lock;
  }
  const handlers: Required<WorkerHandlerMap> = {
    plan: options.handlers?.plan ?? defaultHandler("plan"),
    deploy: options.handlers?.deploy ?? defaultHandler("deploy"),
    verify: options.handlers?.verify ?? defaultHandler("verify"),
  };
  const dependencies = {
    db: options.db,
    lock,
    handlers,
    lockTtlMs: options.lockTtlMs ?? 300_000,
    lockAcquireTimeoutMs: options.lockAcquireTimeoutMs ?? 10_000,
  };

  const created: Partial<Record<QueueName, DeploymentWorker>> = {};
  try {
    for (const name of QUEUE_NAMES) {
      const concurrency = options.concurrency?.[name] ?? DEFAULT_CONCURRENCY[name];
      const worker = new Worker<DeploymentJobData, WorkerJobResult>(
        name,
        async (job) => handleJob(dependencies, name, job),
        {
          connection,
          concurrency,
          ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        },
      );
      // ioredis retries forever for BullMQ connections; the event must be consumed
      // so a transient Redis error does not crash the process.
      worker.on("error", () => undefined);
      created[name] = worker;
    }
    await Promise.all(QUEUE_NAMES.map(async (name) => created[name]!.waitUntilReady()));
    return new DeploymentWorkerSet(created as Record<QueueName, DeploymentWorker>, ownedLock);
  } catch (error) {
    await Promise.allSettled(
      QUEUE_NAMES.map(async (name) => created[name]?.close()),
    );
    if (ownedLock !== null) await ownedLock.close();
    throw error;
  }
}

export async function stopWorkers(workers: DeploymentWorkerSet): Promise<void> {
  await workers.close();
}
