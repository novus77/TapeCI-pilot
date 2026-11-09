/**
 * Reapproval and public resume — SPEC §12.2 and §12.3.
 *
 * §12.2: a deployment whose approval lapsed (`APPROVAL_EXPIRED`, or `APPROVED`
 * with no usable approval) is recoverable *without* re-planning. The server
 * re-checks the current project role, owner, plan summary, budget and
 * implementation version, revokes the old authorization, and returns the
 * deployment to `AWAITING_APPROVAL` so the user can sign again. The original
 * plan summary, journal identity and recovery stage survive that round trip:
 * they are written to `deployments.recovery_context` (migration 0018), which the
 * worker already maps onto `Deployment.recoveryContext`, and mirrored into an
 * immutable `deployment_events` payload as the audit trail (see "Storage").
 *
 * §12.3: `UPLOAD_INTERRUPTED` already has a worker/journal recovery. This module
 * adds the public entry point that connects to it: verify the original
 * pending/receipt state, the chunk index, the plan and a live approval, then
 * enqueue the existing deploy handler. An expired approval never resumes — it
 * returns the *reapproval* capability instead, so the signature gate is never
 * skipped.
 *
 * §12.3 also forbids the shortcut this module exists to prevent: no blanket
 * "retry" on `VERIFY_FAILED`, `SWITCH_FAILED` or `RPC_DISAGREEMENT`. Those are
 * terminal in `packages/queue/src/state-machine.ts` and no evidence this module
 * can read makes a repeat of the same chain write safe, so `recoveryCapability`
 * answers `none` for them with the specific blocking reason. The pure function
 * is the guard: a UI cannot invent a button that the server would refuse.
 *
 * ## Storage
 *
 * §12.2 names `deployments.recovery_context`; migration `0018_deployment_recovery_context`
 * adds it and `packages/queue/src/db.ts` maps it onto `Deployment.recoveryContext`,
 * so the worker reads it from the row it already loads. `requestReapproval` writes
 * the column on the successor attempt *and* records the same value in the
 * `reapproval_opened` event, so the carry-forward is auditable through
 * `GET /v1/deployments/:id/events` without reconstructing it from the column.
 * `readRecoveryContext` is the only reader: it reports `invalid` for a stored
 * payload that does not match `tapeci.recovery.v1`, never silently `missing`,
 * because resuming on a half-understood context is how a half-written release gets
 * rewritten.
 *
 * ## Why reapproval opens a successor attempt
 *
 * The transition table (`packages/queue/src/state-machine.ts`) is authoritative
 * and allows `AWAITING_APPROVAL` only from `PLAN_READY`. `APPROVED` has no edge
 * back to it, and `APPROVAL_EXPIRED` is in `TERMINAL_STATES` — `states.ts` says a
 * new deployment is required instead. Moving the same row is therefore not
 * expressible without inventing a transition, which this task forbids. So
 * `requestReapproval` opens a **continuation attempt**: a new `deployments` row
 * inserted directly in `AWAITING_APPROVAL` (the rollback endpoint already inserts
 * at `PLAN_READY`, so creating an attempt in an advanced state is an established
 * pattern), carrying `plan_json`, the manifest/artifact identity and the recovery
 * context verbatim. Nothing is re-planned from current chain state. The old
 * attempt is revoked and retired to `CANCELED` so the single chain-writer slot
 * (`deployments_one_chain_writer_per_container`) is free by the time the
 * successor is signed.
 *
 * The successor is idempotent on `source_event_key = 'reapproval:<old id>'`, so a
 * retried request — or a retry after a crash between the insert and the
 * retirement — returns the same attempt and finishes the retirement.
 *
 * If a future change adds `APPROVED|APPROVAL_EXPIRED → AWAITING_APPROVAL` to the
 * table *and* lets a user-initiated transition leave `APPROVAL_EXPIRED`
 * (`packages/queue/src/state-machine.ts` refuses that today at the terminal-state
 * guard, before it reads the map), `requestReapproval` can move the same row
 * instead; the capability table and the checks stay as they are.
 */

import { join } from "node:path";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import {
  approvalPolicies,
  approvals,
  containers,
  deploymentEvents,
  deployments,
  operatorSessions,
  projectBudgets,
  projects,
  releaseFiles,
  type Database,
} from "@tapeci/database";
import {
  planFromJson,
  planFingerprint,
  planToJson,
  readJournalState,
  type ReleasePlan,
} from "@tapeci/deployer";
import { assertImplementationsAllowlisted, type ReadClient } from "@tapeci/chain";
import { XLAYER_MAINNET } from "@tapeci/config";
import {
  createDeploymentQueues,
  enqueueDeployment,
  isDeploymentState,
  isTerminalState,
  revokeApproval,
  revokeOperatorSessionsForContainer,
  transitionDeployment,
  type DeploymentState,
} from "@tapeci/queue";
import { TapeCiError } from "@tapeci/shared";
import { createOperatorClients } from "@tapeci/verifier";
import type { ApiDeps } from "./deps.js";
import { ApiError } from "./errors.js";
import { projectAccess } from "./project-access.js";
import { monthlySpendWei, organizationBudgetStatus } from "./routes/governance.js";

// ---------------------------------------------------------------------------
// 1. Capability — the pure guard (§12.3)
// ---------------------------------------------------------------------------

/**
 * Whether the server will actually honour a resume, a reapproval, or neither for
 * one attempt. `reason` is the user-facing blocking explanation and is never
 * empty: a capability that cannot be explained is a bug.
 */
export interface RecoveryCapability {
  readonly action: "resume" | "reapproval" | "none";
  readonly reason: string;
}

/**
 * A signature the server would actually accept for chain writes. Chain writes
 * additionally require a live *operator session* (`assertOperatorAuthorized`), so
 * a live approval with a lapsed grant is not "active": the repair is the same as
 * for an expired approval (sign again), which is why one axis carries both.
 */
export type ApprovalEvidence = "active" | "expired" | "revoked" | "missing";

/** Local journal replay result for the attempt's journal file. */
export type JournalEvidence = "verified" | "absent" | "unreadable";

/** Whether the approved plan is still stored and rehydratable (§12.2). */
export type PlanEvidence = "present" | "absent" | "unreadable";

/** Carried recovery context, else derivable from `plan_json`, else unusable. */
export type RecoveryContextEvidence = "stored" | "derived" | "absent" | "invalid";

/**
 * Everything the capability decision may look at. Pure data: the caller has
 * already resolved each fact, including the clock-dependent `approval` verdict,
 * so the function itself cannot read a DB, a network or the current time and its
 * answer is reproducible for a test.
 */
export interface RecoveryFacts {
  /** Raw `deployments.state`; unknown strings are answered with `none`, never resume. */
  readonly state: string;
  /** `deployments.trigger_kind` (`webhook` | `manual` | `rollback`). */
  readonly triggerKind: string;
  readonly plan: PlanEvidence;
  readonly context: RecoveryContextEvidence;
  readonly approval: ApprovalEvidence;
  readonly journal: JournalEvidence;
  /** `release_files` progress for this attempt. */
  readonly files: "pending" | "partial" | "written" | "conflict";
  /** Sent-but unmined journal transactions; resume reconciles them before writing. */
  readonly unresolvedWrites: number;
}

const none = (reason: string): RecoveryCapability => ({ action: "none", reason });
const resume = (reason: string): RecoveryCapability => ({ action: "resume", reason });
const reapproval = (reason: string): RecoveryCapability => ({ action: "reapproval", reason });

/**
 * Per-state decision, keyed by the closed `DeploymentState` union so a state
 * added to `packages/queue` without a decision here is a **type error** instead of
 * a silent default. Every entry documents the evidence it relies on.
 */
const DECISIONS: Readonly<Record<DeploymentState, (facts: RecoveryFacts) => RecoveryCapability>> = {
  // The build has not started: no plan, no approval and no chain write exists, so
  // there is nothing a resume could continue.
  RECEIVED: () => none("the build has not started; resume needs an interrupted chain write"),
  BUILDING: () => none("the build is still running; resume needs an interrupted chain write"),
  BUILT: () => none("the artifact has not been planned yet; there is no approved plan to continue"),
  VALIDATING: () => none("the plan is still being computed; resume needs an interrupted chain write"),
  // A plan exists but has never been signed. `POST /approve` is the entry point;
  // "reapproval" would mean revoking an authorization that was never granted.
  PLAN_READY: () => none("the plan is ready and unsigned; request the first approval instead of a reapproval"),
  AWAITING_APPROVAL: () => none("the deployment is already waiting for its first signature"),
  /**
   * With a live signature the attempt is simply executed by `POST /execute`; a
   * "resume" would be a second word for the same action. Without one, §12.2 names
   * this the repairable case: the stored plan can be re-signed as-is.
   */
  APPROVED: (facts) => {
    if (facts.approval === "active") {
      return none("an active approval exists; queue the approved plan with POST /execute");
    }
    if (facts.triggerKind === "rollback") {
      return none("rollback attempts are re-created through POST /v1/projects/:id/rollback, which carries the target release");
    }
    if (facts.plan === "absent") {
      return none("no stored plan to re-sign; a new deployment attempt is required");
    }
    if (facts.plan === "unreadable") {
      return none("the stored plan cannot be rehydrated; re-signing it would sign an unknown payload");
    }
    return reapproval(
      `the approval is ${facts.approval} while the approved plan is still stored; re-sign the same plan`,
    );
  },
  // A chain write is in flight. Re-signing cannot help, and the journal/operator
  // nonce belong to this attempt: wait until it reaches UPLOAD_INTERRUPTED or a
  // terminal error. (Approving a successor now would also collide on the
  // single chain-writer slot.)
  UPLOADING_ASSETS: () =>
    none("a chain write is in flight; wait for UPLOAD_INTERRUPTED or a terminal outcome before recovering"),
  VERIFYING_ASSETS: () =>
    none("asset verification is running; it ends in SWITCHING_ENTRY or a terminal outcome"),
  // The entry write is the last and most dangerous write. No edge leaves this
  // state except an outcome, and a new signature would not change the journal's
  // entry decision.
  SWITCHING_ENTRY: () =>
    none("the entry-file write is in flight; re-signing would not change what the journal is writing"),
  VERIFYING_RELEASE: () =>
    none("release verification is running; LIVE/VERIFY_FAILED/RPC_DISAGREEMENT is decided from chain evidence"),
  // Rewriting a live release is a rollback, not a recovery.
  LIVE: () => none("the release is live; use the rollback path instead of rewriting a published site"),
  BUILD_FAILED: () => none("the build failed before a plan existed; push a build that produces an artifact"),
  // Re-signing a rejected plan re-runs the same preflight that rejected it.
  PLAN_REJECTED: () => none("the plan was rejected by preflight; fix the cause and create a new attempt"),
  /**
   * §12.2 names this state. The signature lapsed, but the approved plan and the
   * journal still describe the attempt, so the repair is a fresh signature over
   * the same plan — never a re-plan from current chain state. `APPROVAL_EXPIRED`
   * is terminal in the frozen table, so the reapproval runs on a successor
   * attempt that inherits the plan (see the module docblock).
   */
  APPROVAL_EXPIRED: (facts) => {
    if (facts.triggerKind === "rollback") {
      return none("rollback attempts are re-created through POST /v1/projects/:id/rollback, which carries the target release");
    }
    if (facts.plan === "absent") {
      return none("the approval expired and no plan is stored; there is nothing to re-sign");
    }
    if (facts.plan === "unreadable") {
      return none("the stored plan cannot be rehydrated; re-signing it would sign an unknown payload");
    }
    return reapproval("the approval expired while the approved plan is still stored; re-sign the same plan");
  },
  /**
   * §12.3's resume state. Resume is only offered when every piece of the half-
   * written attempt is still trustworthy: the plan, a usable recovery context, a
   * readable journal and a live signature. Each missing piece has its own reason
   * because each one needs a different repair; none of them falls back to
   * re-planning, which is what turns a half-written release into UPLOAD_CONFLICT.
   */
  UPLOAD_INTERRUPTED: (facts) => {
    if (facts.files === "conflict") {
      return none("a release file is in CONFLICT on chain; resuming would hit the same UPLOAD_CONFLICT");
    }
    if (facts.plan === "absent") {
      return none("no stored plan; resuming would re-plan half-written files and report UPLOAD_CONFLICT");
    }
    if (facts.plan === "unreadable") {
      return none("the stored plan cannot be rehydrated; a human must inspect this attempt");
    }
    if (facts.context === "invalid") {
      return none("the stored recovery context is unreadable; a human must inspect this attempt");
    }
    if (facts.journal === "unreadable") {
      return none("the local journal does not match the approved plan; reconcile it before resuming");
    }
    if (facts.approval !== "active") {
      // §12.3: an expired authorization is re-signed first; resume never skips
      // the signature gate.
      if (facts.triggerKind === "rollback") {
        return none("the approval lapsed; rollback attempts are re-created through POST /v1/projects/:id/rollback");
      }
      return reapproval(
        `the approval is ${facts.approval}; re-sign the stored plan before resuming the half-written upload`,
      );
    }
    return resume(
      facts.unresolvedWrites === 0
        ? "the stored plan, journal and approval are usable; resume continues the unfinished writes"
        : `the stored plan, journal and approval are usable; resume reconciles ${facts.unresolvedWrites} unresolved transaction(s) before writing anything further`,
    );
  },
  // The installation was deleted or suspended. A wallet signature cannot restore
  // repository access, and the artifact may no longer be fetchable.
  AUTH_REVOKED: () => none("the GitHub App installation is gone; repair the installation and create a new deployment"),
  // The plan's owner snapshot no longer describes the container, so a successor
  // carrying it would be signed by the wrong party. A new plan is required.
  OWNERSHIP_CHANGED: () =>
    none("the container owner changed after the plan was made; a new plan must be approved by the current owner"),
  // §红线: no further chain writes until the allowlist is re-verified.
  IMPLEMENTATION_CHANGED: () =>
    none("an implementation slot left the allowlist; re-verify the contracts before any new attempt"),
  // The fee snapshot is stale; re-signing the same plan would re-run out of funds.
  INSUFFICIENT_BALANCE: () =>
    none("the operator balance was below the plan estimate; a new plan with current fees is required"),
  FEE_OVER_BUDGET: () =>
    none("the plan exceeded the approved cap; re-signing it would exceed the cap again"),
  /**
   * §12.3 forbids the blanket retry. Two independent operators disagreed, so the
   * server does not know what the chain says; a repeat read would not create the
   * missing agreement. The disagreement is resolved by independent re-verification,
   * and the release needs a new attempt.
   */
  RPC_DISAGREEMENT: () =>
    none("the RPC operators disagreed; resolve the disagreement by independent re-verification, then start a new attempt"),
  CHAIN_REORG_PENDING: () =>
    none("a chain reorg is pending; writes stay stopped until finality is re-established"),
  // A real byte conflict with what is already on chain; a retry hits it again.
  UPLOAD_CONFLICT: () =>
    none("an on-chain file conflicts with the plan; resuming would hit the same conflict"),
  /**
   * §12.3's explicit example. Bounded verification retries already failed: the
   * chain bytes and the journal disagree, so re-running the same verification
   * reads the same bytes and fails the same way. An infinite retry is exactly what
   * the spec forbids; a new attempt (after the cause is understood) is the route.
   */
  VERIFY_FAILED: () =>
    none("verification found a real byte mismatch after bounded retries; a repeat would prove nothing new"),
  /**
   * The entry switch failed. Whether it landed is a question the receipt already
   * answered, and no transition leaves this state, so the answer is manual
   * inspection plus a new attempt — not a retry button.
   */
  SWITCH_FAILED: () =>
    none("the entry switch failed; the receipt decides what happened, and a new attempt is required"),
  ROLLBACK_REQUIRED: () => none("an operator decision is required; use the rollback path, not a retry"),
  CANCELED: () => none("the attempt was canceled; there is no work left to continue"),
};

/**
 * §12.2/§12.3 capability for one attempt. Pure: the caller supplies every fact,
 * including the approval verdict evaluated at its own clock.
 */
export function recoveryCapability(facts: RecoveryFacts): RecoveryCapability {
  if (!isDeploymentState(facts.state)) {
    // Never a default "resume": an unrecognised state means the server cannot
    // reason about the attempt at all.
    return none(`unrecognised deployment state ${facts.state}; no recovery path is known`);
  }
  return DECISIONS[facts.state](facts);
}

// ---------------------------------------------------------------------------
// 2. Recovery context — what §12.2 requires to survive AWAITING_APPROVAL → APPROVED
// ---------------------------------------------------------------------------

export const RECOVERY_CONTEXT_SCHEMA_VERSION = "tapeci.recovery.v1" as const;

/** The original plan summary: identity only, never re-derived from chain state. */
export interface RecoveryPlanSummary {
  readonly planFingerprint: string;
  readonly releaseId: string;
  readonly releaseManifestHash: string;
  readonly artifactDigest: string;
  readonly commitSha: string;
  readonly container: string;
  readonly siteRegistry: string;
  readonly entryPath: string;
  readonly pinnedBlockNumber: string;
  readonly totals: {
    readonly files: number;
    readonly writes: number;
    readonly chunks: number;
    readonly bytes: number;
  };
}

/**
 * Journal identity. Only the *key* is durable: `TAPECI_JOURNAL_DIR` is
 * machine-local, so storing an absolute path would make the record unusable on
 * another host. The path is rebuilt from the key at resume time.
 */
export interface RecoveryJournalIdentity {
  /** `deployments.id` whose `<id>.jsonl` journal holds the half-written attempt. */
  readonly deploymentId: string;
  readonly planFingerprint: string;
}

/** How far the attempt got before it stopped (§12.2's "恢复阶段"). */
export type RecoveryStage = "planned" | "approved" | "uploading_assets";

export interface RecoveryContext {
  readonly schemaVersion: typeof RECOVERY_CONTEXT_SCHEMA_VERSION;
  /** Identity of the plan, for checks and display. */
  readonly plan: RecoveryPlanSummary;
  /**
   * The exact `plan_json` document the summary describes, rehydratable with
   * `planFromJson`. This is what a worker executes after a reapproval: §12.2
   * requires the *original* plan, so it is copied, never recomputed.
   */
  readonly planJson: unknown;
  readonly journal: RecoveryJournalIdentity;
  readonly stage: RecoveryStage;
  /** The attempt this context was carried from; `null` for the first attempt. */
  readonly supersededDeploymentId: string | null;
  /** ISO timestamp from the caller's clock; the pure decision never reads time. */
  readonly recordedAt: string;
}

/** Result of looking for a stored context: absent, unusable, or parsed. */
export type RecoveryContextLookup =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly detail: string }
  | { readonly kind: "found"; readonly context: RecoveryContext };

const REAPPROVAL_OPENED_EVENT = "reapproval_opened";

/**
 * Read the context carried into this attempt. The newest `reapproval_opened`
 * event wins; a stored-but-unparseable payload is reported as `invalid` rather
 * than silently degraded to `missing`, because resuming on a wrong context is how
 * half-written resources get rewritten.
 */
export async function readRecoveryContext(
  db: Database,
  deploymentId: string,
): Promise<RecoveryContextLookup> {
  // §12.2 names `deployments.recovery_context` as the store: the context must survive
  // `AWAITING_APPROVAL → APPROVED`, so it belongs on the row the worker reads, not in an
  // append-only event the worker would have to reconstruct.
  const [row] = await db
    .select({ recoveryContext: deployments.recoveryContext })
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (row === undefined) return { kind: "missing" };
  // A NULL column is "no context carried" — an attempt that never needed one.
  // Only a *present but unparseable* value is `invalid`.
  if (row.recoveryContext === null) return { kind: "missing" };
  const context = parseRecoveryContext(row.recoveryContext);
  if (context === null) {
    return { kind: "invalid", detail: "the stored recovery context does not match tapeci.recovery.v1" };
  }
  return { kind: "found", context };
}

/**
 * The plan document a worker must execute for a deployment that carries a
 * recovery context, or `null` when it carries none it can trust.
 *
 * This is deliberately a *reader* and not a decision: the worker uses it to
 * outrank its `state === "UPLOAD_INTERRUPTED"` check, so a reapproved deployment
 * in `APPROVED` continues the original plan instead of re-planning resources that
 * are already on chain (§12.2). A context that does not validate yields `null`,
 * which puts the worker back on its conservative path.
 */
export function recoveryPlanJson(context: unknown): unknown | null {
  const parsed = parseRecoveryContext(context);
  return parsed === null ? null : parsed.planJson;
}

/**
 * The deployment id whose journal this run must continue (SPEC §12.2, P7-16).
 *
 * A reapproved deployment carries the ORIGINAL attempt's journal identity, because that
 * journal holds the sent-but-unmined intents and nonces a fresh file cannot know about.
 * `null` means there is no recovery context, so the caller uses the deployment's own id.
 */
export function recoveryJournalId(context: unknown): string | null {
  const parsed = parseRecoveryContext(context);
  return parsed === null ? null : parsed.journal.deploymentId;
}

/**
 * Validate a JSON value read back from storage. This is the boundary that owns
 * the untrusted payload, so it is the only place that inspects shapes.
 */
function parseRecoveryContext(value: unknown): RecoveryContext | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RECOVERY_CONTEXT_SCHEMA_VERSION) return null;
  const plan = record.plan;
  if (typeof plan !== "object" || plan === null) return null;
  const planRecord = plan as Record<string, unknown>;
  const fields = [
    "planFingerprint",
    "releaseId",
    "releaseManifestHash",
    "artifactDigest",
    "commitSha",
    "container",
    "siteRegistry",
    "entryPath",
    "pinnedBlockNumber",
  ] as const;
  const summary: Record<string, string> = {};
  for (const field of fields) {
    const raw = planRecord[field];
    if (typeof raw !== "string" || raw.length === 0) return null;
    summary[field] = raw;
  }
  const totals = planRecord.totals;
  if (typeof totals !== "object" || totals === null) return null;
  const totalsRecord = totals as Record<string, unknown>;
  if (
    typeof totalsRecord.files !== "number" ||
    typeof totalsRecord.writes !== "number" ||
    typeof totalsRecord.chunks !== "number" ||
    typeof totalsRecord.bytes !== "number"
  ) {
    return null;
  }
  const journal = record.journal;
  if (typeof journal !== "object" || journal === null) return null;
  const journalRecord = journal as Record<string, unknown>;
  const journalDeploymentId = journalRecord.deploymentId;
  const journalFingerprint = journalRecord.planFingerprint;
  if (typeof journalDeploymentId !== "string" || journalDeploymentId.length === 0) return null;
  if (typeof journalFingerprint !== "string" || journalFingerprint.length === 0) return null;
  const stage = record.stage;
  if (stage !== "planned" && stage !== "approved" && stage !== "uploading_assets") return null;
  const superseded = record.supersededDeploymentId;
  if (superseded !== null && typeof superseded !== "string") return null;
  const recordedAt = record.recordedAt;
  if (typeof recordedAt !== "string" || recordedAt.length === 0) return null;
  // The embedded plan must still rehydrate AND still fingerprint to the summary:
  // otherwise the context describes a plan nobody can execute, which is exactly
  // the state that must stop a resume instead of steering it.
  const embedded = readPlan(record.planJson);
  const planFingerprintOfContext = summary.planFingerprint as string;
  if (embedded === null) return null;
  if (planFingerprint(embedded).toLowerCase() !== planFingerprintOfContext.toLowerCase()) return null;
  if (journalFingerprint.toLowerCase() !== planFingerprintOfContext.toLowerCase()) return null;
  return {
    schemaVersion: RECOVERY_CONTEXT_SCHEMA_VERSION,
    planJson: record.planJson,
    plan: {
      planFingerprint: summary.planFingerprint as string,
      releaseId: summary.releaseId as string,
      releaseManifestHash: summary.releaseManifestHash as string,
      artifactDigest: summary.artifactDigest as string,
      commitSha: summary.commitSha as string,
      container: summary.container as string,
      siteRegistry: summary.siteRegistry as string,
      entryPath: summary.entryPath as string,
      pinnedBlockNumber: summary.pinnedBlockNumber as string,
      totals: {
        files: totalsRecord.files,
        writes: totalsRecord.writes,
        chunks: totalsRecord.chunks,
        bytes: totalsRecord.bytes,
      },
    },
    journal: { deploymentId: journalDeploymentId, planFingerprint: journalFingerprint },
    stage,
    supersededDeploymentId: superseded,
    recordedAt,
  };
}

function planSummaryOf(plan: ReleasePlan): RecoveryPlanSummary {
  return {
    planFingerprint: planFingerprint(plan),
    releaseId: plan.releaseId,
    releaseManifestHash: plan.releaseManifestHash,
    artifactDigest: plan.artifactDigest,
    commitSha: plan.commitSha,
    container: plan.container,
    siteRegistry: plan.siteRegistry,
    entryPath: plan.entryPath,
    pinnedBlockNumber: plan.pinnedBlockNumber.toString(),
    totals: {
      files: plan.totals.files,
      writes: plan.totals.writes,
      chunks: plan.totals.chunks,
      bytes: plan.totals.bytes,
    },
  };
}

function recoveryStageFor(state: string, progress: ReleaseFileProgress): RecoveryStage {
  if (state === "UPLOAD_INTERRUPTED" || state === "UPLOADING_ASSETS") {
    return progress.state === "pending" ? "approved" : "uploading_assets";
  }
  if (state === "APPROVED" || state === "APPROVAL_EXPIRED") {
    return progress.state === "pending" ? "approved" : "uploading_assets";
  }
  return progress.state === "pending" ? "planned" : "uploading_assets";
}

function journalPathFor(deps: ApiDeps, journalDeploymentId: string): string {
  return join(deps.env.journalDir, `${journalDeploymentId}.jsonl`);
}

// ---------------------------------------------------------------------------
// 3. Evidence — the one place that reads the attempt's facts
// ---------------------------------------------------------------------------

export interface ReleaseFileProgress {
  readonly files: number;
  readonly chunksWritten: number;
  readonly chunksTotal: number;
  readonly state: "pending" | "partial" | "written" | "conflict";
}

function summariseFileProgress(
  rows: readonly {
    readonly state: string;
    readonly chunkCount: number;
    readonly lastConfirmedChunkIndex: number;
  }[],
): ReleaseFileProgress {
  let chunksWritten = 0;
  let chunksTotal = 0;
  let anyProgress = false;
  let allDone = rows.length > 0;
  for (const row of rows) {
    chunksTotal += row.chunkCount;
    if (row.lastConfirmedChunkIndex >= 0) {
      chunksWritten += row.lastConfirmedChunkIndex + 1;
      anyProgress = true;
    }
    if (row.state === "CONFLICT") return { files: rows.length, chunksWritten, chunksTotal, state: "conflict" };
    const settled = row.state === "VERIFIED" || row.state === "UNCHANGED";
    if (!settled) allDone = false;
    if (row.state === "WRITING" || row.state === "WRITTEN") anyProgress = true;
  }
  if (rows.length === 0) return { files: 0, chunksWritten: 0, chunksTotal: 0, state: "pending" };
  if (allDone) return { files: rows.length, chunksWritten, chunksTotal, state: "written" };
  return { files: rows.length, chunksWritten, chunksTotal, state: anyProgress ? "partial" : "pending" };
}

interface ApprovalObservation {
  readonly evidence: ApprovalEvidence;
  readonly approvalId: string | null;
  readonly signerAddress: string | null;
}

/**
 * A live approval *and* a live operator grant. Chain writes need both, so
 * reporting "active" without the grant would let a resume be queued that the
 * worker must immediately refuse with `AUTH_REVOKED`.
 */
async function observeApproval(
  deps: ApiDeps,
  deployment: typeof deployments.$inferSelect,
  now: Date,
): Promise<ApprovalObservation> {
  const rows = await deps.db
    .select()
    .from(approvals)
    .where(eq(approvals.deploymentId, deployment.id))
    .orderBy(desc(approvals.createdAt));
  if (rows.length === 0) return { evidence: "missing", approvalId: null, signerAddress: null };
  const live = rows.find((row) => row.revokedAt === null && row.expiresAt.getTime() > now.getTime());
  if (live === undefined) {
    const revokedEverywhere = rows.every((row) => row.revokedAt !== null);
    return {
      evidence: revokedEverywhere ? "revoked" : "expired",
      approvalId: null,
      signerAddress: rows[0]?.signerAddress ?? null,
    };
  }
  const [session] = await deps.db
    .select({ id: operatorSessions.id })
    .from(operatorSessions)
    .where(
      and(
        eq(operatorSessions.containerId, deployment.containerId),
        eq(operatorSessions.signerAddress, live.signerAddress),
        isNull(operatorSessions.revokedAt),
        gt(operatorSessions.expiresAt, now),
      ),
    )
    .limit(1);
  if (session === undefined) {
    // The grant lapsed; the repair is the same as an expired approval (sign
    // again, which mints a new session).
    return { evidence: "expired", approvalId: live.id, signerAddress: live.signerAddress };
  }
  return { evidence: "active", approvalId: live.id, signerAddress: live.signerAddress };
}

interface JournalObservation {
  readonly evidence: JournalEvidence;
  readonly unresolvedWrites: number;
  readonly complete: boolean;
}

/**
 * Replay the attempt's journal read-only. A journal that exists but does not
 * fingerprint-match the plan is `unreadable`, not "absent": `executeRelease`
 * refuses a foreign journal, and reconciling it is an operator decision.
 */
async function observeJournal(path: string, plan: ReleasePlan | null): Promise<JournalObservation> {
  // `readJournalState` tolerates a missing file (empty state) and throws on a
  // corrupt or structurally invalid one; both outcomes are evidence here.
  try {
    const state = await readJournalState(path);
    if (state.plan === null) {
      return { evidence: "absent", unresolvedWrites: 0, complete: false };
    }
    const fingerprint = plan === null ? null : planFingerprint(plan);
    const matchesPlan =
      fingerprint !== null && state.plan.planFingerprint.toLowerCase() === fingerprint.toLowerCase();
    let unresolvedWrites = 0;
    for (const record of state.transactions.values()) {
      if (record.sent !== undefined && record.mined === undefined && record.failed === undefined) {
        unresolvedWrites += 1;
      }
    }
    return {
      evidence: matchesPlan ? "verified" : "unreadable",
      unresolvedWrites,
      complete: state.complete,
    };
  } catch (error) {
    if (error instanceof TapeCiError) {
      return { evidence: "unreadable", unresolvedWrites: 0, complete: false };
    }
    throw error;
  }
}

interface AttemptEvidence {
  readonly deployment: typeof deployments.$inferSelect;
  readonly facts: RecoveryFacts;
  readonly plan: ReleasePlan | null;
  readonly context: RecoveryContextLookup;
  readonly approval: ApprovalObservation;
  readonly progress: ReleaseFileProgress;
  readonly journalPath: string;
}

async function collectEvidence(
  deps: ApiDeps,
  deployment: typeof deployments.$inferSelect,
  now: Date,
): Promise<AttemptEvidence> {
  const fileRows = await deps.db
    .select({
      state: releaseFiles.state,
      chunkCount: releaseFiles.chunkCount,
      lastConfirmedChunkIndex: releaseFiles.lastConfirmedChunkIndex,
    })
    .from(releaseFiles)
    .where(eq(releaseFiles.deploymentId, deployment.id));
  const progress = summariseFileProgress(fileRows);
  const plan = readPlan(deployment.planJson);
  const stored = await readRecoveryContext(deps.db, deployment.id);
  const context: RecoveryContextEvidence =
    stored.kind === "found" ? "stored" : stored.kind === "invalid" ? "invalid" : plan === null ? "absent" : "derived";
  const journalDeploymentId = stored.kind === "found" ? stored.context.journal.deploymentId : deployment.id;
  const journalPath = journalPathFor(deps, journalDeploymentId);
  const journal = await observeJournal(journalPath, plan);
  const approval = await observeApproval(deps, deployment, now);
  return {
    deployment,
    plan,
    context: stored,
    approval,
    progress,
    journalPath,
    facts: {
      state: deployment.state,
      triggerKind: deployment.triggerKind,
      plan: deployment.planJson === null ? "absent" : plan === null ? "unreadable" : "present",
      context,
      approval: approval.evidence,
      journal: journal.evidence,
      files: progress.state,
      unresolvedWrites: journal.unresolvedWrites,
    },
  };
}

/** `plan_json` rehydrated without touching the chain; `null` means absent or corrupt. */
function readPlan(planJson: unknown): ReleasePlan | null {
  if (planJson === null || planJson === undefined) return null;
  try {
    return planFromJson(planJson);
  } catch {
    // `planFromJson` throws plain `Error` for non-decimal amounts: a corrupt row,
    // not a programming error. Callers turn it into `unreadable`/PLAN_STALE.
    return null;
  }
}

// ---------------------------------------------------------------------------
// 4. Shared request plumbing
// ---------------------------------------------------------------------------

export interface RecoveryRequest {
  readonly deploymentId: string;
  readonly userId: string;
}

/**
 * A recovery request the server refuses, with the capability that explains why.
 *
 * `reason` is the stable machine key a UI switches on (never on prose):
 * `REAPPROVAL_REQUIRED` means the signature gate is the repair and the UI may
 * offer reapproval; `NOT_RECOVERABLE` means no server-supported path exists for
 * this attempt. `detail` is the capability's human explanation.
 */
export interface RecoveryBlocked {
  readonly kind: "blocked";
  readonly deploymentId: string;
  readonly state: string;
  readonly reason: "REAPPROVAL_REQUIRED" | "NOT_RECOVERABLE";
  readonly detail: string;
  readonly capability: RecoveryCapability;
}

const DEPLOYMENT_NOT_FOUND = "DEPLOYMENT_NOT_FOUND" as const;

async function requireDeploymentAccess(
  deps: ApiDeps,
  input: RecoveryRequest,
): Promise<{ readonly deployment: typeof deployments.$inferSelect; readonly role: string }> {
  const [deployment] = await deps.db
    .select()
    .from(deployments)
    .where(eq(deployments.id, input.deploymentId))
    .limit(1);
  if (deployment === undefined) {
    throw new ApiError(404, DEPLOYMENT_NOT_FOUND, "deployment not found");
  }
  const access = await projectAccess(deps.db, deployment.projectId, input.userId);
  if (access === null) {
    // Same answer as a missing row: a non-member must not learn it exists.
    throw new ApiError(404, DEPLOYMENT_NOT_FOUND, "deployment not found");
  }
  return { deployment, role: access.role };
}

function roleSatisfies(actual: string, required: string): boolean {
  const rank: Record<string, number> = { viewer: 0, member: 1, maintainer: 2, owner: 3 };
  return (rank[actual] ?? 0) >= (rank[required] ?? 3);
}

function weiOf(value: string | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  return BigInt(value);
}

/**
 * The same read-client policy the container/project/resource routes use, so a
 * test injects one and production reads X Layer through the first operator.
 */
function readClientOf(deps: ApiDeps): ReadClient {
  const injected = deps.readClient;
  if (injected !== undefined) return injected();
  const operators = createOperatorClients(XLAYER_MAINNET);
  const primary = operators[0];
  if (primary === undefined) {
    throw new ApiError(500, "INTERNAL", "no RPC operator is configured");
  }
  return primary.client;
}

/**
 * §12.2's "re-check ... implementation version". A reapproval that cannot prove
 * the allowlist is unchanged does not re-issue a signature: chain writes are
 * forbidden on implementation drift (§红线), and guessing is worse than waiting.
 */
async function assertImplementationVersionUnchanged(deps: ApiDeps): Promise<void> {
  try {
    await assertImplementationsAllowlisted(readClientOf(deps), XLAYER_MAINNET);
  } catch (error) {
    if (error instanceof TapeCiError && error.code === "IMPLEMENTATION_CHANGED") {
      throw new ApiError(409, "IMPLEMENTATION_CHANGED", error.message, { reason: "implementation_changed" });
    }
    throw new ApiError(
      503,
      "CONTAINER_READ_UNAVAILABLE",
      "the implementation allowlist could not be verified, so no new signature is issued",
      { reason: "implementation_read_unavailable" },
    );
  }
}

function blocked(
  deployment: typeof deployments.$inferSelect,
  capability: RecoveryCapability,
): RecoveryBlocked {
  return {
    kind: "blocked",
    deploymentId: deployment.id,
    state: deployment.state,
    reason: capability.action === "reapproval" ? "REAPPROVAL_REQUIRED" : "NOT_RECOVERABLE",
    detail: capability.reason,
    capability,
  };
}

// ---------------------------------------------------------------------------
// 5. requestResume (§12.3)
// ---------------------------------------------------------------------------

/**
 * `202`-shaped result: the deploy handler was *requested*, not completed (P3-11 —
 * a 202 never means the chain write advanced).
 */
export interface ResumeRequested {
  readonly kind: "resume_requested";
  readonly deploymentId: string;
  readonly state: "UPLOAD_INTERRUPTED";
  readonly stateVersion: number;
  readonly queue: "deploy";
  readonly approvalId: string;
  readonly signerAddress: string;
  readonly journalPath: string;
  readonly journalComplete: boolean;
  readonly unresolvedWrites: number;
  readonly progress: ReleaseFileProgress;
  readonly recovery: RecoveryContext;
  readonly contextSource: "stored" | "derived";
}

export type ResumeResult = ResumeRequested | RecoveryBlocked;

/**
 * Public resume entry (§12.3). It validates the original attempt and then hands
 * the *existing* worker/journal recovery the job — it does not write to chain
 * itself, and it cannot plan: the plan comes from the stored context.
 */
/**
 * The capability the server is willing to support for this deployment (§12.2/§12.3),
 * exposed so the UI renders exactly what the server would accept instead of guessing
 * from the state string. A refusal here is information, not an error.
 */
export async function loadRecoveryCapability(
  deps: ApiDeps,
  input: RecoveryRequest,
): Promise<{ readonly state: string; readonly capability: RecoveryCapability }> {
  const now = deps.now?.() ?? new Date();
  const { deployment } = await requireDeploymentAccess(deps, input);
  const evidence = await collectEvidence(deps, deployment, now);
  return {
    state: String(deployment.state),
    capability: recoveryCapability(evidence.facts),
  };
}

export async function requestResume(deps: ApiDeps, input: RecoveryRequest): Promise<ResumeResult> {
  const now = deps.now?.() ?? new Date();
  const { deployment } = await requireDeploymentAccess(deps, input);
  const evidence = await collectEvidence(deps, deployment, now);
  const capability = recoveryCapability(evidence.facts);
  if (capability.action !== "resume") return blocked(deployment, capability);

  // The capability promised these are usable; re-assert rather than cast so a
  // concurrent change becomes a typed refusal instead of a crash.
  const plan = evidence.plan;
  const approval = evidence.approval;
  if (
    plan === null ||
    approval.approvalId === null ||
    approval.signerAddress === null ||
    approval.evidence !== "active"
  ) {
    throw new ApiError(
      409,
      "UPLOAD_INTERRUPTED",
      "the resume preconditions changed while the request was validated; retry the recovery",
      { reason: "precondition_changed", deploymentId: deployment.id },
    );
  }
  // A carried context wins over plan_json alone (§12.2); without one, the
  // context is derived from the stored plan and this attempt's journal key —
  // never re-planned from current chain state.
  const context = contextFromEvidence(evidence, plan, now, null);

  // §12.2's "original plan is still recoverable": the carried summary must
  // describe exactly the plan we are about to resume, or the journal/context pair
  // is lying about the half-written release.
  const fingerprint = planFingerprint(plan);
  if (
    context.plan.planFingerprint.toLowerCase() !== fingerprint.toLowerCase() ||
    context.journal.planFingerprint.toLowerCase() !== fingerprint.toLowerCase()
  ) {
    throw new ApiError(
      409,
      "PLAN_STALE",
      "the recovery context does not describe the stored plan; a new deployment attempt is required",
      {
        reason: "recovery_context_plan_mismatch",
        deploymentId: deployment.id,
        planFingerprint: fingerprint,
        contextPlanFingerprint: context.plan.planFingerprint,
      },
    );
  }

  const journal = await observeJournal(evidence.journalPath, plan);
  const enqueue = deps.enqueueDeployment ?? defaultDeployEnqueue(deps);
  await enqueue(deployment.id);

  return {
    kind: "resume_requested",
    deploymentId: deployment.id,
    state: "UPLOAD_INTERRUPTED",
    stateVersion: deployment.stateVersion,
    queue: "deploy",
    approvalId: approval.approvalId,
    signerAddress: approval.signerAddress,
    journalPath: evidence.journalPath,
    journalComplete: journal.complete,
    unresolvedWrites: journal.unresolvedWrites,
    progress: evidence.progress,
    recovery: context,
    contextSource: evidence.facts.context === "stored" ? "stored" : "derived",
  };
}

/**
 * The production enqueue path. Identical in shape to `POST /v1/deployments/:id/execute`
 * so both entries land on the same BullMQ queue and the same worker handler.
 */
function defaultDeployEnqueue(deps: ApiDeps): (deploymentId: string) => Promise<void> {
  return async (deploymentId: string): Promise<void> => {
    const queues = createDeploymentQueues({ redisUrl: deps.env.redisUrl });
    try {
      await enqueueDeployment(queues.deploy, deploymentId);
    } finally {
      await queues.close();
    }
  };
}

// ---------------------------------------------------------------------------
// 6. requestReapproval (§12.2)
// ---------------------------------------------------------------------------

/** Where the client goes next; the same two endpoints the first approval uses. */
export interface ReapprovalNextSteps {
  readonly approvalPayload: string;
  readonly approve: string;
  readonly execute: string;
}

/**
 * `201`-shaped result: a continuation attempt in `AWAITING_APPROVAL`. `created`
 * is false on an idempotent replay of the same reapproval.
 */
export interface ReapprovalRequested {
  readonly kind: "reapproval_requested";
  /** The attempt to sign; equal to the superseded id only if it never left plan state. */
  readonly deploymentId: string;
  readonly supersededDeploymentId: string;
  readonly state: "AWAITING_APPROVAL";
  readonly stateVersion: number;
  readonly created: boolean;
  readonly revokedApprovals: number;
  readonly revokedOperatorSessions: number;
  readonly previousAttemptRetired: boolean;
  readonly approvalRequest: {
    readonly manifestSha256: string;
    readonly containerAddress: string;
    readonly estimatedCostWei: string | null;
    /** The nonce belongs to the payload the wallet signs, so only that endpoint mints it. */
    readonly nonceSource: "approval_payload_endpoint";
  };
  readonly recovery: RecoveryContext;
  readonly next: ReapprovalNextSteps;
}

export type ReapprovalResult = ReapprovalRequested | RecoveryBlocked;

/**
 * Public reapproval entry (§12.2). Re-checks role, owner, plan summary, budget
 * and implementation version, revokes the old authorization, and returns the
 * attempt to `AWAITING_APPROVAL` with the recovery context intact.
 */
export async function requestReapproval(
  deps: ApiDeps,
  input: RecoveryRequest,
): Promise<ReapprovalResult> {
  const now = deps.now?.() ?? new Date();
  const { deployment, role } = await requireDeploymentAccess(deps, input);

  // §12.2 replay (P7-18): if this attempt already opened a continuation, report THAT one
  // rather than refusing. The old row is `CANCELED` by then, so the capability check below
  // would answer `NOT_RECOVERABLE` — which is true of the source and useless to a caller
  // who simply retried a request that succeeded. Idempotency is the contract here.
  const replay = await findContinuationAttempt(deps, deployment.id);
  if (replay !== null) {
    // Report the stored fields of the continuation, not freshly derived ones: a replay must
    // answer with what the first call produced, or the two responses would disagree.
    let storedContext = await readRecoveryContext(deps.db, replay.id);
    if (storedContext.kind === "missing") {
      // P7-19: a crash between the successor INSERT and the context UPDATE leaves this row
      // context-less. Repairing it here is the difference between a recoverable retry and a
      // permanently broken attempt, and the replay path is exactly where a retry lands — so
      // repair BEFORE deciding this is a fault.
      await repairContinuationContext(deps, deployment, replay.id, now);
      storedContext = await readRecoveryContext(deps.db, replay.id);
    }
    if (storedContext.kind !== "found") {
      // Present but unparseable is still a real fault: refuse rather than hand back a
      // context we cannot vouch for.
      throw new ApiError(
        409,
        "PLAN_STALE",
        "the continuation attempt exists but its recovery context cannot be read",
        { deploymentId: replay.id, reason: "recovery_context_unreadable" },
      );
    }
    return {
      kind: "reapproval_requested",
      deploymentId: replay.id,
      supersededDeploymentId: deployment.id,
      state: "AWAITING_APPROVAL",
      stateVersion: replay.stateVersion,
      created: false,
      revokedApprovals: 0,
      revokedOperatorSessions: 0,
      previousAttemptRetired: true,
      approvalRequest: {
        manifestSha256: replay.manifestSha256 ?? "",
        containerAddress: replay.containerAddress,
        estimatedCostWei: replay.estimatedCostWei,
        nonceSource: "approval_payload_endpoint",
      },
      recovery: storedContext.context,
      next: {
        approvalPayload: `/v1/deployments/${replay.id}/approval-payload`,
        approve: `/v1/deployments/${replay.id}/approve`,
        execute: `/v1/deployments/${replay.id}/execute`,
      },
    };
  }

  const evidence = await collectEvidence(deps, deployment, now);
  const capability = recoveryCapability(evidence.facts);
  if (capability.action !== "reapproval") return blocked(deployment, capability);

  const plan = evidence.plan;
  if (plan === null) {
    // Capability only answers `reapproval` for a present, rehydratable plan.
    throw new ApiError(409, "PLAN_STALE", "the stored plan cannot be rehydrated; a new deployment is required", {
      reason: "plan_unreadable",
      deploymentId: deployment.id,
    });
  }
  await recheckReapprovalPreconditions(deps, deployment, plan, role);

  const context = contextFromEvidence(evidence, plan, now, deployment.id);
  const successor = await openContinuationAttempt(deps, deployment, context, input.userId, now);
  const revocation = await revokePreviousAuthorization(deps, deployment.id, deployment.containerId, now);
  const retired = await retirePreviousAttempt(
    deps,
    deployment,
    successor.deployment.id,
    input.userId,
  );

  return {
    kind: "reapproval_requested",
    deploymentId: successor.deployment.id,
    supersededDeploymentId: deployment.id,
    state: "AWAITING_APPROVAL",
    stateVersion: successor.deployment.stateVersion,
    created: successor.created,
    revokedApprovals: revocation.approvals,
    revokedOperatorSessions: revocation.operatorSessions,
    previousAttemptRetired: retired,
    approvalRequest: {
      manifestSha256: successor.deployment.manifestSha256 ?? "",
      containerAddress: successor.containerAddress,
      estimatedCostWei: successor.deployment.estimatedCostWei,
      nonceSource: "approval_payload_endpoint",
    },
    recovery: context,
    next: {
      approvalPayload: `/v1/deployments/${successor.deployment.id}/approval-payload`,
      approve: `/v1/deployments/${successor.deployment.id}/approve`,
      execute: `/v1/deployments/${successor.deployment.id}/execute`,
    },
  };
}

/**
 * §12.2's checklist before the server re-issues a signature. Each check answers a
 * different question and each has its own error, because the user fixes them in
 * different places:
 *
 * - role: the approval policy role the project currently requires;
 * - owner: the container owner the stored plan was made under;
 * - plan summary: the plan is still an approvable, non-blocked plan;
 * - budget: the project and organization caps still cover the stored estimate;
 * - implementation version: the allowlist is unchanged (§红线).
 */
async function recheckReapprovalPreconditions(
  deps: ApiDeps,
  deployment: typeof deployments.$inferSelect,
  plan: ReleasePlan,
  role: string,
): Promise<void> {
  const [policy] = await deps.db
    .select()
    .from(approvalPolicies)
    .where(eq(approvalPolicies.projectId, deployment.projectId))
    .limit(1);
  const requiredRole = policy?.requiredRole ?? "owner";
  if (!roleSatisfies(role, requiredRole)) {
    throw new ApiError(403, "APPROVAL_POLICY_ROLE", `approval requires the ${requiredRole} role`);
  }

  const [container] = await deps.db
    .select()
    .from(containers)
    .where(eq(containers.id, deployment.containerId))
    .limit(1);
  if (container === undefined) {
    throw new ApiError(500, "INTERNAL", "deployment container missing");
  }
  const plannedOwner = plan.containerOwner;
  const observedOwner = container.lastObservedOwner;
  if (
    plannedOwner !== null &&
    observedOwner !== null &&
    plannedOwner.toLowerCase() !== observedOwner.toLowerCase()
  ) {
    throw new ApiError(
      409,
      "NOT_CURRENT_OWNER",
      "the container owner changed after the plan was approved; a new plan is required",
      {
        reason: "ownership_changed",
        plannedOwner,
        observedOwner,
        deploymentId: deployment.id,
      },
    );
  }

  if (deployment.manifestSha256 === null || deployment.manifestSha256 !== plan.releaseManifestHash) {
    throw new ApiError(
      409,
      "PLAN_STALE",
      "the stored plan does not match the deployment manifest; a new deployment is required",
      {
        reason: "plan_manifest_mismatch",
        deploymentId: deployment.id,
        manifestSha256: deployment.manifestSha256,
        planManifestHash: plan.releaseManifestHash,
      },
    );
  }
  if (plan.blocked) {
    const reason = plan.blockedReasons[0];
    if (reason === "FEE_OVER_BUDGET") {
      throw new ApiError(409, "FEE_OVER_BUDGET", "the stored plan is over the approved fee cap", {
        reason: "plan_blocked",
        blockedReasons: plan.blockedReasons,
      });
    }
    if (reason === "INSUFFICIENT_BALANCE") {
      throw new ApiError(402, "INSUFFICIENT_BALANCE", "the stored plan is over the operator balance", {
        reason: "plan_blocked",
        blockedReasons: plan.blockedReasons,
      });
    }
    throw new ApiError(409, "UPLOAD_CONFLICT", "the stored plan is blocked; a new plan is required", {
      reason: "plan_blocked",
      blockedReasons: plan.blockedReasons,
    });
  }

  const estimated = weiOf(deployment.estimatedCostWei);
  const [budget] = await deps.db
    .select()
    .from(projectBudgets)
    .where(eq(projectBudgets.projectId, deployment.projectId))
    .limit(1);
  if (budget?.monthlyCapWei !== null && budget?.monthlyCapWei !== undefined) {
    const spent = await monthlySpendWei(deps, deployment.projectId);
    if (spent + estimated > BigInt(budget.monthlyCapWei)) {
      throw new ApiError(409, "BUDGET_EXCEEDED", "monthly project budget would be exceeded", {
        reason: "budget_exceeded",
        spentWei: spent.toString(),
        estimatedCostWei: estimated.toString(),
        monthlyCapWei: budget.monthlyCapWei,
      });
    }
  }
  const [projectRow] = await deps.db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .where(eq(projects.id, deployment.projectId))
    .limit(1);
  if (projectRow?.organizationId !== null && projectRow?.organizationId !== undefined) {
    const orgBudget = await organizationBudgetStatus(deps, projectRow.organizationId);
    if (orgBudget.capWei !== null && orgBudget.spentWei + estimated > orgBudget.capWei) {
      throw new ApiError(409, "ORGANIZATION_BUDGET_EXCEEDED", "organization monthly budget would be exceeded", {
        reason: "organization_budget_exceeded",
        spentWei: orgBudget.spentWei.toString(),
        estimatedCostWei: estimated.toString(),
      });
    }
  }

  await assertImplementationVersionUnchanged(deps);
}

/**
 * Carry (or derive) the recovery context.
 *
 * - stored context: keep its plan summary and **journal identity**, so a
 *   reapproval chain always points at the journal that holds the half-written
 *   attempt — never at the newest row;
 * - no stored context: derive the same summary from `plan_json` and key the
 *   journal by this attempt's own id (the deterministic `<id>.jsonl`).
 *
 * `supersededDeploymentId` is the attempt this context is being carried *from*:
 * `null` when the caller is only reading (resume), the previous attempt's id when
 * a successor is opened.
 */
function contextFromEvidence(
  evidence: AttemptEvidence,
  plan: ReleasePlan,
  now: Date,
  supersededDeploymentId: string | null,
): RecoveryContext {
  const summary = planSummaryOf(plan);
  const stored = evidence.context.kind === "found" ? evidence.context.context : null;
  return {
    schemaVersion: RECOVERY_CONTEXT_SCHEMA_VERSION,
    plan: stored?.plan ?? summary,
    // `planToJson` is the JSON-safe form of the rehydrated plan (bigints as
    // decimal strings), so the stored document always round-trips.
    planJson: planToJson(plan),
    journal: stored?.journal ?? {
      deploymentId: evidence.deployment.id,
      planFingerprint: summary.planFingerprint,
    },
    stage: recoveryStageFor(evidence.deployment.state, evidence.progress),
    supersededDeploymentId: supersededDeploymentId ?? stored?.supersededDeploymentId ?? null,
    recordedAt: now.toISOString(),
  };
}

interface ContinuationAttempt {
  readonly deployment: typeof deployments.$inferSelect;
  readonly created: boolean;
  readonly containerAddress: string;
}

/**
 * Open (or find) the successor attempt at `AWAITING_APPROVAL`.
 *
 * `plan_json`, the artifact identity and the manifest are copied verbatim — the
 * point of §12.2 is that a recoverable plan is not re-derived from the current
 * chain. `source_event_key` makes a retry idempotent; `on_conflict_do_nothing`
 * mirrors the rollback endpoint's pattern.
 */
/**
 * Rebuild and persist the recovery context of a continuation that lost it (P7-19).
 *
 * The context is derived from the SOURCE attempt — evidence, plan, journal identity — so a
 * repair reproduces exactly what the original request would have written, rather than
 * something re-derived from current chain state (§12.2 forbids that).
 */
async function repairContinuationContext(
  deps: ApiDeps,
  source: typeof deployments.$inferSelect,
  continuationId: string,
  now: Date,
): Promise<void> {
  const evidence = await collectEvidence(deps, source, now);
  const plan = evidence.plan;
  if (plan === null) {
    throw new ApiError(
      409,
      "PLAN_STALE",
      "the continuation attempt lost its recovery context and the source plan cannot be rehydrated",
      { deploymentId: continuationId, reason: "plan_unreadable" },
    );
  }
  const context = contextFromEvidence(evidence, plan, now, source.id);
  await deps.db
    .update(deployments)
    .set({ recoveryContext: context, updatedAt: now })
    .where(eq(deployments.id, continuationId));
}

async function openContinuationAttempt(
  deps: ApiDeps,
  previous: typeof deployments.$inferSelect,
  context: RecoveryContext,
  userId: string,
  now: Date,
): Promise<ContinuationAttempt> {
  const [container] = await deps.db
    .select()
    .from(containers)
    .where(eq(containers.id, previous.containerId))
    .limit(1);
  if (container === undefined) {
    throw new ApiError(500, "INTERNAL", "deployment container missing");
  }
  const sourceEventKey = `reapproval:${previous.id}`;
  const [created] = await deps.db
    .insert(deployments)
    .values({
      projectId: previous.projectId,
      containerId: previous.containerId,
      createdByUserId: userId,
      // The trigger-kind check allows webhook|manual|rollback and has no
      // `reapproval` value; "manual" is the honest one (a user asked for this
      // attempt). The provenance is recorded in the recovery context and in the
      // `reapproval_opened` event below, so it is not lost.
      triggerKind: "manual",
      commitSha: previous.commitSha,
      state: "AWAITING_APPROVAL",
      targetChainId: previous.targetChainId,
      registryAddress: previous.registryAddress,
      artifactSha256: previous.artifactSha256,
      artifactStorageKey: previous.artifactStorageKey,
      prepared_artifact_key: previous.prepared_artifact_key,
      preparation_request: previous.preparation_request,
      manifestSha256: previous.manifestSha256,
      planJson: previous.planJson,
      // The approved cap belongs to the (revoked) approval, not to the attempt.
      estimatedCostWei: previous.estimatedCostWei,
      sourceEventKey,
      requestedAt: now,
    })
    .onConflictDoNothing({ target: deployments.sourceEventKey })
    .returning();

  if (created === undefined) {
    const [existing] = await deps.db
      .select()
      .from(deployments)
      .where(eq(deployments.sourceEventKey, sourceEventKey))
      .limit(1);
    if (existing === undefined) {
      throw new ApiError(500, "INTERNAL", "the continuation attempt could not be read back");
    }
    // A crash between the INSERT above and the recovery-context UPDATE below would
    // leave a continuation with no context, and a retry would take this branch and never
    // write it — so the worker would then re-plan a half-written release (P7-19). Repair
    // it here instead of trusting that the first attempt completed.
    if (existing.recoveryContext === null) {
      await deps.db
        .update(deployments)
        .set({ recoveryContext: context, updatedAt: now })
        .where(eq(deployments.id, existing.id));
    }
    return { deployment: existing, created: false, containerAddress: container.containerAddress };
  }

  // The column is the worker's source of truth (§12.2); the event below is the audit
  // trail. Writing both means a reader never has to reconstruct one from the other.
  await deps.db
    .update(deployments)
    .set({ recoveryContext: context, updatedAt: now })
    .where(eq(deployments.id, created.id));
  await deps.db.insert(deploymentEvents).values({
    deploymentId: created.id,
    oldState: null,
    newState: "AWAITING_APPROVAL",
    eventType: REAPPROVAL_OPENED_EVENT,
    actorKind: "user",
    actorId: userId,
    payload: {
      // Provenance only: the plan itself already lives in `plan_json` and in the
      // recovery_context column, so copying it into the event would triple a
      // document that can carry every planned file.
      supersededDeploymentId: previous.id,
      planFingerprint: context.plan.planFingerprint,
      journalDeploymentId: context.journal.deploymentId,
      stage: context.stage,
      plan: context.plan,
    },
  });
  await copyReleaseFileProgress(deps, previous.id, created.id, now);
  return { deployment: created, created: true, containerAddress: container.containerAddress };
}

/**
 * Clone the plan-derived file rows so the successor's chunk progress is visible
 * and checkable (`GET /v1/deployments/:id` lists them). The rows describe the
 * same plan on the same on-chain release, so `state`/`lastConfirmedChunkIndex`
 * are recorded observations, not claims about new work.
 */
/**
 * The continuation attempt this deployment already opened, if any (§12.2 replay).
 *
 * Identity is the `source_event_key` the insert uses, so this cannot find a different
 * attempt that merely looks similar.
 */
async function findContinuationAttempt(
  deps: ApiDeps,
  previousId: string,
): Promise<{
  readonly id: string;
  readonly stateVersion: number;
  readonly manifestSha256: string | null;
  readonly containerAddress: string;
  readonly estimatedCostWei: string | null;
} | null> {
  const [row] = await deps.db
    .select({
      id: deployments.id,
      stateVersion: deployments.stateVersion,
      manifestSha256: deployments.manifestSha256,
      estimatedCostWei: deployments.estimatedCostWei,
      containerAddress: containers.containerAddress,
    })
    .from(deployments)
    .innerJoin(containers, eq(containers.id, deployments.containerId))
    .where(eq(deployments.sourceEventKey, `reapproval:${previousId}`))
    .limit(1);
  return row === undefined ? null : row;
}

async function copyReleaseFileProgress(
  deps: ApiDeps,
  fromDeploymentId: string,
  toDeploymentId: string,
  now: Date,
): Promise<void> {
  const rows = await deps.db
    .select()
    .from(releaseFiles)
    .where(eq(releaseFiles.deploymentId, fromDeploymentId));
  if (rows.length === 0) return;
  await deps.db
    .insert(releaseFiles)
    .values(
      rows.map((row) => ({
        deploymentId: toDeploymentId,
        targetPath: row.targetPath,
        sourceRelativePath: row.sourceRelativePath,
        sha256: row.sha256,
        byteSize: row.byteSize,
        chunkCount: row.chunkCount,
        contentType: row.contentType,
        state: row.state,
        lastConfirmedChunkIndex: row.lastConfirmedChunkIndex,
        verifiedAt: row.verifiedAt,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Revoke the old authorization before the new signature can exist. Every live
 * approval of the previous attempt is revoked, so a replayed old signature fails
 * (`revoked_at` is no longer null) and the nonce cannot be reused
 * (`approvals_nonce_key`). The next signature is minted by
 * `/approval-payload`, which is the only place a nonce is bound to the payload
 * the wallet signs — pre-minting one here would be an unbound value.
 *
 * Operator sessions are revoked for the whole container: the single chain-writer
 * partial index means no other deployment of this container can be mid-write, so
 * no legitimate grant is lost, and a lapsed grant must not outlive its approval.
 */
async function revokePreviousAuthorization(
  deps: ApiDeps,
  deploymentId: string,
  containerId: string,
  now: Date,
): Promise<{ readonly approvals: number; readonly operatorSessions: number }> {
  // Every approval that is not revoked yet, expired ones included: the record
  // should say "revoked", not merely "lapsed", once the attempt is superseded.
  const revocable = await deps.db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.deploymentId, deploymentId), isNull(approvals.revokedAt)));
  for (const row of revocable) {
    await revokeApproval(deps.db, row.id, now);
  }
  const sessions = await revokeOperatorSessionsForContainer(deps.db, containerId, now);
  return { approvals: revocable.length, operatorSessions: sessions };
}

/**
 * Retire the previous attempt so its chain-writer slot is free before the
 * successor can be approved. Only `APPROVED` and `UPLOAD_INTERRUPTED` are
 * reapprovable states with a live edge to `CANCELED`; a terminal state
 * (`APPROVAL_EXPIRED`) needs no retirement. In-flight states never reach here.
 */
async function retirePreviousAttempt(
  deps: ApiDeps,
  previous: typeof deployments.$inferSelect,
  successorDeploymentId: string,
  userId: string,
): Promise<boolean> {
  if (isTerminalState(previous.state)) return false;
  if (previous.state === "AWAITING_APPROVAL" || previous.state === "PLAN_READY") return false;
  await transitionDeployment(deps.db, {
    deploymentId: previous.id,
    expectedVersion: previous.stateVersion,
    toState: "CANCELED",
    eventType: "superseded_by_reapproval",
    actorKind: "user",
    actorId: userId,
    payload: { successorDeploymentId, reason: "reapproval_supersedes_attempt" },
  });
  return true;
}
