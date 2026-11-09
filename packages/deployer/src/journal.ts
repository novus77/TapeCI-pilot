import { mkdir, open as fsOpen, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { TapeCiError, canonicalJson, sha256HexOfString, type Hex } from "@tapeci/shared";
import type { ReleasePlan } from "./release-plan.js";

export const JOURNAL_SCHEMA_VERSION = 1 as const;
export type JournalSchemaVersion = typeof JOURNAL_SCHEMA_VERSION;

export type JournalEventType =
  | "plan"
  | "tx_intent"
  | "tx_sent"
  | "tx_mined"
  | "tx_failed"
  | "file_verified"
  | "deployment_complete"
  | "note";

interface JournalEventBase {
  readonly v: JournalSchemaVersion;
  readonly type: JournalEventType;
  readonly at: string;
}

export interface JournalPlanEvent extends JournalEventBase {
  readonly type: "plan";
  readonly deploymentId: string;
  readonly planFingerprint: Hex;
  readonly releaseManifestHash: Hex;
  readonly artifactDigest: Hex;
  readonly chainId: 196;
  readonly container: Hex;
  readonly siteRegistry: Hex;
  readonly commitSha: string;
  readonly releaseId: string;
  readonly entryPath: string;
  readonly pinnedBlockNumber: string;
  /** JSON-safe copy of the approved plan (audit only; never replayed as authority). */
  readonly planJson: unknown;
}

export interface JournalTxIntentEvent extends JournalEventBase {
  readonly type: "tx_intent";
  readonly deploymentId: string;
  readonly fingerprint: Hex;
  readonly operation: "putFile" | "appendChunk";
  readonly path: string;
  readonly chunkIndex: number;
  readonly nonce: string;
  readonly dataSha256: Hex;
  readonly dataBytes: number;
  readonly expectIndex: string | null;
}

export interface JournalTxSentEvent extends JournalEventBase {
  readonly type: "tx_sent";
  readonly deploymentId: string;
  readonly fingerprint: Hex;
  readonly txHash: Hex;
  readonly nonce: string;
}

export interface JournalTxMinedEvent extends JournalEventBase {
  readonly type: "tx_mined";
  readonly deploymentId: string;
  readonly fingerprint: Hex;
  readonly txHash: Hex;
  readonly blockNumber: string;
  readonly blockHash: Hex | null;
  readonly gasUsed: string;
}

export interface JournalTxFailedEvent extends JournalEventBase {
  readonly type: "tx_failed";
  readonly deploymentId: string;
  readonly fingerprint: Hex;
  readonly txHash: Hex | null;
  readonly nonce: string | null;
  readonly errorCode: string;
  readonly message: string;
}

export interface JournalFileVerifiedEvent extends JournalEventBase {
  readonly type: "file_verified";
  readonly deploymentId: string;
  readonly path: string;
  readonly sha256: Hex;
  readonly size: number;
  readonly status: "UPLOADED" | "UNCHANGED";
  readonly transactionCount: number;
  /** Block the verifying read was pinned at (decimal string). */
  readonly verifiedAtBlock?: string;
  /** RPC operators whose reads at `verifiedAtBlock` all matched. */
  readonly operators?: readonly string[];
  /**
   * True when this evidence was recorded after `deployment_complete` by a
   * read-only re-verification (resume / `tapeci verify --repair-journal`).
   */
  readonly recovered?: boolean;
}

export interface JournalCompleteEvent extends JournalEventBase {
  readonly type: "deployment_complete";
  readonly deploymentId: string;
  readonly releaseManifestHash: Hex;
  readonly verifiedFiles: number;
  readonly totalTransactions: number;
}

export interface JournalNoteEvent extends JournalEventBase {
  readonly type: "note";
  readonly deploymentId: string;
  readonly message: string;
}

export type JournalEvent =
  | JournalPlanEvent
  | JournalTxIntentEvent
  | JournalTxSentEvent
  | JournalTxMinedEvent
  | JournalTxFailedEvent
  | JournalFileVerifiedEvent
  | JournalCompleteEvent
  | JournalNoteEvent;

export type JournalEventInput =
  | Omit<JournalPlanEvent, "v" | "at">
  | Omit<JournalTxIntentEvent, "v" | "at">
  | Omit<JournalTxSentEvent, "v" | "at">
  | Omit<JournalTxMinedEvent, "v" | "at">
  | Omit<JournalTxFailedEvent, "v" | "at">
  | Omit<JournalFileVerifiedEvent, "v" | "at">
  | Omit<JournalCompleteEvent, "v" | "at">
  | Omit<JournalNoteEvent, "v" | "at">;

export interface JournalTransactionRecord {
  readonly fingerprint: Hex;
  readonly intent: JournalTxIntentEvent;
  readonly sent?: JournalTxSentEvent;
  readonly mined?: JournalTxMinedEvent;
  readonly failed?: JournalTxFailedEvent;
}

export interface JournalState {
  readonly plan: JournalPlanEvent | null;
  readonly deploymentId: string | null;
  readonly transactions: ReadonlyMap<string, JournalTransactionRecord>;
  readonly verifiedFiles: ReadonlyMap<string, JournalFileVerifiedEvent>;
  readonly complete: boolean;
  readonly events: readonly JournalEvent[];
}

interface MutableState {
  plan: JournalPlanEvent | null;
  deploymentId: string | null;
  transactions: Map<string, JournalTransactionRecord>;
  verifiedFiles: Map<string, JournalFileVerifiedEvent>;
  complete: boolean;
  events: JournalEvent[];
}

function emptyState(): MutableState {
  return {
    plan: null,
    deploymentId: null,
    transactions: new Map(),
    verifiedFiles: new Map(),
    complete: false,
    events: [],
  };
}

/** Deterministic journal/deployment id: commit + content digest. */
export function deriveDeploymentId(
  plan: Pick<ReleasePlan, "commitSha" | "artifactDigest">,
): string {
  return `dep-${plan.commitSha.slice(0, 12)}-${plan.artifactDigest.slice(2, 10)}`;
}

/**
 * Content fingerprint of the approved plan. A resume must match exactly; a new
 * plan (different manifest/container) is `PLAN_STALE`, never silently merged.
 */
export function planFingerprint(
  plan: Pick<
    ReleasePlan,
    | "schemaVersion"
    | "chainId"
    | "container"
    | "siteRegistry"
    | "commitSha"
    | "releaseId"
    | "artifactDigest"
    | "releaseManifestHash"
  >,
): Hex {
  return sha256HexOfString(
    canonicalJson({
      schemaVersion: plan.schemaVersion,
      chainId: plan.chainId,
      container: plan.container.toLowerCase(),
      siteRegistry: plan.siteRegistry.toLowerCase(),
      commitSha: plan.commitSha,
      releaseId: plan.releaseId,
      artifactDigest: plan.artifactDigest.toLowerCase(),
      releaseManifestHash: plan.releaseManifestHash.toLowerCase(),
    }),
  );
}

function fail(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new TapeCiError("UPLOAD_INTERRUPTED", message, { retryable: false, details });
}

function parseEvent(line: string, lineNumber: number): JournalEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    fail(`journal line ${lineNumber} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) fail(`journal line ${lineNumber} is not an object`);
  const record = parsed as Record<string, unknown>;
  if (record.v !== JOURNAL_SCHEMA_VERSION) {
    fail(`journal line ${lineNumber} has unsupported schema version ${String(record.v)}`);
  }
  const type = record.type;
  if (
    type !== "plan" &&
    type !== "tx_intent" &&
    type !== "tx_sent" &&
    type !== "tx_mined" &&
    type !== "tx_failed" &&
    type !== "file_verified" &&
    type !== "deployment_complete" &&
    type !== "note"
  ) {
    fail(`journal line ${lineNumber} has unknown event type ${String(type)}`);
  }
  if (typeof record.at !== "string") fail(`journal line ${lineNumber} is missing "at"`);
  return parsed as JournalEvent;
}

function requireString(record: Record<string, unknown>, field: string, lineNumber: number): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    fail(`journal line ${lineNumber} has invalid "${field}"`);
  }
  return value;
}

/**
 * The only event allowed after `deployment_complete`: a `recovered` file_verified
 * for a path that has no verification yet, pinned at a block at or above every
 * mined write for that path. Anything else after completion stays an error.
 */
function isRecoveredVerification(state: MutableState, event: JournalEvent): boolean {
  if (event.type !== "file_verified" || event.recovered !== true) return false;
  if (typeof event.path !== "string" || state.verifiedFiles.has(event.path)) return false;
  if (typeof event.verifiedAtBlock !== "string" || !/^[0-9]+$/.test(event.verifiedAtBlock)) return false;
  const pin = BigInt(event.verifiedAtBlock);
  let minedForPath = 0;
  for (const record of state.transactions.values()) {
    if (record.intent.path !== event.path) continue;
    if (record.mined === undefined) return false;
    if (BigInt(record.mined.blockNumber) > pin) return false;
    minedForPath += 1;
  }
  if (event.status === "UPLOADED") return minedForPath > 0 && event.transactionCount === minedForPath;
  return event.status === "UNCHANGED" && minedForPath === 0 && event.transactionCount === 0;
}

function applyEvent(state: MutableState, event: JournalEvent, lineNumber: number): void {
  if (event.type === "plan") {
    if (state.plan !== null) fail(`journal has more than one plan event (line ${lineNumber})`);
    if (event.chainId !== 196) fail(`journal plan has unsupported chainId ${String(event.chainId)}`);
    requireString(event as unknown as Record<string, unknown>, "deploymentId", lineNumber);
    requireString(event as unknown as Record<string, unknown>, "planFingerprint", lineNumber);
    state.plan = event;
    state.deploymentId = event.deploymentId;
    state.events.push(event);
    return;
  }
  if (state.plan === null) fail(`journal event ${event.type} appears before the plan event`);
  if (state.complete && !isRecoveredVerification(state, event)) {
    fail(`journal has events after deployment_complete (line ${lineNumber})`);
  }
  const deploymentId = (event as unknown as { deploymentId?: unknown }).deploymentId;
  if (typeof deploymentId !== "string" || deploymentId !== state.deploymentId) {
    fail(`journal line ${lineNumber} belongs to a different deployment`);
  }

  switch (event.type) {
    case "tx_intent": {
      requireString(event as unknown as Record<string, unknown>, "fingerprint", lineNumber);
      if (state.transactions.has(event.fingerprint)) {
        fail(`journal has a duplicate tx_intent fingerprint ${event.fingerprint}`);
      }
      state.transactions.set(event.fingerprint, { fingerprint: event.fingerprint, intent: event });
      break;
    }
    case "tx_sent": {
      requireString(event as unknown as Record<string, unknown>, "fingerprint", lineNumber);
      requireString(event as unknown as Record<string, unknown>, "txHash", lineNumber);
      const record = state.transactions.get(event.fingerprint);
      if (record === undefined) fail(`tx_sent for unknown fingerprint ${event.fingerprint}`);
      if (record.sent !== undefined) fail(`duplicate tx_sent for ${event.fingerprint}`);
      if (record.intent.nonce !== event.nonce) {
        fail(`tx_sent nonce ${event.nonce} does not match intent nonce ${record.intent.nonce}`);
      }
      state.transactions.set(event.fingerprint, { ...record, sent: event });
      break;
    }
    case "tx_mined": {
      requireString(event as unknown as Record<string, unknown>, "fingerprint", lineNumber);
      const record = state.transactions.get(event.fingerprint);
      if (record === undefined) fail(`tx_mined for unknown fingerprint ${event.fingerprint}`);
      if (record.sent === undefined) fail(`tx_mined before tx_sent for ${event.fingerprint}`);
      if (record.sent.txHash.toLowerCase() !== event.txHash.toLowerCase()) {
        fail(`tx_mined hash does not match the sent transaction for ${event.fingerprint}`);
      }
      if (record.mined !== undefined) fail(`duplicate tx_mined for ${event.fingerprint}`);
      state.transactions.set(event.fingerprint, { ...record, mined: event });
      break;
    }
    case "tx_failed": {
      requireString(event as unknown as Record<string, unknown>, "fingerprint", lineNumber);
      const record = state.transactions.get(event.fingerprint);
      if (record === undefined) fail(`tx_failed for unknown fingerprint ${event.fingerprint}`);
      if (record.mined !== undefined) fail(`tx_failed after tx_mined for ${event.fingerprint}`);
      if (record.failed !== undefined) fail(`duplicate tx_failed for ${event.fingerprint}`);
      state.transactions.set(event.fingerprint, { ...record, failed: event });
      break;
    }
    case "file_verified": {
      requireString(event as unknown as Record<string, unknown>, "path", lineNumber);
      state.verifiedFiles.set(event.path, event);
      break;
    }
    case "deployment_complete":
      state.complete = true;
      break;
    case "note":
      break;
  }
  state.events.push(event);
}

function replay(text: string): MutableState {
  const state = emptyState();
  if (text.length === 0) return state;
  const complete = text.endsWith("\n");
  const lines = text.split("\n");
  if (complete) lines.pop();
  const lastIndex = lines.length - 1;
  for (let index = 0; index <= lastIndex; index += 1) {
    const line = lines[index];
    if (line === undefined || line === "") continue;
    if (!complete && index === lastIndex) {
      // A crash during append can leave a partial trailing line. Drop it: it was
      // never fsynced as a complete event, so replaying it would be unsafe.
      break;
    }
    const event = parseEvent(line, index + 1);
    applyEvent(state, event, index + 1);
  }
  return state;
}

export interface OpenJournalOptions {
  /** Take an exclusive `<journal>.lock` (default true). */
  readonly lock?: boolean;
  /** Remove a lock older than this many ms (default 10 min). */
  readonly staleLockMs?: number;
}

async function acquireLock(lockPath: string, staleLockMs: number): Promise<void> {
  try {
    const handle = await fsOpen(lockPath, "wx");
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
    await handle.close();
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
  }
  const info = await stat(lockPath).catch(() => null);
  if (info !== null && Date.now() - info.mtimeMs > staleLockMs) {
    await unlink(lockPath).catch(() => undefined);
    return acquireLock(lockPath, staleLockMs);
  }
  throw new TapeCiError("UPLOAD_INTERRUPTED", `journal is locked by another process: ${lockPath}`, {
    details: { lockPath },
  });
}

/**
 * Append-only, crash-tolerant deployment journal (JSONL, fsync per event).
 *
 * The chain is the only authority for on-chain progress. The journal exists to
 * reconstruct intent, nonces and transaction hashes after a restart, so a retry
 * can reconcile instead of blindly appending the same chunk again (PRD §6.3).
 */
export class DeploymentJournal {
  private readonly lockPath: string | null;
  private readonly handle: FileHandle;
  private readonly stateValue: MutableState;
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    lockPath: string | null,
    handle: FileHandle,
    state: MutableState,
  ) {
    this.lockPath = lockPath;
    this.handle = handle;
    this.stateValue = state;
  }

  static async open(path: string, options: OpenJournalOptions = {}): Promise<DeploymentJournal> {
    await mkdir(dirname(path), { recursive: true });
    const useLock = options.lock ?? true;
    const lockPath = useLock ? `${path}.lock` : null;
    if (lockPath !== null) {
      await acquireLock(lockPath, options.staleLockMs ?? 10 * 60_000);
    }
    try {
      const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      const state = replay(existing);
      const hasPartialTail = existing.length > 0 && !existing.endsWith("\n");
      const handle = await fsOpen(path, "a");
      if (hasPartialTail) {
        // Remove the crash-truncated last line so a later replay does not see it as
        // a complete (but invalid) event.
        const keep = existing.slice(0, existing.lastIndexOf("\n") + 1);
        await handle.truncate(Buffer.byteLength(keep, "utf8"));
      }
      return new DeploymentJournal(lockPath, handle, state);
    } catch (error) {
      if (lockPath !== null) await unlink(lockPath).catch(() => undefined);
      throw error;
    }
  }

  get state(): JournalState {
    return this.stateValue;
  }

  /** Highest nonce consumed by a mined (success or reverted) transaction. */
  maxConsumedNonce(): bigint | null {
    let max: bigint | null = null;
    for (const record of this.stateValue.transactions.values()) {
      const consumed =
        record.mined !== undefined ||
        (record.failed !== undefined && record.failed.txHash !== null);
      if (!consumed) continue;
      const nonce = BigInt(record.intent.nonce);
      if (max === null || nonce > max) max = nonce;
    }
    return max;
  }

  /** Transactions that were sent but never reached a terminal event. */
  unresolvedTransactions(): JournalTransactionRecord[] {
    return [...this.stateValue.transactions.values()].filter(
      (record) => record.sent !== undefined && record.mined === undefined && record.failed === undefined,
    );
  }

  private previewState(): MutableState {
    return {
      ...this.stateValue,
      transactions: new Map(
        [...this.stateValue.transactions].map(([key, value]) => [key, { ...value }]),
      ),
      verifiedFiles: new Map(this.stateValue.verifiedFiles),
      events: [...this.stateValue.events],
    };
  }

  async append(input: JournalEventInput): Promise<JournalEvent> {
    if (this.closed) throw new TapeCiError("INTERNAL", "journal is closed");
    const previous = this.writeQueue;
    let release!: () => void;
    this.writeQueue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const event = {
        v: JOURNAL_SCHEMA_VERSION,
        at: new Date().toISOString(),
        ...input,
      } as JournalEvent;
      if (event.type !== "plan" && event.deploymentId !== this.stateValue.deploymentId) {
        throw new TapeCiError("INTERNAL", "journal event belongs to a different deployment");
      }
      // Validate against a copy first: a rejected event must never be durably
      // written to the journal (that would corrupt every future replay).
      const preview = this.previewState();
      applyEvent(preview, event, this.stateValue.events.length + 1);
      const line = `${JSON.stringify(event)}\n`;
      await this.handle.write(line, null, "utf8");
      await this.handle.sync();
      // Apply only after the event is durable; a write failure leaves state unchanged.
      applyEvent(this.stateValue, event, this.stateValue.events.length + 1);
      return event;
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writeQueue.catch(() => undefined);
    await this.handle.close().catch(() => undefined);
    if (this.lockPath !== null) await unlink(this.lockPath).catch(() => undefined);
  }
}

/** Replay a journal file without taking the lock (read-only inspection / evidence). */
export async function readJournalState(path: string): Promise<JournalState> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return replay(text);
}
