import { getAddress, type Hex } from "viem";
import type { ReleaseManifest } from "@tapeci/artifact";
import { computeArtifactDigest, releaseManifestHash } from "@tapeci/artifact";
import {
  assertContainerVerified,
  assertImplementationsAllowlisted,
  inspectContainer,
  readFileInfo,
} from "@tapeci/chain";
import { XLAYER_MAINNET } from "@tapeci/config";
import { TapeCiError, sha256Hex } from "@tapeci/shared";
import { selectPinnedBlock, type OperatorClient } from "@tapeci/verifier";
import {
  OBSERVED_XLAYER_GAS_MODEL,
  costWei,
  estimateFileGas,
  recommendedCapWei,
  type GasModel,
} from "./cost.js";

export const RELEASE_PLAN_SCHEMA_VERSION = "tapeci.plan.v1";

export type PlanActionKind = "WRITE" | "UNCHANGED" | "CONFLICT";
export type PlanBlockedReason = "UPLOAD_CONFLICT" | "FEE_OVER_BUDGET" | "INSUFFICIENT_BALANCE";

/** Snapshot of one target path at the pinned block. */
export interface PlanOnChainFile {
  readonly exists: boolean;
  readonly size: number;
  readonly sha256: Hex;
  readonly contentType: string;
  readonly chunkCount: number;
}

export interface PlanAction {
  readonly path: string;
  readonly sourcePath: string;
  readonly action: PlanActionKind;
  readonly reason: string;
  readonly size: number;
  readonly sha256: Hex;
  readonly chunks: number;
  /** 0 for UNCHANGED and CONFLICT; the raw model estimate for WRITE. */
  readonly estimatedGas: bigint;
  readonly onChain: PlanOnChainFile | null;
}

export interface PlanTotals {
  readonly files: number;
  readonly writes: number;
  readonly unchanged: number;
  readonly conflicts: number;
  readonly chunks: number;
  readonly bytes: number;
}

export interface PlanFees {
  readonly gasPriceWei: bigint;
  readonly estimatedGas: bigint;
  readonly estimatedCostWei: bigint;
  readonly marginBps: number;
  readonly recommendedCapWei: bigint;
  readonly costCapWei: bigint | null;
  readonly withinBudget: boolean;
  readonly overBudgetByWei: bigint;
}

export interface ReleasePlan {
  readonly schemaVersion: typeof RELEASE_PLAN_SCHEMA_VERSION;
  readonly chainId: 196;
  readonly container: Hex;
  readonly siteRegistry: Hex;
  readonly commitSha: string;
  readonly releaseId: string;
  readonly artifactDigest: Hex;
  readonly releaseManifestHash: Hex;
  readonly entryPath: string;
  readonly pinnedBlockNumber: bigint;
  readonly pinnedBlockHash: Hex;
  readonly operators: readonly string[];
  readonly observedAt: string;
  readonly files: readonly PlanAction[];
  readonly totals: PlanTotals;
  readonly fees: PlanFees;
  readonly containerOwner: Hex | null;
  readonly containerOpened: boolean;
  readonly signer: Hex | null;
  readonly signerIsHolder: boolean | null;
  readonly signerBalanceWei: bigint | null;
  readonly sufficientBalance: boolean | null;
  readonly blocked: boolean;
  readonly blockedReasons: readonly PlanBlockedReason[];
  readonly warnings: readonly string[];
}

export interface PlanFileBytes {
  readonly sourcePath: string;
  readonly bytes: Uint8Array;
}

export interface PlanReleaseOptions {
  readonly manifest: ReleaseManifest;
  /** Map from manifest `sourcePath` to the exact bytes that will be uploaded. */
  readonly files: readonly PlanFileBytes[];
  readonly operators: readonly OperatorClient[];
  readonly signer?: Hex;
  readonly costCapWei?: bigint;
  readonly gasPriceWei?: bigint;
  /** Reproduce an earlier plan by pinning the exact block. */
  readonly pinnedBlockNumber?: bigint | number | string;
  readonly marginBps?: number;
  readonly gasModel?: GasModel;
}

/**
 * Pure diff of a release manifest against one consistent on-chain snapshot
 * (PRD §5.3). The controlled entry path may be replaced; any other same-path /
 * different-content file is a conflict.
 */
export function diffReleasePlan(input: {
  readonly manifest: ReleaseManifest;
  readonly onChain: ReadonlyMap<string, PlanOnChainFile>;
  readonly gasModel?: GasModel;
}): { files: PlanAction[]; totals: PlanTotals } {
  const { manifest, onChain } = input;
  const gasModel = input.gasModel ?? OBSERVED_XLAYER_GAS_MODEL;
  const files: PlanAction[] = manifest.files.map((file) => {
    const current = onChain.get(file.path) ?? null;
    let action: PlanActionKind;
    let reason: string;

    if (current === null || !current.exists || current.chunkCount === 0) {
      action = "WRITE";
      reason = "missing on chain";
    } else if (
      current.size === file.size &&
      current.sha256.toLowerCase() === file.sha256.toLowerCase()
    ) {
      action = "UNCHANGED";
      reason = "identical content already on chain";
    } else if (file.path === manifest.entryPath) {
      action = "WRITE";
      reason = "entry replacement (controlled cutover)";
    } else {
      action = "CONFLICT";
      reason = "same path already holds different content";
    }

    return {
      path: file.path,
      sourcePath: file.sourcePath,
      action,
      reason,
      size: file.size,
      sha256: file.sha256,
      chunks: file.chunks,
      estimatedGas: action === "WRITE" ? estimateFileGas(file.size, gasModel) : 0n,
      onChain: current,
    };
  });

  const writes = files.filter((file) => file.action === "WRITE");
  const totals: PlanTotals = {
    files: files.length,
    writes: writes.length,
    unchanged: files.filter((file) => file.action === "UNCHANGED").length,
    conflicts: files.filter((file) => file.action === "CONFLICT").length,
    chunks: writes.reduce((sum, file) => sum + file.chunks, 0),
    bytes: writes.reduce((sum, file) => sum + file.size, 0),
  };
  return { files, totals };
}

export interface PlanFeeEstimate {
  readonly fees: PlanFees;
  readonly sufficientBalance: boolean | null;
}

/** Pure fee calculation and budget comparison (no chain access). */
export function estimatePlanFees(input: {
  readonly estimatedGas: bigint;
  readonly gasPriceWei: bigint;
  readonly marginBps: number;
  readonly costCapWei?: bigint | null;
  readonly signerBalanceWei?: bigint | null;
}): PlanFeeEstimate {
  const costCapWei = input.costCapWei ?? null;
  const estimatedCostWei = costWei(input.estimatedGas, input.gasPriceWei);
  const recommended = recommendedCapWei(estimatedCostWei, input.marginBps);
  const withinBudget = costCapWei === null ? true : estimatedCostWei <= costCapWei;
  const overBudgetByWei =
    costCapWei === null || withinBudget ? 0n : estimatedCostWei - costCapWei;
  const balance = input.signerBalanceWei ?? null;
  return {
    fees: {
      gasPriceWei: input.gasPriceWei,
      estimatedGas: input.estimatedGas,
      estimatedCostWei,
      marginBps: input.marginBps,
      recommendedCapWei: recommended,
      costCapWei,
      withinBudget,
      overBudgetByWei,
    },
    sufficientBalance: balance === null ? null : balance >= estimatedCostWei,
  };
}

function parsePinnedBlock(value: bigint | number | string): bigint {
  try {
    return typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new TapeCiError("INVALID_CONFIG", `invalid pinned block: ${String(value)}`);
  }
}

function sameOnChainFile(a: PlanOnChainFile, b: PlanOnChainFile): string | null {
  if (a.exists !== b.exists) return "exists";
  if (a.size !== b.size) return "size";
  if (a.sha256.toLowerCase() !== b.sha256.toLowerCase()) return "sha256";
  if (a.contentType !== b.contentType) return "contentType";
  if (a.chunkCount !== b.chunkCount) return "chunkCount";
  return null;
}

/**
 * Build a full release plan: pin one block across independent operators, verify
 * implementations, diff every target path, estimate chunks/gas/cost and compare
 * the result with a user budget cap and the signer balance. Read-only.
 */
export async function planRelease(options: PlanReleaseOptions): Promise<ReleasePlan> {
  const { manifest, operators } = options;
  if (operators.length === 0) {
    throw new TapeCiError("INTERNAL", "planRelease needs at least one RPC operator");
  }
  if (manifest.chainId !== XLAYER_MAINNET.chainId) {
    throw new TapeCiError("CHAIN_MISMATCH", `manifest chainId ${manifest.chainId} is not X Layer 196`);
  }
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new TapeCiError("INTERNAL", "no registry configured");
  if (manifest.siteRegistry.toLowerCase() !== registry.toLowerCase()) {
    throw new TapeCiError(
      "INVALID_ARTIFACT",
      `manifest siteRegistry ${manifest.siteRegistry} is not the TapeCI-pinned registry ${registry}`,
    );
  }
  const warnings: string[] = [];

  // 1. Pin one block across all operators (independent votes only).
  const heads = await Promise.all(operators.map((operator) => operator.client.getBlockNumber()));
  let pinnedBlockNumber: number;
  if (options.pinnedBlockNumber !== undefined) {
    const explicit = parsePinnedBlock(options.pinnedBlockNumber);
    const minHead = heads.reduce((min, head) => (head < min ? head : min), heads[0] as bigint);
    if (explicit > minHead) {
      throw new TapeCiError(
        "RPC_DISAGREEMENT",
        `explicit pinned block ${explicit} is ahead of an operator head ${minHead}`,
        { details: { pinnedBlock: explicit.toString(), minHead: minHead.toString() } },
      );
    }
    pinnedBlockNumber = Number(explicit);
    warnings.push("caller-supplied pinned block: pin arithmetic was not applied");
  } else if (operators.length >= 2) {
    const selection = selectPinnedBlock(
      heads.map(Number),
      XLAYER_MAINNET.pin.offset,
      XLAYER_MAINNET.pin.maxLagBlocks,
    );
    pinnedBlockNumber = selection.pinnedBlockNumber;
  } else {
    pinnedBlockNumber = Number(heads[0]) - XLAYER_MAINNET.pin.offset;
    warnings.push("single operator: reads are not independently cross-checked");
  }
  if (pinnedBlockNumber < 0) {
    throw new TapeCiError("RPC_DISAGREEMENT", `pinned block is negative: ${pinnedBlockNumber}`);
  }
  const pinnedBlock = BigInt(pinnedBlockNumber);

  // 2. One block header must be agreed by every operator.
  const blocks = await Promise.all(
    operators.map((operator) => operator.client.getBlock({ blockNumber: pinnedBlock })),
  );
  const hashes = blocks.map((block) => block.hash);
  const pinnedBlockHash = hashes[0];
  if (pinnedBlockHash === undefined || pinnedBlockHash === null) {
    throw new TapeCiError("RPC_DISAGREEMENT", `no block hash at pinned block ${pinnedBlockNumber}`);
  }
  if (new Set(hashes).size > 1) {
    throw new TapeCiError("RPC_DISAGREEMENT", `operators disagree on block ${pinnedBlockNumber}`, {
      details: { byOperator: Object.fromEntries(operators.map((op, index) => [op.operator, hashes[index]])) },
    });
  }

  // 3. Implementation pinning, at the same block, for every operator.
  const implementationsByOperator = await Promise.all(
    operators.map((operator) =>
      assertImplementationsAllowlisted(operator.client, XLAYER_MAINNET, pinnedBlock),
    ),
  );
  const implSignature = (observations: readonly { role: string; implementation: string | null }[]) =>
    observations
      .map((observation) => `${observation.role}:${observation.implementation ?? "null"}`.toLowerCase())
      .sort()
      .join("|");
  if (new Set(implementationsByOperator.map(implSignature)).size > 1) {
    throw new TapeCiError(
      "RPC_DISAGREEMENT",
      "operators disagree on the ERC-1967 implementation addresses",
      { details: { byOperator: Object.fromEntries(operators.map((op, index) => [op.operator, implSignature(implementationsByOperator[index] ?? [])])) } },
    );
  }

  // 4. The target must be a real, opened TapeOut container, agreed by every operator.
  // `assertContainerVerified` throws on a failed read instead of letting `null` become
  // "not opened": a plan must never be refused (or accepted) on an unreadable node.
  const inspections = await Promise.all(
    operators.map((operator) =>
      inspectContainer(operator.client, XLAYER_MAINNET, manifest.container, pinnedBlock).then(
        assertContainerVerified,
      ),
    ),
  );
  const primaryInspection = inspections[0];
  if (primaryInspection === undefined) throw new TapeCiError("INTERNAL", "no container inspection");
  if (!primaryInspection.opened) {
    throw new TapeCiError("CONTAINER_NOT_OPEN", `container ${manifest.container} is not opened`, {
      details: { container: manifest.container },
    });
  }
  for (const inspection of inspections.slice(1)) {
    if (
      inspection.isProcessor !== primaryInspection.isProcessor ||
      inspection.derivedMatches !== primaryInspection.derivedMatches ||
      inspection.opened !== primaryInspection.opened ||
      (inspection.owner ?? "").toLowerCase() !== (primaryInspection.owner ?? "").toLowerCase()
    ) {
      throw new TapeCiError("RPC_DISAGREEMENT", `operators disagree on container ${manifest.container}`);
    }
  }

  // 5. Read every target path's `fileInfo` from every operator at the pinned block.
  const onChain = new Map<string, PlanOnChainFile>();
  const targetPaths = manifest.files.map((file) => file.path);
  const fileInfosByOperator = await Promise.all(
    operators.map((operator) =>
      Promise.all(
        targetPaths.map((path) =>
          readFileInfo(operator.client, manifest.siteRegistry, manifest.container, path, pinnedBlock),
        ),
      ),
    ),
  );
  const primaryInfos = fileInfosByOperator[0];
  if (primaryInfos === undefined) throw new TapeCiError("INTERNAL", "no primary operator fileInfo");
  for (let index = 0; index < targetPaths.length; index += 1) {
    const path = targetPaths[index] as string;
    const primary = primaryInfos[index];
    if (primary === undefined) throw new TapeCiError("INTERNAL", `missing fileInfo for ${path}`);
    const primaryValue: PlanOnChainFile = {
      exists: primary.exists,
      size: primary.size,
      sha256: primary.sha256,
      contentType: primary.contentType,
      chunkCount: primary.chunkCount,
    };
    for (let operatorIndex = 1; operatorIndex < operators.length; operatorIndex += 1) {
      const other = fileInfosByOperator[operatorIndex]?.[index];
      if (other === undefined) throw new TapeCiError("INTERNAL", `missing cross-check fileInfo for ${path}`);
      const field = sameOnChainFile(primaryValue, {
        exists: other.exists,
        size: other.size,
        sha256: other.sha256,
        contentType: other.contentType,
        chunkCount: other.chunkCount,
      });
      if (field !== null) {
        throw new TapeCiError(
          "RPC_DISAGREEMENT",
          `operators disagree on fileInfo for ${path} (${field})`,
          {
            details: {
              path,
              field,
              byOperator: Object.fromEntries(
                operators.map((operator, opIndex) => [operator.operator, fileInfosByOperator[opIndex]?.[index]]),
              ),
            },
          },
        );
      }
    }
    onChain.set(path, primaryValue);
  }

  // 6. Validate that supplied bytes are exactly the bytes the manifest hashes.
  const bytesBySource = new Map<string, Uint8Array>();
  for (const file of options.files) {
    bytesBySource.set(file.sourcePath, file.bytes);
  }
  for (const file of manifest.files) {
    const bytes = bytesBySource.get(file.sourcePath);
    if (bytes === undefined) {
      throw new TapeCiError(
        "INVALID_ARTIFACT",
        `bytes for ${file.sourcePath} are required to estimate the plan`,
        { details: { sourcePath: file.sourcePath } },
      );
    }
    if (bytes.length !== file.size || sha256Hex(bytes).toLowerCase() !== file.sha256.toLowerCase()) {
      throw new TapeCiError(
        "INVALID_ARTIFACT",
        `bytes for ${file.sourcePath} do not match the manifest (size/sha256)`,
        { details: { sourcePath: file.sourcePath } },
      );
    }
  }

  // 7. Diff, estimate gas, read gas price and signer balance.
  const { files, totals } = diffReleasePlan({
    manifest,
    onChain,
    ...(options.gasModel === undefined ? {} : { gasModel: options.gasModel }),
  });
  const estimatedGas = files.reduce((sum, file) => sum + file.estimatedGas, 0n);

  let gasPriceWei = options.gasPriceWei;
  if (gasPriceWei === undefined) {
    const baseFee = blocks[0]?.baseFeePerGas;
    if (baseFee !== null && baseFee !== undefined && baseFee > 0n) {
      gasPriceWei = baseFee;
    } else {
      gasPriceWei = await operators[0]!.client.getGasPrice();
      warnings.push("block base fee unavailable at the pin; used latest eth_gasPrice");
    }
  }

  const signer = options.signer === undefined ? null : getAddress(options.signer);
  let signerBalanceWei: bigint | null = null;
  if (signer !== null) {
    const balances = await Promise.all(
      operators.map((operator) =>
        operator.client.getBalance({ address: signer, blockNumber: pinnedBlock }),
      ),
    );
    if (new Set(balances.map((balance) => balance.toString())).size > 1) {
      throw new TapeCiError("RPC_DISAGREEMENT", `operators disagree on signer balance for ${signer}`, {
        details: { byOperator: Object.fromEntries(operators.map((op, index) => [op.operator, balances[index]?.toString()])) },
      });
    }
    signerBalanceWei = balances[0] ?? null;
    const owner = primaryInspection.owner;
    if (owner !== null && getAddress(owner) !== signer) {
      warnings.push("signer is not the current container holder: verify setOperator authorization separately");
    }
  } else {
    warnings.push("no signer supplied: signer balance and authorization were not checked");
  }

  const marginBps = options.marginBps ?? OBSERVED_XLAYER_GAS_MODEL.defaultMarginBps;
  const feeEstimate = estimatePlanFees({
    estimatedGas,
    gasPriceWei,
    marginBps,
    costCapWei: options.costCapWei ?? null,
    signerBalanceWei,
  });

  const blockedReasons: PlanBlockedReason[] = [];
  if (totals.conflicts > 0) blockedReasons.push("UPLOAD_CONFLICT");
  if (!feeEstimate.fees.withinBudget) blockedReasons.push("FEE_OVER_BUDGET");
  if (feeEstimate.sufficientBalance === false) blockedReasons.push("INSUFFICIENT_BALANCE");
  if (
    feeEstimate.fees.costCapWei !== null &&
    feeEstimate.fees.withinBudget &&
    feeEstimate.fees.costCapWei < feeEstimate.fees.recommendedCapWei
  ) {
    warnings.push("cost cap is below the recommended cap (estimate + safety margin)");
  }

  return {
    schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
    chainId: 196,
    container: manifest.container,
    siteRegistry: manifest.siteRegistry,
    commitSha: manifest.commitSha,
    releaseId: manifest.releaseId,
    artifactDigest: computeArtifactDigest(
      manifest.files.map((file) => ({ path: file.sourcePath, size: file.size, sha256: file.sha256, contentType: file.contentType })),
    ),
    releaseManifestHash: releaseManifestHash(manifest),
    entryPath: manifest.entryPath,
    pinnedBlockNumber: pinnedBlock,
    pinnedBlockHash: pinnedBlockHash as Hex,
    operators: operators.map((operator) => operator.operator),
    observedAt: new Date().toISOString(),
    files,
    totals,
    fees: feeEstimate.fees,
    containerOwner: primaryInspection.owner,
    containerOpened: primaryInspection.opened,
    signer,
    signerIsHolder:
      signer === null || primaryInspection.owner === null
        ? null
        : getAddress(primaryInspection.owner) === signer,
    signerBalanceWei,
    sufficientBalance: feeEstimate.sufficientBalance,
    blocked: blockedReasons.length > 0,
    blockedReasons,
    warnings,
  };
}

/** JSON-safe plan (bigint → decimal string) for evidence files and logs. */
export function planToJson(plan: ReleasePlan): unknown {
  const replacer = (_key: string, value: unknown): unknown =>
    typeof value === "bigint" ? value.toString() : value;
  return JSON.parse(JSON.stringify(plan, replacer)) as unknown;
}

/**
 * Rehydrate a stored plan (from `deployments.plan_json`) without re-reading the
 * chain. Used to resume an interrupted upload against the approved plan instead
 * of re-planning against half-written state, which would report conflicts.
 */
export function planFromJson(value: unknown): ReleasePlan {
  const raw = structuredClone(value) as Record<string, unknown>;
  const big = (input: unknown, field: string): bigint => {
    if (typeof input !== "string" || !/^[0-9]+$/.test(input)) {
      throw new Error(`stored plan field ${field} is not a decimal integer`);
    }
    return BigInt(input);
  };
  raw.pinnedBlockNumber = big(raw.pinnedBlockNumber, "pinnedBlockNumber");
  const fees = raw.fees as Record<string, unknown>;
  for (const key of ["gasPriceWei", "estimatedGas", "estimatedCostWei", "recommendedCapWei", "overBudgetByWei"]) {
    fees[key] = big(fees[key], `fees.${key}`);
  }
  if (fees.costCapWei !== null) fees.costCapWei = big(fees.costCapWei, "fees.costCapWei");
  if (raw.signerBalanceWei !== null) raw.signerBalanceWei = big(raw.signerBalanceWei, "signerBalanceWei");
  const files = raw.files as Record<string, unknown>[];
  for (const file of files) file.estimatedGas = big(file.estimatedGas, "files.estimatedGas");
  return raw as unknown as ReleasePlan;
}
