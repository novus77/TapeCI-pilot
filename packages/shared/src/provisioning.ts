/**
 * Provisioning DTOs — SPEC §5 (frozen field names) plus the three objects §5 describes
 * in prose (quote, step, task) and the recorded transaction attempt.
 *
 * Rules encoded here:
 * - Every wei amount, gas value and block number is a base-10 string; nothing here is
 *   ever converted through `Number` (§2, §13).
 * - `null` means unknown, never `false` and never zero (§5). A zero-wei line is `"0"`.
 * - A quote is immutable once issued; a re-quote creates a new quote and the task's
 *   `currentQuoteId` moves while already-confirmed steps keep their original quote (§6).
 * - Errors are machine codes for the page to localize; provider prose is not an
 *   instruction to the user (§5, §13).
 */

import type { ResourceRef } from "./resources.js";

export type PreparationStepState =
  | "waiting"
  | "awaiting_signature"
  | "submitted"
  | "external_pending"
  | "confirmed"
  | "failed"
  | "skipped";

export type PreparationTaskState =
  | "waiting_user"
  | "running"
  | "needs_action"
  | "completed"
  | "canceled";

/**
 * The resource-acquiring action a step performs. §5 froze the field name `kind` but not
 * the union; it is read as the action kinds of `PreparationPrice["kind"]` minus
 * `service` and `gas`, which are price lines rather than steps.
 */
export type PreparationStepKind = "acquisition" | "open" | "activation";

export interface PreparationPrice {
  kind: "acquisition" | "open" | "activation" | "service" | "gas";
  currency: "OKB";
  amountWei: string | null;
  estimated: boolean;
  payer: `0x${string}`;
  payee: `0x${string}` | null;
}

export interface PreparedStepTransaction {
  intentId: string;
  taskId: string;
  stepId: string;
  quoteId: string;
  chainId: 196;
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  /**
   * The most native value this step may send (SPEC §7.2). For a built-in `open`
   * step it equals `value`, because the opener fee is fixed; a source with variable
   * pricing would set it above `value`. Recorded so a send above the accepted cap
   * can be recognised and re-confirmed instead of silently honoured.
   */
  maxValueWei: string;
  data: `0x${string}`;
  gasLimit: string;
  gasPriceWei: string;
  maxGasCostWei: string;
  expiresAt: string;
}

export type PreparedStepAction =
  | { kind: "transaction"; transaction: PreparedStepTransaction }
  | {
      kind: "external";
      intentId: string;
      taskId: string;
      stepId: string;
      quoteId: string;
      sourceId: string;
      externalReference: string;
      url: string;
      expiresAt: string;
    };

export interface PreparationQuoteStep {
  id: string;
  ordinal: number;
  kind: PreparationStepKind;
  /** `null` while an acquisition step has not yet resolved a tokenId (§9.3). */
  resource: ResourceRef | null;
  prices: PreparationPrice[];
}

export interface PreparationQuote {
  id: string;
  userId: string;
  recipient: `0x${string}`;
  chainId: 196;
  /** Verified offer source, or the built-in source for `open`; never a user input. */
  sourceId: string;
  /** Exactly one of `offerId` / `resource` is set; acquisition and an existing resource are mutually exclusive (§7.2). */
  offerId: string | null;
  resource: ResourceRef | null;
  steps: PreparationQuoteStep[];
  /** Every line the user must accept, including `service` and `gas` estimates. */
  prices: PreparationPrice[];
  /** Block the quote was priced and re-read against; a payable quote always has one. */
  observedBlock: string;
  /** RFC 3339 instant; the earlier of the source and platform expiry (§7.2). */
  expiresAt: string;
  /** Opaque terms revision the user accepted; never parsed as a number. */
  termsVersion: string;
}

/**
 * A recorded sending attempt. The intent itself is the frozen `PreparedStepTransaction`;
 * this is the observed outcome, so `txHash` stays `null` until the wallet returns a hash.
 */
export interface PreparationTransactionResult {
  id: string;
  intentId: string;
  chainId: 196;
  from: `0x${string}`;
  to: `0x${string}`;
  valueWei: string;
  /** `null` while the user has broadcast without handing back a hash (§3.3). */
  txHash: `0x${string}` | null;
  /** `unresolved` covers pending, RPC-invisible, divergent and replaced-by-unknown cases (§9.1, §9.2). */
  status: "submitted" | "confirmed" | "failed" | "unresolved";
  blockNumber: string | null;
  blockHash: `0x${string}` | null;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  /** Set when this attempt replaced an earlier attempt of the same sender and nonce. */
  replacementFor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PreparationStep {
  id: string;
  ordinal: number;
  kind: PreparationStepKind;
  state: PreparationStepState;
  /** `null` when the step's resource is not yet known, e.g. an unresolved acquisition. */
  resource: ResourceRef | null;
  quoteId: string;
  /** Set once a sending or external intent exists; repeated prepare returns the same one (§7.3). */
  intentId: string | null;
  transactions: PreparationTransactionResult[];
  /** Machine code, localized by the page; `null` when there is nothing to explain. */
  errorCode: string | null;
  retryable: boolean;
  /** Machine code naming the user's next step; `null` when none is offered. */
  nextAction: string | null;
}

export interface PreparationTask {
  id: string;
  state: PreparationTaskState;
  recipient: `0x${string}`;
  chainId: 196;
  initialQuoteId: string;
  currentQuoteId: string;
  /** Optimistic-concurrency token sent back as `expectedVersion` (§7.3). */
  version: number;
  steps: PreparationStep[];
  createdAt: string;
  updatedAt: string;
}
