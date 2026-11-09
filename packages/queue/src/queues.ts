import { Queue } from "bullmq";
import type {
  ConnectionOptions,
  DefaultJobOptions,
  Job,
  JobsOptions,
  Queue as BullQueue,
} from "bullmq";
import { TapeCiError } from "@tapeci/shared";
import { DEFAULT_REDIS_URL, redisUrlFromEnv } from "./redis.js";
import { assertUuid } from "./validation.js";

export type { ConnectionOptions, DefaultJobOptions, Job, JobsOptions, BullQueue };

/** Queue names fixed by the P2 worker contract (`docs/P2_API.md`). */
export const QUEUE_NAMES = ["plan", "deploy", "verify"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export function isQueueName(value: unknown): value is QueueName {
  return typeof value === "string" && (QUEUE_NAMES as readonly string[]).includes(value);
}

/** Job payload for all three queues. `jobId` is always the deployment id. */
export interface DeploymentJobData {
  readonly deploymentId: string;
}

export type DeploymentQueue = BullQueue<DeploymentJobData>;

/** BullMQ job name used for deployment jobs (job id carries identity). */
export const DEPLOYMENT_JOB_NAME = "deployment";

/** Retries: 3 attempts with exponential backoff; bounded completed/failed sets. */
export const DEFAULT_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 1_000, age: 24 * 60 * 60 },
  removeOnFail: { count: 5_000, age: 7 * 24 * 60 * 60 },
};

export interface DeploymentQueuesOptions {
  /** Redis URL; defaults to `REDIS_URL` (local dev: `redis://127.0.0.1:56379`). */
  readonly redisUrl?: string;
  /** Full BullMQ connection override (ioredis client or options). */
  readonly connection?: ConnectionOptions;
  /** BullMQ key prefix; useful in tests to isolate keys. Defaults to `bull`. */
  readonly prefix?: string;
  readonly defaultJobOptions?: DefaultJobOptions;
}

function connectionFor(options: DeploymentQueuesOptions): ConnectionOptions {
  if (options.connection !== undefined) return options.connection;
  const url = options.redisUrl ?? redisUrlFromEnv();
  return { url, maxRetriesPerRequest: null };
}

function queueOptions(
  options: DeploymentQueuesOptions,
): { connection: ConnectionOptions; defaultJobOptions: DefaultJobOptions; prefix?: string } {
  return {
    connection: connectionFor(options),
    defaultJobOptions: options.defaultJobOptions ?? DEFAULT_JOB_OPTIONS,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  };
}

/** The three BullMQ queues (`plan`, `deploy`, `verify`). Callers must `close()`. */
export class DeploymentQueues {
  readonly plan: DeploymentQueue;
  readonly deploy: DeploymentQueue;
  readonly verify: DeploymentQueue;

  constructor(options: DeploymentQueuesOptions = {}) {
    const shared = queueOptions(options);
    this.plan = new Queue<DeploymentJobData>("plan", shared);
    this.deploy = new Queue<DeploymentJobData>("deploy", shared);
    this.verify = new Queue<DeploymentJobData>("verify", shared);
  }

  get(name: QueueName): DeploymentQueue {
    return this[name];
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.plan.close(), this.deploy.close(), this.verify.close()]);
  }
}

export function createDeploymentQueues(options: DeploymentQueuesOptions = {}): DeploymentQueues {
  return new DeploymentQueues(options);
}

/**
 * The provisioning sweep queue (SPEC §4 `worker/provisioning.ts`).
 *
 * Kept separate from `DeploymentQueues` on purpose: its payload is not a deployment id
 * — the sweep is global, oldest-unresolved-first — and folding it into `QUEUE_NAMES`
 * would make `DeploymentJobData` a lie for one of its members.
 */
export const PROVISION_QUEUE_NAME = "provision";
export const PROVISIONING_SWEEP_JOB_NAME = "sweep";

/** The sweep takes no payload: it selects its own work from the database. */
export interface ProvisioningJobData {
  readonly requestedBy?: string;
}

export type ProvisioningQueue = BullQueue<ProvisioningJobData>;

export function createProvisioningQueue(
  options: DeploymentQueuesOptions = {},
): ProvisioningQueue {
  return new Queue<ProvisioningJobData>(PROVISION_QUEUE_NAME, queueOptions(options));
}

/**
 * Ask for one sweep. `jobId` is fixed so a burst of requests collapses into a single
 * pending job: the sweep is idempotent, so there is never a reason to queue several.
 */
export async function enqueueProvisioningSweep(
  queue: ProvisioningQueue,
  options: JobsOptions = {},
): Promise<string | undefined> {
  const job = await queue.add(
    PROVISIONING_SWEEP_JOB_NAME,
    {},
    { ...options, jobId: options.jobId ?? PROVISIONING_SWEEP_JOB_NAME },
  );
  return job.id;
}

/** Default Redis URL exported for convenience in scripts/tests. */
export const DEFAULT_QUEUE_REDIS_URL = DEFAULT_REDIS_URL;

/**
 * Enqueue one deployment. `jobId = deploymentId` makes the enqueue idempotent:
 * a duplicate webhook/retry returns the existing job instead of creating a second
 * unit of work (PRD §7.2 rule 10).
 */
export async function enqueueDeployment(
  queue: DeploymentQueue,
  deploymentId: string,
  options: JobsOptions = {},
): Promise<Job<DeploymentJobData>> {
  const id = assertUuid(deploymentId, "deploymentId");
  if (options.jobId !== undefined && options.jobId !== id) {
    throw new TapeCiError("INVALID_CONFIG", "enqueueDeployment jobId must equal the deployment id", {
      details: { deploymentId: id, jobId: options.jobId },
    });
  }
  // A retained completed/failed job with this id would make `add` a silent no-op
  // (BullMQ returns the existing job), so execute/resume would report "enqueued"
  // without doing any work. Remove only finished jobs; an active/waiting job is
  // the real idempotency case and must stay.
  const existing = await queue.getJob(id);
  if (existing !== null && existing !== undefined) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") await existing.remove();
  }
  return queue.add(DEPLOYMENT_JOB_NAME, { deploymentId: id }, { ...options, jobId: id });
}

/** Enqueue onto the queue by name (small convenience for API route handlers). */
export async function enqueueDeploymentOn(
  queues: DeploymentQueues,
  name: QueueName,
  deploymentId: string,
  options: JobsOptions = {},
): Promise<Job<DeploymentJobData>> {
  return enqueueDeployment(queues.get(name), deploymentId, options);
}
