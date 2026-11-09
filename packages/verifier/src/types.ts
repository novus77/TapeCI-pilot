import type { ChainConfig } from "@tapeci/config";
import type { Hex } from "@tapeci/shared";
import type { OperatorClient } from "./operators.js";

/**
 * PRD §6.4 `VerificationReport.status`. `VERIFIED` only means "both operators
 * returned the same bytes at one pinned block and those bytes match the hash the
 * chain declares at that block". It is not a stronger L2 finality claim.
 */
export type VerificationStatus =
  | "VERIFIED"
  | "DISAGREEMENT"
  | "UNSUPPORTED_IMPLEMENTATION"
  | "INCOMPLETE";

/** One independent RPC operator's observation of the chain head (TapeKit SPEC §4.2). */
export interface OperatorHead {
  readonly operator: string;
  readonly url: string;
  readonly chainId: number | null;
  readonly head: number | null;
}

/**
 * How the single pinned block was chosen. Every read in one report uses exactly
 * this block: `pinnedBlockNumber`.
 *
 * Pin strategy (TapeKit SPEC §4.2): one vote per independent operator, take the
 * second-highest operator head, subtract `offset` (2 on X Layer) so every
 * operator can serve the block and a just-mined block cannot be reorged under us.
 */
export interface PinEvidence {
  readonly strategy: "second-highest-operator-head-minus-offset" | "caller-supplied";
  readonly heads: readonly OperatorHead[];
  readonly sortedHeads: readonly number[];
  readonly secondHighestHead: number | null;
  readonly offset: number;
  /** `null` only when no safe pin could be established (`INCOMPLETE`). */
  readonly pinnedBlockNumber: number | null;
  readonly maxHead: number | null;
  readonly divergenceBlocks: number | null;
  readonly pinLagBlocks: number | null;
  readonly maxLagBlocks: number;
  readonly formula: string;
  readonly pinnedBlockHash: Hex | null;
  readonly pinnedBlockTimestamp: number | null;
  readonly blockAgeSeconds: number | null;
}

/** ERC-1967 implementation observation for one allowlisted proxy, at the pinned block. */
export interface ImplementationEvidence {
  readonly role: "factory" | "siteRegistry" | "domainBinding";
  readonly proxy: Hex;
  readonly implementation: Hex | null;
  readonly allowlisted: boolean;
  readonly codeSize: number;
  readonly expected: readonly Hex[];
  readonly byOperator: Readonly<Record<string, Hex | null>>;
  readonly operatorsAgree: boolean;
}

/** The declaration SiteRegistry returned for one path at the pinned block. */
export interface OperatorFileDeclaration {
  readonly sha256: Hex;
  readonly size: number;
  readonly chunkCount: number;
  readonly contentType: string;
  readonly updatedAt: number;
}

export interface FileReadError {
  readonly operator: string;
  readonly message: string;
}

/** One PRD §6.4 `checks[]` row, plus the per-operator evidence behind it. */
export interface FileCheck {
  readonly path: string;
  readonly expectedSha256: Hex;
  readonly actualSha256: Hex;
  readonly expectedSize: number;
  readonly actualSize: number;
  readonly matched: boolean;
  readonly chunkCount: number;
  readonly contentType: string;
  readonly updatedAt: number;
  readonly actualSha256ByOperator: Readonly<Record<string, Hex | null>>;
  readonly actualSizeByOperator: Readonly<Record<string, number | null>>;
  readonly declaredByOperator: Readonly<Record<string, OperatorFileDeclaration | null>>;
  readonly operatorsAgree: boolean;
  readonly errors: readonly FileReadError[];
}

/**
 * Concrete disagreement: which path, which operators and which field disagree.
 * TapeKit treats any operator disagreement as rejection, never a majority vote.
 */
export interface DisagreementDetail {
  /** `null` for site-level fields (block header, implementations, path list). */
  readonly path: string | null;
  readonly field: string;
  readonly operators: readonly string[];
  readonly values: Readonly<Record<string, string | number | boolean | null>>;
  readonly message: string;
}

/** PRD §6.4 VerificationReport, JSON-serializable. */
export interface VerificationReport {
  readonly chainId: number;
  readonly container: Hex;
  readonly registry: Hex;
  /** `null` only when the report is `INCOMPLETE` because no pin could be chosen. */
  readonly pinnedBlockNumber: number | null;
  readonly observedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  /** At least two independent operators (e.g. `["okx", "drpc"]`). */
  readonly nodeOperators: readonly string[];
  readonly registryImplementation: Hex | null;
  readonly bindingImplementation: Hex | null;
  readonly checks: readonly FileCheck[];
  readonly status: VerificationStatus;
  readonly paths: readonly string[];
  readonly fallbackPath: string;
  readonly pin: PinEvidence;
  readonly implementations: readonly ImplementationEvidence[];
  /** All disagreements found; empty for `VERIFIED` / `UNSUPPORTED_IMPLEMENTATION`. */
  readonly disagreements: readonly DisagreementDetail[];
  /** Human-readable explanation when `status !== "VERIFIED"`. */
  readonly detail?: string;
}

export interface VerifySiteOptions {
  /** Container address (checksummed or lower-case). */
  readonly container: string;
  /** Explicit paths to check; when omitted they are discovered with `pathCount`/`paths`. */
  readonly paths?: readonly string[];
  /** Reproduce an earlier report by pinning the exact block (decimal or `0x` hex). */
  readonly pinnedBlock?: bigint | number | string;
  /** Defaults to `XLAYER_MAINNET`; injectable for fork tests. */
  readonly config?: ChainConfig;
  /** RPC endpoint overrides (`TAPECI_RPC_OKX` / `TAPECI_RPC_DRPC`), merged over `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Explicit clients (e.g. a local Anvil fork). Defaults to OKX + dRPC. */
  readonly operators?: readonly OperatorClient[];
  /** Test-only: accept one operator (a local fork cannot provide two independent ones). */
  readonly allowSingleOperator?: boolean;
}
