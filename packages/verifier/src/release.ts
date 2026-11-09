import type { ChainConfig } from "@tapeci/config";
import { XLAYER_MAINNET } from "@tapeci/config";
import { TapeCiError, type Hex } from "@tapeci/shared";
import type { OperatorClient } from "./operators.js";
import { createOperatorClients } from "./operators.js";
import { verifySite } from "./site.js";
import type {
  FileCheck,
  VerificationReport,
  VerificationStatus,
} from "./types.js";

export const RELEASE_VERIFICATION_SCHEMA_VERSION = "tapeci.release-verification.v1";

export type ReleaseVerificationStatus =
  | "VERIFIED"
  | "MISMATCH"
  | "DISAGREEMENT"
  | "UNSUPPORTED_IMPLEMENTATION"
  | "INCOMPLETE";

/** The subset of a P1-04 manifest that verification needs (legacy/external releases allowed). */
export interface ReleaseManifestFile {
  readonly path: string;
  readonly sourcePath: string;
  readonly size: number;
  readonly sha256: Hex;
  readonly contentType: string;
  readonly chunks: number;
}

export interface ReleaseManifestView {
  readonly chainId: 196;
  readonly container: Hex;
  readonly siteRegistry: Hex;
  readonly commitSha: string;
  readonly releaseId: string;
  readonly entryPath: string;
  readonly fallbackPath: string;
  readonly files: readonly ReleaseManifestFile[];
  readonly artifactDigest?: Hex;
  readonly releaseManifestHash?: Hex;
}

export interface JournalTransactionEvidence {
  readonly fingerprint: Hex;
  readonly operation: "putFile" | "appendChunk";
  readonly path: string;
  readonly chunkIndex: number;
  readonly nonce: string;
  readonly txHash: Hex | null;
  readonly blockNumber: number | null;
  readonly gasUsed: bigint | null;
  readonly status: "mined" | "failed" | "unresolved";
}

export interface JournalVerifiedFileEvidence {
  readonly path: string;
  readonly sha256: Hex;
  readonly size: number;
  readonly status: "UPLOADED" | "UNCHANGED";
}

/** Chain-independent journal evidence, structurally compatible with the P1-06 journal state. */
export interface ReleaseJournalEvidence {
  readonly deploymentId: string;
  readonly complete: boolean;
  readonly transactions: readonly JournalTransactionEvidence[];
  readonly verifiedFiles: readonly JournalVerifiedFileEvidence[];
}

/** Structural view of `DeploymentJournal.state` (no dependency on the deployer package). */
export interface JournalStateLike {
  readonly deploymentId: string | null;
  readonly complete: boolean;
  readonly transactions: ReadonlyMap<
    string,
    {
      readonly intent: {
        readonly fingerprint: Hex;
        readonly operation: "putFile" | "appendChunk";
        readonly path: string;
        readonly chunkIndex: number;
        readonly nonce: string;
      };
      readonly sent?: { readonly txHash: Hex };
      readonly mined?: { readonly txHash?: Hex; readonly blockNumber: string; readonly gasUsed: string };
      readonly failed?: { readonly txHash: Hex | null };
    }
  >;
  readonly verifiedFiles: ReadonlyMap<
    string,
    {
      readonly path: string;
      readonly sha256: Hex;
      readonly size: number;
      readonly status: "UPLOADED" | "UNCHANGED";
    }
  >;
}

export function journalEvidenceFromState(state: JournalStateLike): ReleaseJournalEvidence {
  return {
    deploymentId: state.deploymentId ?? "",
    complete: state.complete,
    transactions: [...state.transactions.values()].map((record) => ({
      fingerprint: record.intent.fingerprint,
      operation: record.intent.operation,
      path: record.intent.path,
      chunkIndex: record.intent.chunkIndex,
      nonce: record.intent.nonce,
      txHash: record.mined?.txHash ?? record.sent?.txHash ?? record.failed?.txHash ?? null,
      blockNumber: record.mined === undefined ? null : Number(record.mined.blockNumber),
      gasUsed: record.mined === undefined ? null : BigInt(record.mined.gasUsed),
      status:
        record.mined !== undefined
          ? "mined"
          : record.failed !== undefined
            ? "failed"
            : "unresolved",
    })),
    verifiedFiles: [...state.verifiedFiles.values()].map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      status: file.status,
    })),
  };
}

export interface ReleaseFileCheck {
  readonly path: string;
  readonly sourcePath: string;
  readonly expectedSha256: Hex;
  readonly expectedSize: number;
  readonly actualSha256: Hex | null;
  readonly actualSize: number | null;
  readonly chainDeclaredSha256: Hex | null;
  readonly chainDeclaredSize: number | null;
  readonly operators: readonly string[];
  readonly operatorsAgree: boolean;
  /** The chain declaration (what fileInfo says) equals the approved manifest row. */
  readonly manifestDeclarationMatchesChain: boolean;
  readonly matched: boolean;
}

export interface ReleaseFileMatchResult {
  readonly files: readonly ReleaseFileCheck[];
  readonly allMatched: boolean;
  readonly missing: readonly string[];
}

function hexEqual(a: Hex | null | undefined, b: Hex): boolean {
  return a !== null && a !== undefined && a.toLowerCase() === b.toLowerCase();
}

function allEqual<T>(values: readonly T[], predicate: (value: T) => boolean): boolean {
  return values.length > 0 && values.every(predicate);
}

/**
 * Compare the PRD §6.4 chain report with the approved manifest. The chain's own
 * declaration is not the authority for a release — the manifest is.
 */
export function matchReleaseFiles(
  manifest: ReleaseManifestView,
  checks: readonly FileCheck[],
): ReleaseFileMatchResult {
  const byPath = new Map(checks.map((check) => [check.path, check]));
  const missing: string[] = [];
  const files = manifest.files.map((file): ReleaseFileCheck => {
    const check = byPath.get(file.path);
    if (check === undefined) {
      missing.push(file.path);
      return {
        path: file.path,
        sourcePath: file.sourcePath,
        expectedSha256: file.sha256,
        expectedSize: file.size,
        actualSha256: null,
        actualSize: null,
        chainDeclaredSha256: null,
        chainDeclaredSize: null,
        operators: [],
        operatorsAgree: false,
        manifestDeclarationMatchesChain: false,
        matched: false,
      };
    }
    const actualHashes = Object.values(check.actualSha256ByOperator);
    const actualSizes = Object.values(check.actualSizeByOperator);
    const declarations = Object.values(check.declaredByOperator).filter(
      (declaration): declaration is NonNullable<typeof declaration> => declaration !== null,
    );
    const operators = Object.keys(check.actualSha256ByOperator);
    const actualMatches = allEqual(actualHashes, (hash) => hexEqual(hash, file.sha256));
    const sizesMatch = allEqual(actualSizes, (size) => size === file.size);
    const declarationMatchesChain = allEqual(declarations, (declaration) =>
      hexEqual(declaration.sha256, file.sha256),
    ) && allEqual(declarations, (declaration) => declaration.size === file.size);
    const matched =
      check.operatorsAgree &&
      hexEqual(check.actualSha256, file.sha256) &&
      check.actualSize === file.size &&
      actualMatches &&
      sizesMatch &&
      declarationMatchesChain;
    const firstDeclaration = declarations[0];
    return {
      path: file.path,
      sourcePath: file.sourcePath,
      expectedSha256: file.sha256,
      expectedSize: file.size,
      actualSha256: check.actualSha256,
      actualSize: check.actualSize,
      chainDeclaredSha256: firstDeclaration?.sha256 ?? null,
      chainDeclaredSize: firstDeclaration?.size ?? null,
      operators,
      operatorsAgree: check.operatorsAgree,
      manifestDeclarationMatchesChain: declarationMatchesChain,
      matched,
    };
  });
  return {
    files,
    allMatched: files.length > 0 && files.every((file) => file.matched),
    missing,
  };
}

export interface ReleaseJournalCheck {
  readonly checked: true;
  readonly deploymentId: string;
  readonly complete: boolean;
  readonly verifiedFilesMatch: boolean;
  readonly transactionsOk: boolean;
  readonly allMinedBeforePin: boolean;
  readonly entryWrittenLast: boolean | null;
  readonly transactionCount: number;
  readonly totalGasUsed: bigint;
  readonly issues: readonly string[];
}

/** Cross-check the P1-06 journal against the approved manifest and the verification pin. */
export function checkJournalEvidence(
  manifest: ReleaseManifestView,
  journal: ReleaseJournalEvidence,
  pinnedBlockNumber: number | null,
): ReleaseJournalCheck {
  const issues: string[] = [];
  if (!journal.complete) issues.push("journal is not complete");

  const verifiedByPath = new Map(journal.verifiedFiles.map((file) => [file.path, file]));
  let verifiedFilesMatch = true;
  for (const file of manifest.files) {
    const verified = verifiedByPath.get(file.path);
    if (verified === undefined) {
      verifiedFilesMatch = false;
      issues.push(`journal has no verified-file event for ${file.path}`);
    } else if (!hexEqual(verified.sha256, file.sha256) || verified.size !== file.size) {
      verifiedFilesMatch = false;
      issues.push(`journal verified-file hash/size mismatch for ${file.path}`);
    }
  }

  let transactionsOk = true;
  for (const transaction of journal.transactions) {
    if (transaction.status !== "mined") {
      transactionsOk = false;
      issues.push(
        `transaction ${transaction.fingerprint} for ${transaction.path} is ${transaction.status}`,
      );
    }
  }

  let allMinedBeforePin = true;
  if (pinnedBlockNumber !== null) {
    for (const transaction of journal.transactions) {
      if (transaction.blockNumber !== null && transaction.blockNumber > pinnedBlockNumber) {
        allMinedBeforePin = false;
        issues.push(
          `transaction ${transaction.txHash ?? transaction.fingerprint} mined at block ${transaction.blockNumber}, after verification pin ${pinnedBlockNumber}`,
        );
      }
    }
  }

  const minedEntry = journal.transactions.filter(
    (transaction) =>
      transaction.status === "mined" &&
      transaction.blockNumber !== null &&
      transaction.path === manifest.entryPath,
  );
  const minedAssets = journal.transactions.filter(
    (transaction) =>
      transaction.status === "mined" &&
      transaction.blockNumber !== null &&
      transaction.path !== manifest.entryPath,
  );
  let entryWrittenLast: boolean | null = null;
  if (minedEntry.length > 0) {
    const entryBlock = Math.max(...minedEntry.map((transaction) => transaction.blockNumber ?? 0));
    entryWrittenLast = minedAssets.every(
      (transaction) => (transaction.blockNumber ?? 0) <= entryBlock,
    );
    if (!entryWrittenLast) issues.push("entry file was mined before one or more assets");
  }

  const totalGasUsed = journal.transactions.reduce(
    (sum, transaction) => sum + (transaction.gasUsed ?? 0n),
    0n,
  );

  return {
    checked: true,
    deploymentId: journal.deploymentId,
    complete: journal.complete,
    verifiedFilesMatch,
    transactionsOk,
    allMinedBeforePin,
    entryWrittenLast,
    transactionCount: journal.transactions.length,
    totalGasUsed,
    issues,
  };
}

export function deriveReleaseStatus(
  chainStatus: VerificationStatus,
  allFilesMatched: boolean,
  journalCheck: ReleaseJournalCheck | null,
): ReleaseVerificationStatus {
  if (chainStatus === "UNSUPPORTED_IMPLEMENTATION") return "UNSUPPORTED_IMPLEMENTATION";
  if (chainStatus === "DISAGREEMENT") return "DISAGREEMENT";
  if (chainStatus === "INCOMPLETE") return "INCOMPLETE";
  if (!allFilesMatched) return "MISMATCH";
  if (journalCheck !== null && journalCheck.issues.length > 0) return "MISMATCH";
  return "VERIFIED";
}

export interface FinalityCheck {
  readonly pinnedBlockNumber: number | null;
  readonly safeBlockNumber: number | null;
  readonly finalizedBlockNumber: number | null;
  readonly pinnedBlockIsSafe: boolean | null;
  readonly pinnedBlockIsFinalized: boolean | null;
}

async function readFinality(
  operators: readonly OperatorClient[],
  pinnedBlockNumber: number | null,
): Promise<FinalityCheck> {
  const primary = operators[0];
  if (primary === undefined || pinnedBlockNumber === null) {
    return {
      pinnedBlockNumber,
      safeBlockNumber: null,
      finalizedBlockNumber: null,
      pinnedBlockIsSafe: null,
      pinnedBlockIsFinalized: null,
    };
  }
  const readTag = async (blockTag: "safe" | "finalized"): Promise<number | null> => {
    try {
      const block = await primary.client.getBlock({ blockTag });
      return Number(block.number);
    } catch {
      return null;
    }
  };
  const [safeBlockNumber, finalizedBlockNumber] = await Promise.all([
    readTag("safe"),
    readTag("finalized"),
  ]);
  return {
    pinnedBlockNumber,
    safeBlockNumber,
    finalizedBlockNumber,
    pinnedBlockIsSafe:
      safeBlockNumber === null ? null : pinnedBlockNumber <= safeBlockNumber,
    pinnedBlockIsFinalized:
      finalizedBlockNumber === null ? null : pinnedBlockNumber <= finalizedBlockNumber,
  };
}

export interface VerifyReleaseOptions {
  readonly manifest: ReleaseManifestView;
  readonly journal?: ReleaseJournalEvidence;
  readonly pinnedBlock?: bigint | number | string;
  readonly config?: ChainConfig;
  readonly operators?: readonly OperatorClient[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Test-only escape hatch for a local Anvil fork, which cannot offer two
   * independent operators. Production verification must leave this unset.
   */
  readonly allowSingleOperator?: boolean;
}

export interface ReleaseVerificationReport extends VerificationReport {
  readonly schemaVersion: typeof RELEASE_VERIFICATION_SCHEMA_VERSION;
  /** Overall TapeCI release decision; `status` above is the raw chain-verification status. */
  readonly releaseStatus: ReleaseVerificationStatus;
  readonly releaseMatch: boolean;
  readonly manifest: {
    readonly chainId: 196;
    readonly container: Hex;
    readonly commitSha: string;
    readonly releaseId: string;
    readonly entryPath: string;
    readonly fallbackPath: string;
    readonly artifactDigest: Hex | null;
    readonly releaseManifestHash: Hex | null;
    readonly fileCount: number;
    readonly entrySingleTransactionEligible: boolean;
  };
  readonly files: readonly ReleaseFileCheck[];
  readonly journal: ReleaseJournalCheck | null;
  readonly finality: FinalityCheck;
  readonly warnings: readonly string[];
}

/**
 * Verify a completed or planned release against the approved manifest:
 * chain bytes (two operators, one pinned block) AND the local journal evidence.
 */
export async function verifyRelease(
  options: VerifyReleaseOptions,
): Promise<ReleaseVerificationReport> {
  const { manifest } = options;
  const config = options.config ?? XLAYER_MAINNET;
  const registry = config.registries[0];
  if (registry === undefined) throw new TapeCiError("INTERNAL", "no SiteRegistry configured");
  if (manifest.chainId !== config.chainId) {
    throw new TapeCiError("CHAIN_MISMATCH", `manifest chainId ${manifest.chainId} is not 196`);
  }
  if (manifest.siteRegistry.toLowerCase() !== registry.toLowerCase()) {
    throw new TapeCiError(
      "INVALID_ARTIFACT",
      `manifest siteRegistry ${manifest.siteRegistry} is not the pinned registry ${registry}`,
    );
  }
  const entry = manifest.files.find((file) => file.path === manifest.entryPath);
  if (entry === undefined) {
    throw new TapeCiError("INVALID_ARTIFACT", `manifest has no entry file ${manifest.entryPath}`);
  }
  const operators = options.operators ?? createOperatorClients(config, options.env);
  if (operators.length === 0) {
    throw new TapeCiError("INTERNAL", "verifyRelease needs at least one operator client");
  }

  const base = await verifySite({
    container: manifest.container,
    paths: manifest.files.map((file) => file.path),
    ...(options.pinnedBlock === undefined ? {} : { pinnedBlock: options.pinnedBlock }),
    config,
    operators,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.allowSingleOperator === true ? { allowSingleOperator: true } : {}),
  });
  const fileMatch = matchReleaseFiles(manifest, base.checks);
  const journalCheck =
    options.journal === undefined
      ? null
      : checkJournalEvidence(manifest, options.journal, base.pin.pinnedBlockNumber);
  const singleOperator = operators.length < 2;
  const releaseStatus =
    singleOperator && options.allowSingleOperator !== true
      ? "INCOMPLETE"
      : deriveReleaseStatus(base.status, fileMatch.allMatched, journalCheck);
  const finality = await readFinality(operators, base.pin.pinnedBlockNumber);

  const warnings: string[] = [];
  if (operators.length < 2) {
    warnings.push("single operator: this is not an independent-quorum verification");
  }
  if (options.journal === undefined) {
    warnings.push("no journal evidence supplied: write/cutover ordering was not checked");
  }
  const entryEligible = entry.chunks === 1 && entry.size <= 24_000;
  if (!entryEligible) {
    warnings.push(
      "entry file exceeds the single-transaction cutover limit (<= 24,000 bytes, 1 chunk); verification covers legacy/external content",
    );
  }

  return {
    ...base,
    schemaVersion: RELEASE_VERIFICATION_SCHEMA_VERSION,
    releaseStatus,
    releaseMatch: releaseStatus === "VERIFIED",
    manifest: {
      chainId: 196,
      container: manifest.container,
      commitSha: manifest.commitSha,
      releaseId: manifest.releaseId,
      entryPath: manifest.entryPath,
      fallbackPath: manifest.fallbackPath,
      artifactDigest: manifest.artifactDigest ?? null,
      releaseManifestHash: manifest.releaseManifestHash ?? null,
      fileCount: manifest.files.length,
      entrySingleTransactionEligible: entryEligible,
    },
    files: fileMatch.files,
    journal: journalCheck,
    finality,
    warnings,
  };
}

/** JSON-safe release report (bigint → decimal string) for files and CLI output. */
export function releaseReportToJson(report: ReleaseVerificationReport): unknown {
  const replacer = (_key: string, value: unknown): unknown =>
    typeof value === "bigint" ? value.toString() : value;
  return JSON.parse(JSON.stringify(report, replacer)) as unknown;
}
