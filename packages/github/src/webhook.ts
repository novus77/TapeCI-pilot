/**
 * P2-03: GitHub push webhooks.
 *
 * Layers:
 * 1. `verifyWebhookSignature` — HMAC-SHA256 over the exact raw request bytes,
 *    compared with `timingSafeEqual`.
 * 2. `parsePushPayload` — strict, typed extraction of the fields TapeCI needs.
 * 3. `handlePushWebhook` — authenticate, deduplicate, authorize and create a
 *    `RECEIVED` deployment. Every outcome is recorded on `webhook_deliveries`
 *    (`accepted`, `error_code`, `processed_at`) except unauthenticated requests,
 *    which are rejected before any database write.
 *
 * Idempotency: the delivery id is unique in `webhook_deliveries`, so replaying a
 * delivery 10 times yields exactly one deployment. Independently,
 * `deployments.source_event_key` (`repoId:commitSha:branch`) makes a second
 * delivery for the same push idempotent as well.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  containers,
  deploymentEvents,
  deployments,
  githubInstallations,
  projects,
  webhookDeliveries,
  type Database,
} from "@tapeci/database";
import { GithubError, isGithubError } from "./errors.js";

/** Only `push` events create deployments. */
export const PUSH_EVENT = "push";
const SIGNATURE_HEADER = "x-hub-signature-256";
const HEX40_RE = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0000000000000000000000000000000000000000";

/** Node/Fastify-style raw headers (values may be arrays). */
export type GitHubWebhookHeaders = Readonly<
  Record<string, string | string[] | undefined>
>;

export interface VerifyWebhookSignatureInput {
  /** `GITHUB_WEBHOOK_SECRET`. */
  readonly secret: string;
  /** Exact bytes as received (before JSON parsing). */
  readonly rawBody: string | Uint8Array;
  /** `x-hub-signature-256`, e.g. `sha256=ab12…`. */
  readonly signatureHeader: string | undefined;
}

export interface ParsedPushEvent {
  readonly installationId: number;
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly ownerLogin: string;
  readonly ref: string;
  /** Branch name without the `refs/heads/` prefix. */
  readonly branch: string;
  readonly commitSha: string;
  readonly deleted: boolean;
}

/**
 * §11.2 admission gate, injected because this package cannot depend on `apps/api`
 * (the layering runs shared → github/chain → api). Absent means "admit every push",
 * which is the pre-§11.2 behaviour and keeps old callers compiling; the API always
 * supplies `decideAdmission`.
 */
export type PushAdmission =
  | { readonly admit: true }
  | { readonly admit: false; readonly errorCode: string; readonly detail: string };

export interface HandlePushWebhookInput {
  readonly db: Database;
  /** §11.2 admission decision; the API injects `decideAdmission`. */
  readonly admitPush?: (facts: {
    readonly installationActive: boolean;
    readonly repositoryMatches: boolean;
    readonly projectExists: boolean;
    readonly isDraft: boolean;
    readonly buildEnabled: boolean;
  }) => PushAdmission;
  /** `x-github-delivery` (passed explicitly by the route for dedup). */
  readonly deliveryId: string;
  /** `x-github-event` (only `push` is accepted). */
  readonly event: string;
  /** Raw headers; `x-hub-signature-256` is required. */
  readonly headers: GitHubWebhookHeaders;
  /** Exact raw body used for signature verification. */
  readonly rawBody: string | Uint8Array;
  /** `GITHUB_WEBHOOK_SECRET`. */
  readonly secret: string;
  /** Optional already-parsed JSON body; the signature still covers `rawBody`. */
  readonly payload?: unknown;
  /** Injectable clock. */
  readonly now?: () => Date;
}

export interface PushWebhookResult {
  /** True when this delivery (or push) had already been processed. */
  readonly duplicate: boolean;
  /**
   * True when the delivery was authenticated and produced (or matched) a
   * deployment. False for payload/authorization rejections.
   */
  readonly accepted: boolean;
  readonly deploymentId?: string;
  /** Stable rejection code (also persisted as `webhook_deliveries.error_code`). */
  readonly errorCode?: string;
}

function toBytes(rawBody: string | Uint8Array): Uint8Array {
  return typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody;
}

function headerValue(
  headers: GitHubWebhookHeaders,
  name: string,
): string | undefined {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

/** Compute the `sha256=…` signature GitHub would send for `rawBody`. */
export function computeWebhookSignature(
  secret: string,
  rawBody: string | Uint8Array,
): string {
  const digest = createHmac("sha256", secret).update(toBytes(rawBody)).digest("hex");
  return `sha256=${digest}`;
}

/**
 * Constant-time verification of `x-hub-signature-256` over the raw bytes.
 * Missing, malformed or mismatched signatures return false (never throw).
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  const header = input.signatureHeader;
  if (typeof header !== "string") return false;
  const match = /^sha256=([0-9a-f]{64})$/.exec(header.trim());
  if (match === null) return false;
  const providedHex = match[1];
  if (providedHex === undefined) return false;
  const expected = createHmac("sha256", input.secret).update(toBytes(input.rawBody)).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(providedHex, "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function requireRecord(
  parent: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = asRecord(parent[key]);
  if (value === undefined) {
    throw new GithubError("INVALID_PAYLOAD", `push payload is missing object "${key}"`);
  }
  return value;
}

function requireString(
  parent: Readonly<Record<string, unknown>>,
  key: string,
  description: string,
): string {
  const value = parent[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GithubError("INVALID_PAYLOAD", `push payload is missing ${description}`);
  }
  return value;
}

function requirePositiveInteger(
  parent: Readonly<Record<string, unknown>>,
  key: string,
  description: string,
): number {
  const value = parent[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new GithubError("INVALID_PAYLOAD", `push payload is missing ${description}`);
  }
  return value;
}

function decodeJson(rawBody: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch (cause) {
    throw new GithubError("INVALID_PAYLOAD", "webhook body is not valid UTF-8", { cause });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new GithubError("INVALID_PAYLOAD", "webhook body is not valid JSON", { cause });
  }
}

/**
 * Parse a GitHub `push` payload. Throws `GithubError` with `INVALID_PAYLOAD`
 * (malformed body) or `UNSUPPORTED_REF` (non-branch refs such as tags).
 */
export function parsePushPayload(payload: unknown): ParsedPushEvent {
  const root = asRecord(payload);
  if (root === undefined) {
    throw new GithubError("INVALID_PAYLOAD", "push payload must be a JSON object");
  }
  const installation = requireRecord(root, "installation");
  const repository = requireRecord(root, "repository");
  const owner = requireRecord(repository, "owner");
  const installationId = requirePositiveInteger(installation, "id", "installation.id");
  const repositoryId = requirePositiveInteger(repository, "id", "repository.id");
  const repositoryFullName = requireString(repository, "full_name", "repository.full_name");
  if (!repositoryFullName.includes("/")) {
    throw new GithubError("INVALID_PAYLOAD", "repository.full_name must be owner/name");
  }
  const ownerLogin = requireString(owner, "login", "repository.owner.login");
  const ref = requireString(root, "ref", "ref");
  const commitSha = requireString(root, "after", "after (commit sha)");
  if (!ref.startsWith("refs/heads/")) {
    throw new GithubError("UNSUPPORTED_REF", `only refs/heads/* push events deploy, got ${ref}`);
  }
  const branch = ref.slice("refs/heads/".length);
  if (branch.length === 0) {
    throw new GithubError("UNSUPPORTED_REF", "push ref has an empty branch name");
  }
  if (!HEX40_RE.test(commitSha)) {
    throw new GithubError("INVALID_PAYLOAD", "push payload after is not a 40-character commit sha");
  }
  const deleted = root.deleted === true || commitSha === ZERO_SHA;
  return {
    installationId,
    repositoryId,
    repositoryFullName,
    ownerLogin,
    ref,
    branch,
    commitSha,
    deleted,
  };
}

/**
 * Authenticate, deduplicate, authorize and create the deployment for a push.
 *
 * Returned `errorCode` values are stable: `SIGNATURE_INVALID`, `MISSING_HEADERS`,
 * `INVALID_PAYLOAD`, `UNSUPPORTED_EVENT`, `UNSUPPORTED_REF`, `PUSH_DELETED`,
 * `REPOSITORY_NOT_AUTHORIZED`, `AUTH_REVOKED`.
 */
export async function handlePushWebhook(
  input: HandlePushWebhookInput,
): Promise<PushWebhookResult> {
  if (input.secret.length === 0) {
    throw new GithubError(
      "WEBHOOK_CONFIG_INVALID",
      "GITHUB_WEBHOOK_SECRET is required to verify webhook signatures",
    );
  }
  const rawBytes = toBytes(input.rawBody);
  const signature = headerValue(input.headers, SIGNATURE_HEADER);
  if (
    !verifyWebhookSignature({
      secret: input.secret,
      rawBody: rawBytes,
      signatureHeader: signature,
    })
  ) {
    // Unauthenticated: never write attacker-controlled rows.
    return { duplicate: false, accepted: false, errorCode: "SIGNATURE_INVALID" };
  }
  const deliveryId = input.deliveryId.trim();
  const event = input.event.trim();
  if (deliveryId.length === 0 || deliveryId.length > 200 || event.length === 0) {
    return { duplicate: false, accepted: false, errorCode: "MISSING_HEADERS" };
  }
  const now = input.now?.() ?? new Date();

  return input.db.transaction(async (tx) => {
    const reject = async (
      deliveryRowId: string,
      errorCode: string,
    ): Promise<PushWebhookResult> => {
      await tx
        .update(webhookDeliveries)
        .set({ accepted: false, errorCode, processedAt: now })
        .where(eq(webhookDeliveries.id, deliveryRowId));
      return { duplicate: false, accepted: false, errorCode };
    };

    const [inserted] = await tx
      .insert(webhookDeliveries)
      .values({ githubDeliveryId: deliveryId, eventType: event })
      .onConflictDoNothing({ target: webhookDeliveries.githubDeliveryId })
      .returning({ id: webhookDeliveries.id });

    if (inserted === undefined) {
      const [existing] = await tx
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.githubDeliveryId, deliveryId))
        .limit(1);
      if (existing === undefined) {
        throw new GithubError(
          "GITHUB_API_ERROR",
          "webhook delivery insert conflicted but no row is visible",
        );
      }
      const [deployment] = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.webhookDeliveryId, existing.id))
        .limit(1);
      return withOptional(
        { duplicate: true, accepted: existing.accepted },
        { deploymentId: deployment?.id, errorCode: existing.errorCode ?? undefined },
      );
    }

    const deliveryRowId = inserted.id;
    if (event !== PUSH_EVENT) {
      return reject(deliveryRowId, "UNSUPPORTED_EVENT");
    }

    let parsed: ParsedPushEvent;
    try {
      parsed = parsePushPayload(input.payload ?? decodeJson(rawBytes));
    } catch (error) {
      const code = isGithubError(error) ? error.code : "INVALID_PAYLOAD";
      return reject(deliveryRowId, code);
    }

    await tx
      .update(webhookDeliveries)
      .set({
        githubInstallationNumericId: parsed.installationId,
        githubRepositoryId: parsed.repositoryId,
        ref: parsed.ref,
        commitSha: parsed.commitSha,
      })
      .where(eq(webhookDeliveries.id, deliveryRowId));

    if (parsed.deleted) {
      return reject(deliveryRowId, "PUSH_DELETED");
    }

    const [project] = await tx
      .select({
        id: projects.id,
        ownerUserId: projects.ownerUserId,
        installationRowId: projects.githubInstallationId,
        containerId: projects.containerId,
        buildEnabled: projects.buildEnabled,
        registryAddress: containers.registryAddress,
      })
      .from(projects)
      .innerJoin(containers, eq(projects.containerId, containers.id))
      .where(
        and(
          eq(projects.githubRepositoryId, parsed.repositoryId),
          eq(projects.defaultBranch, parsed.branch),
          eq(projects.isArchived, false),
        ),
      )
      .orderBy(projects.createdAt)
      .limit(1);
    const [installation] = await tx
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, parsed.installationId))
      .limit(1);
    const installationLive =
      installation !== undefined &&
      installation.deletedAt === null &&
      installation.suspendedAt === null;

    // §11.2: the gate decides whether this push admits a build at all, and records a
    // reason when it does not. It runs *before* any deployment row is created, so a
    // draft or a not-enabled project can never produce one.
    const admission =
      input.admitPush === undefined
        ? ({ admit: true } as const)
        : input.admitPush({
            installationActive: installationLive,
            repositoryMatches:
              project !== undefined &&
              installation !== undefined &&
              installation.id === project.installationRowId,
            projectExists: project !== undefined,
            isDraft: false,
            buildEnabled: project?.buildEnabled ?? false,
          });
    if (!admission.admit) {
      // The reason is stored on the delivery row so the skip is visible rather than a
      // silent drop; the detail sentence travels in the same code for now because
      // `webhook_deliveries` has no free-text column.
      return reject(deliveryRowId, admission.errorCode);
    }
    if (project === undefined) {
      return reject(deliveryRowId, "REPOSITORY_NOT_AUTHORIZED");
    }
    if (!installationLive || installation === undefined) {
      return reject(deliveryRowId, "AUTH_REVOKED");
    }
    if (installation.id !== project.installationRowId) {
      return reject(deliveryRowId, "REPOSITORY_NOT_AUTHORIZED");
    }

    // `branch` cannot contain ":" (Git ref rules forbid it), so this key is unambiguous.
    const sourceEventKey = `${parsed.repositoryId}:${parsed.commitSha}:${parsed.branch}`;
    const [deployment] = await tx
      .insert(deployments)
      .values({
        projectId: project.id,
        containerId: project.containerId,
        createdByUserId: project.ownerUserId,
        webhookDeliveryId: deliveryRowId,
        sourceEventKey,
        triggerKind: "webhook",
        commitSha: parsed.commitSha,
        state: "RECEIVED",
        registryAddress: project.registryAddress,
      })
      .onConflictDoNothing({ target: deployments.sourceEventKey })
      .returning({ id: deployments.id });

    if (deployment === undefined) {
      const [existing] = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.sourceEventKey, sourceEventKey))
        .limit(1);
      if (existing === undefined) {
        throw new GithubError(
          "GITHUB_API_ERROR",
          "deployment insert conflicted but no row is visible",
        );
      }
      await tx
        .update(webhookDeliveries)
        .set({ accepted: true, errorCode: null, processedAt: now })
        .where(eq(webhookDeliveries.id, deliveryRowId));
      return { duplicate: true, accepted: true, deploymentId: existing.id };
    }

    await tx.insert(deploymentEvents).values({
      deploymentId: deployment.id,
      oldState: null,
      newState: "RECEIVED",
      eventType: "WEBHOOK_RECEIVED",
      actorKind: "webhook",
      actorId: deliveryId,
      payload: {
        deliveryId,
        ref: parsed.ref,
        commitSha: parsed.commitSha,
        repositoryId: parsed.repositoryId,
        installationId: parsed.installationId,
      },
    });
    await tx
      .update(webhookDeliveries)
      .set({ accepted: true, errorCode: null, processedAt: now })
      .where(eq(webhookDeliveries.id, deliveryRowId));
    return { duplicate: false, accepted: true, deploymentId: deployment.id };
  });
}

function withOptional(
  base: Pick<PushWebhookResult, "duplicate" | "accepted">,
  optional: { readonly deploymentId?: string | undefined; readonly errorCode?: string | undefined },
): PushWebhookResult {
  const result: { duplicate: boolean; accepted: boolean; deploymentId?: string; errorCode?: string } =
    { ...base };
  if (optional.deploymentId !== undefined) result.deploymentId = optional.deploymentId;
  if (optional.errorCode !== undefined) result.errorCode = optional.errorCode;
  return result;
}
