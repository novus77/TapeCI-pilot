import type { Hex } from "viem";
import type { ReadClient } from "@tapeci/chain";
import { TapeCiError } from "@tapeci/shared";
import type { DeploymentJournal } from "./journal.js";

export interface NonceLockOptions {
  readonly client: Pick<ReadClient, "getTransactionCount">;
  readonly signer: Hex;
  readonly journal: DeploymentJournal;
}

/**
 * Serializes nonce allocation for one signer/EOA and reconciles it with both the
 * chain's pending nonce and the journal's consumed nonces.
 *
 * Safety rule (PRD §6.3): a transaction that was sent but never confirmed must be
 * reconciled before any new nonce is chosen. Guessing would either reuse a nonce
 * (replacing a live transaction) or skip one (permanently stalling the account).
 */
export class NonceLock {
  private readonly options: NonceLockOptions;
  private nextNonce: bigint | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: NonceLockOptions) {
    this.options = options;
  }

  async resolveStartNonce(): Promise<bigint> {
    const unresolved = this.options.journal.unresolvedTransactions();
    if (unresolved.length > 0) {
      throw new TapeCiError(
        "UPLOAD_INTERRUPTED",
        `cannot allocate a nonce: ${unresolved.length} transaction(s) were sent but not reconciled`,
        { details: { txHashes: unresolved.map((record) => record.sent?.txHash ?? null) } },
      );
    }
    const chainNonce = BigInt(
      await this.options.client.getTransactionCount({
        address: this.options.signer,
        blockTag: "pending",
      }),
    );
    const consumed = this.options.journal.maxConsumedNonce();
    if (consumed === null) return chainNonce;
    return chainNonce > consumed ? chainNonce : consumed + 1n;
  }

  /** Allocate the next nonce; concurrent calls are serialized in-process. */
  async allocate(): Promise<bigint> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.nextNonce === null) {
        this.nextNonce = await this.resolveStartNonce();
      }
      const nonce = this.nextNonce;
      this.nextNonce += 1n;
      return nonce;
    } finally {
      release();
    }
  }
}
