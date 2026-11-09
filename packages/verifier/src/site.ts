import { getAddress } from "viem";
import type { Hex } from "viem";
import { XLAYER_MAINNET } from "@tapeci/config";
import type { ChainConfig } from "@tapeci/config";
import {
  READ_SEGMENT_BYTES,
  checkAllImplementations,
  fallbackPathAt,
  pathCountAt,
  pathsAt,
  readFileInfo,
  siteRegistryAbi,
  type ImplementationObservation,
  type ReadClient,
} from "@tapeci/chain";
import {
  MAX_FILE_BYTES,
  TapeCiError,
  canonicalizeSitePath,
  hexToBytes,
  isTapeCiError,
  joinChunks,
  sha256Hex,
  type Hex as SharedHex,
  type OnChainFileInfo,
} from "@tapeci/shared";
import { ZERO_SHA256, evaluateFileMatch, firstMismatchOffset, isZeroSha256 } from "./match.js";
import { createOperatorClients, selectPinnedBlock } from "./operators.js";
import type { OperatorClient } from "./operators.js";
import type {
  DisagreementDetail,
  FileCheck,
  FileReadError,
  ImplementationEvidence,
  OperatorFileDeclaration,
  OperatorHead,
  PinEvidence,
  VerificationReport,
  VerificationStatus,
  VerifySiteOptions,
} from "./types.js";

/** TapeKit `maxManifestPaths`; a bigger list is not a site we can verify in one report. */
export const MAX_VERIFY_PATHS = 5_000;

interface OperatorFileRead {
  readonly operator: string;
  readonly info: OnChainFileInfo | null;
  readonly bytes: Uint8Array | null;
  readonly actualSha256: SharedHex | null;
  readonly error: string | null;
}

interface VerificationState {
  readonly pin: PinEvidence;
  readonly paths: readonly string[];
  readonly fallbackPath: string;
  readonly implementations: readonly ImplementationEvidence[];
  readonly checks: readonly FileCheck[];
  readonly disagreements: readonly DisagreementDetail[];
}

interface SiteMetadata {
  readonly operator: string;
  readonly pathCount: number;
  readonly paths: readonly string[];
  readonly fallbackPath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePinnedBlockOption(value: bigint | number | string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TapeCiError("INTERNAL", `invalid pinned block number ${value}`);
    }
    parsed = BigInt(value);
  } else {
    const trimmed = value.trim();
    if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) {
      throw new TapeCiError("INTERNAL", `invalid pinned block ${value}`);
    }
    parsed = BigInt(trimmed);
  }
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TapeCiError("INTERNAL", `pinned block ${parsed.toString()} is out of range`);
  }
  return parsed;
}

function unavailablePin(heads: readonly OperatorHead[], config: ChainConfig): PinEvidence {
  const known = heads
    .map((head) => head.head)
    .filter((head): head is number => head !== null)
    .sort((a, b) => b - a);
  const maxHead = known[0] ?? null;
  const secondHighestHead = known[1] ?? null;
  return {
    strategy: "second-highest-operator-head-minus-offset",
    heads,
    sortedHeads: known,
    secondHighestHead,
    offset: config.pin.offset,
    pinnedBlockNumber: null,
    maxHead,
    divergenceBlocks:
      maxHead !== null && secondHighestHead !== null ? maxHead - secondHighestHead : null,
    pinLagBlocks: null,
    maxLagBlocks: config.pin.maxLagBlocks,
    formula: "unavailable: no complete operator head set",
    pinnedBlockHash: null,
    pinnedBlockTimestamp: null,
    blockAgeSeconds: null,
  };
}

/**
 * Read a file's full bytes at one pinned block, mirroring `readFileBytesAt` but
 * without throwing on a declaration/byte-length mismatch: the verifier must be
 * able to report `matched=false` instead of aborting the whole report.
 */
async function readFullFileBytes(
  client: ReadClient,
  registry: SharedHex,
  container: SharedHex,
  path: string,
  size: number,
  pinnedBlock: bigint,
): Promise<Uint8Array> {
  if (size > MAX_FILE_BYTES) {
    throw new TapeCiError(
      "FILE_TOO_LARGE",
      `on-chain file ${path} declares ${size} bytes, above the TapeOut limit ${MAX_FILE_BYTES}`,
      { details: { path, size } },
    );
  }
  if (size <= READ_SEGMENT_BYTES) {
    const whole = await client.readContract({
      address: registry,
      abi: siteRegistryAbi,
      functionName: "read",
      args: [container, path],
      blockNumber: pinnedBlock,
    });
    return hexToBytes(whole);
  }
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < size; offset += READ_SEGMENT_BYTES) {
    const length = Math.min(READ_SEGMENT_BYTES, size - offset);
    const part = await client.readContract({
      address: registry,
      abi: siteRegistryAbi,
      functionName: "readRange",
      args: [container, path, BigInt(offset), BigInt(length)],
      blockNumber: pinnedBlock,
    });
    parts.push(hexToBytes(part));
  }
  return joinChunks(parts);
}

async function readOperatorFile(
  client: ReadClient,
  operator: string,
  registry: SharedHex,
  container: SharedHex,
  path: string,
  pinnedBlock: bigint,
): Promise<OperatorFileRead> {
  let info: OnChainFileInfo;
  try {
    info = await readFileInfo(client, registry, container, path, pinnedBlock);
  } catch (error) {
    return { operator, info: null, bytes: null, actualSha256: null, error: errorMessage(error) };
  }
  if (!info.exists) {
    return { operator, info, bytes: null, actualSha256: null, error: null };
  }
  try {
    const bytes = await readFullFileBytes(client, registry, container, path, info.size, pinnedBlock);
    return { operator, info, bytes, actualSha256: sha256Hex(bytes), error: null };
  } catch (error) {
    return {
      operator,
      info,
      bytes: null,
      actualSha256: null,
      error: `cannot read ${path} bytes: ${errorMessage(error)}`,
    };
  }
}

const DECLARATION_FIELDS: ReadonlyArray<{
  readonly field: string;
  readonly get: (info: OnChainFileInfo) => string | number;
}> = [
  { field: "size", get: (info) => info.size },
  { field: "sha256", get: (info) => info.sha256.toLowerCase() },
  { field: "chunkCount", get: (info) => info.chunkCount },
  { field: "contentType", get: (info) => info.contentType },
  { field: "updatedAt", get: (info) => info.updatedAt },
];

/**
 * Compare the per-operator reads of one path and turn them into a PRD §6.4
 * check row. Any byte/declaration mismatch between operators is a disagreement
 * (rejection); identical but inconsistent declarations are `INCOMPLETE`.
 */
function evaluatePathReads(
  path: string,
  reads: readonly OperatorFileRead[],
  operatorNames: readonly string[],
): { check: FileCheck; disagreements: DisagreementDetail[]; problem: string | null } {
  const disagreements: DisagreementDetail[] = [];
  const declaredByOperator: Record<string, OperatorFileDeclaration | null> = {};
  const actualSha256ByOperator: Record<string, Hex | null> = {};
  const actualSizeByOperator: Record<string, number | null> = {};
  const errors: FileReadError[] = [];
  for (const read of reads) {
    declaredByOperator[read.operator] =
      read.info === null
        ? null
        : {
            sha256: read.info.sha256,
            size: read.info.size,
            chunkCount: read.info.chunkCount,
            contentType: read.info.contentType,
            updatedAt: read.info.updatedAt,
          };
    actualSha256ByOperator[read.operator] = read.actualSha256;
    actualSizeByOperator[read.operator] = read.bytes === null ? null : read.bytes.length;
    if (read.error !== null) errors.push({ operator: read.operator, message: read.error });
  }

  const declaredInfo =
    reads.find((read) => read.info !== null && read.info.exists)?.info ?? null;
  const successfulHashRead = reads.find((read) => read.actualSha256 !== null);
  const successfulSizeRead = reads.find((read) => read.bytes !== null);

  const baseCheck = (): FileCheck => ({
    path,
    expectedSha256: declaredInfo?.sha256 ?? ZERO_SHA256,
    actualSha256: successfulHashRead?.actualSha256 ?? ZERO_SHA256,
    expectedSize: declaredInfo?.size ?? 0,
    actualSize: successfulSizeRead?.bytes?.length ?? 0,
    matched: false,
    chunkCount: declaredInfo?.chunkCount ?? 0,
    contentType: declaredInfo?.contentType ?? "",
    updatedAt: declaredInfo?.updatedAt ?? 0,
    actualSha256ByOperator,
    actualSizeByOperator,
    declaredByOperator,
    operatorsAgree: false,
    errors,
  });

  const infoErrors = reads.filter((read) => read.info === null);
  if (infoErrors.length > 0) {
    return {
      check: baseCheck(),
      disagreements,
      problem: `could not read fileInfo for ${path} from every operator: ${infoErrors
        .map((read) => `${read.operator}: ${read.error ?? "unknown error"}`)
        .join("; ")}`,
    };
  }

  const exists = reads.map((read) => read.info?.exists === true);
  if (!exists.some(Boolean)) {
    return {
      check: baseCheck(),
      disagreements,
      problem: `file ${path} does not exist on chain at the pinned block`,
    };
  }
  if (!exists.every(Boolean)) {
    disagreements.push({
      path,
      field: "exists",
      operators: operatorNames,
      values: Object.fromEntries(
        reads.map((read) => [read.operator, read.info?.exists === true]),
      ),
      message: `operators disagree on whether ${path} exists at the pinned block`,
    });
    return { check: baseCheck(), disagreements, problem: null };
  }

  for (const { field, get } of DECLARATION_FIELDS) {
    const values: Record<string, string | number> = {};
    for (const read of reads) {
      if (read.info !== null) values[read.operator] = get(read.info);
    }
    if (new Set(Object.values(values)).size > 1) {
      disagreements.push({
        path,
        field,
        operators: operatorNames,
        values,
        message: `operators disagree on fileInfo.${field} for ${path}`,
      });
    }
  }

  const byteReads = reads.filter(
    (read): read is OperatorFileRead & { bytes: Uint8Array; actualSha256: SharedHex } =>
      read.bytes !== null && read.actualSha256 !== null,
  );
  if (byteReads.length !== reads.length) {
    return {
      check: baseCheck(),
      disagreements,
      problem: `could not read ${path} bytes from every operator: ${errors
        .map((error) => `${error.operator}: ${error.message}`)
        .join("; ")}`,
    };
  }

  const base = byteReads[0];
  if (base === undefined) {
    return { check: baseCheck(), disagreements, problem: `no operator read ${path}` };
  }
  for (const other of byteReads.slice(1)) {
    if (other.bytes.length !== base.bytes.length) {
      disagreements.push({
        path,
        field: "bytes.length",
        operators: [base.operator, other.operator],
        values: {
          [base.operator]: base.bytes.length,
          [other.operator]: other.bytes.length,
        },
        message: `operators returned different byte lengths for ${path}`,
      });
      continue;
    }
    const offset = firstMismatchOffset(base.bytes, other.bytes);
    if (offset !== null) {
      disagreements.push({
        path,
        field: `bytes[${offset}]`,
        operators: [base.operator, other.operator],
        values: {
          [base.operator]: base.actualSha256,
          [other.operator]: other.actualSha256,
          offset,
        },
        message: `operators returned different bytes for ${path} (first difference at offset ${offset})`,
      });
    }
  }

  const declared = declaredInfo;
  if (declared === null) {
    return { check: baseCheck(), disagreements, problem: `no usable fileInfo for ${path}` };
  }
  const evaluation = evaluateFileMatch(
    path,
    { sha256: base.actualSha256, size: base.bytes.length },
    { sha256: declared.sha256, size: declared.size },
  );
  const operatorsAgree = disagreements.length === 0 && byteReads.length === reads.length;
  const matched =
    operatorsAgree && evaluation.matched && declared.chunkCount > 0 && !isZeroSha256(declared.sha256);

  let problem: string | null = null;
  if (!matched && operatorsAgree) {
    if (isZeroSha256(declared.sha256)) {
      problem = `chain declares an all-zero SHA-256 for ${path}; not verifiable`;
    } else if (declared.chunkCount === 0) {
      problem = `fileInfo.chunkCount is 0 for ${path}`;
    } else if (declared.size !== evaluation.actualSize) {
      problem = `size mismatch for ${path}: declared ${declared.size}, read ${evaluation.actualSize}`;
    } else if (declared.sha256.toLowerCase() !== evaluation.actualSha256.toLowerCase()) {
      problem = `raw SHA-256 mismatch for ${path}: declared ${declared.sha256}, actual ${evaluation.actualSha256}`;
    } else {
      problem = `file ${path} did not verify at the pinned block`;
    }
  }

  return {
    check: {
      ...evaluation,
      matched,
      chunkCount: declared.chunkCount,
      contentType: declared.contentType,
      updatedAt: declared.updatedAt,
      actualSha256ByOperator,
      actualSizeByOperator,
      declaredByOperator,
      operatorsAgree,
      errors,
    },
    disagreements,
    problem,
  };
}

/**
 * Multi-operator pinned-block verification, following TapeKit SPEC §4.2/§5 and
 * PRD §6.4:
 *
 *   1. read heads from every independent operator; pin
 *      `second-highest head - offset` and reject heads that diverge too far;
 *   2. assert ERC-1967 implementations are allowlisted at that exact block;
 *   3. discover site paths from `pathCount`/`paths`;
 *   4. read every path's `fileInfo` and full bytes from *both* operators at the
 *      pinned block (`read` for ≤ 96 KiB, `readRange` segments above it);
 *   5. require byte-for-byte agreement, then verify size + raw SHA-256 against
 *      the chain-declared values.
 *
 * Bytes are read through public RPC only; verification never writes to chain.
 */
export async function verifySite(options: VerifySiteOptions): Promise<VerificationReport> {
  const startedAt = Date.now();
  const observedAt = new Date().toISOString();
  const config = options.config ?? XLAYER_MAINNET;
  const container = getAddress(options.container);
  const registry = config.registries[0];
  if (registry === undefined) {
    throw new TapeCiError("INTERNAL", "no SiteRegistry configured");
  }

  const operators = options.operators ?? createOperatorClients(config, options.env);
  if (operators.length === 0) {
    throw new TapeCiError("INTERNAL", "verifySite needs at least one operator client");
  }
  const nodeOperators = operators.map((operator) => operator.operator);

  const finish = (
    status: VerificationStatus,
    state: VerificationState,
    values: { registryImplementation: Hex | null; bindingImplementation: Hex | null },
    detail?: string,
  ): VerificationReport => ({
    chainId: config.chainId,
    container,
    registry,
    pinnedBlockNumber: state.pin.pinnedBlockNumber,
    observedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    nodeOperators,
    registryImplementation: values.registryImplementation,
    bindingImplementation: values.bindingImplementation,
    checks: state.checks,
    status,
    paths: state.paths,
    fallbackPath: state.fallbackPath,
    pin: state.pin,
    implementations: state.implementations,
    disagreements: state.disagreements,
    ...(detail === undefined ? {} : { detail }),
  });

  const emptyState = (pin: PinEvidence): VerificationState => ({
    pin,
    paths: [],
    fallbackPath: "",
    implementations: [],
    checks: [],
    disagreements: [],
  });
  const noImplementations = {
    registryImplementation: null,
    bindingImplementation: null,
  } as const;

  // ---- 1. operator heads / chain id -------------------------------------------------
  const headObservations = await Promise.all(
    operators.map(async (operator) => {
      try {
        const [chainId, head] = await Promise.all([
          operator.client.getChainId(),
          operator.client.getBlockNumber(),
        ]);
        return {
          operator: operator.operator,
          url: operator.url,
          chainId,
          head: Number(head),
          error: null as string | null,
        };
      } catch (error) {
        return {
          operator: operator.operator,
          url: operator.url,
          chainId: null,
          head: null,
          error: errorMessage(error),
        };
      }
    }),
  );
  const heads: OperatorHead[] = headObservations.map((observation) => ({
    operator: observation.operator,
    url: observation.url,
    chainId: observation.chainId,
    head: observation.head,
  }));
  const headErrors = headObservations.filter((observation) => observation.error !== null);
  if (headErrors.length > 0) {
    return finish(
      "INCOMPLETE",
      emptyState(unavailablePin(heads, config)),
      noImplementations,
      `operator head query failed: ${headErrors
        .map((observation) => `${observation.operator}: ${observation.error}`)
        .join("; ")}`,
    );
  }
  const wrongChain = headObservations.filter(
    (observation) => observation.chainId !== config.chainId,
  );
  if (wrongChain.length > 0) {
    return finish(
      "INCOMPLETE",
      emptyState(unavailablePin(heads, config)),
      noImplementations,
      `chainId mismatch: ${wrongChain
        .map((observation) => `${observation.operator} reports ${observation.chainId}`)
        .join(", ")}; expected ${config.chainId}`,
    );
  }

  const headNumbers = headObservations.map((observation) => observation.head as number);
  const sortedHeads = [...headNumbers].sort((a, b) => b - a);
  const maxHead = sortedHeads[0] as number;
  const secondHighestHead = sortedHeads[1] as number;
  const divergenceBlocks = maxHead - secondHighestHead;

  let strategy: PinEvidence["strategy"];
  let pinnedBlockNumber: number;
  let formula: string;
  if (options.pinnedBlock !== undefined) {
    const explicit = Number(parsePinnedBlockOption(options.pinnedBlock));
    if (explicit > secondHighestHead) {
      return finish(
        "INCOMPLETE",
        emptyState(unavailablePin(heads, config)),
        noImplementations,
        `caller-supplied pinned block ${explicit} is ahead of the second-highest operator head ${secondHighestHead}`,
      );
    }
    strategy = "caller-supplied";
    pinnedBlockNumber = explicit;
    formula = `caller-supplied pinnedBlockNumber = ${explicit} (second-highest operator head ${secondHighestHead}, offset ${config.pin.offset} not applied)`;
  } else {
    if (divergenceBlocks > config.pin.maxLagBlocks) {
      return finish(
        "INCOMPLETE",
        emptyState(unavailablePin(heads, config)),
        noImplementations,
        `operator heads diverge by ${divergenceBlocks} blocks (max ${config.pin.maxLagBlocks}); refusing to pin`,
      );
    }
    const selection = selectPinnedBlock(headNumbers, config.pin.offset, config.pin.maxLagBlocks);
    strategy = "second-highest-operator-head-minus-offset";
    pinnedBlockNumber = selection.pinnedBlockNumber;
    formula = `pinnedBlockNumber = secondHighestHead - offset = ${selection.secondHighestHead} - ${config.pin.offset} = ${selection.pinnedBlockNumber}`;
  }
  const pinnedBlock = BigInt(pinnedBlockNumber);

  // ---- 2. prove both operators serve the same block header --------------------------
  const blockReads = await Promise.all(
    operators.map(async (operator) => {
      try {
        const block = await operator.client.getBlock({ blockNumber: pinnedBlock });
        return {
          operator: operator.operator,
          hash: block.hash,
          timestamp: Number(block.timestamp),
          error: null as string | null,
        };
      } catch (error) {
        return {
          operator: operator.operator,
          hash: null,
          timestamp: null,
          error: errorMessage(error),
        };
      }
    }),
  );
  const blockErrors = blockReads.filter((read) => read.error !== null);
  if (blockErrors.length > 0) {
    return finish(
      "INCOMPLETE",
      emptyState(unavailablePin(heads, config)),
      noImplementations,
      `pinned block ${pinnedBlockNumber} is not readable by every operator: ${blockErrors
        .map((read) => `${read.operator}: ${read.error}`)
        .join("; ")}`,
    );
  }
  const blockHashes = blockReads.map((read) => read.hash ?? null);
  if (blockHashes.some((hash) => hash === null)) {
    return finish(
      "INCOMPLETE",
      emptyState(unavailablePin(heads, config)),
      noImplementations,
      `pinned block ${pinnedBlockNumber} has no header hash from every operator`,
    );
  }
  const blockHash = blockHashes[0] ?? null;
  const lowerBlockHashes = blockHashes.map((hash) => hash?.toLowerCase() ?? null);
  const headerDisagreement: DisagreementDetail | null =
    new Set(lowerBlockHashes).size > 1
      ? {
          path: null,
          field: "block.hash",
          operators: nodeOperators,
          values: Object.fromEntries(
            blockReads.map((read) => [read.operator, read.hash ?? null]),
          ),
          message: `operators returned different block hashes for block ${pinnedBlockNumber}`,
        }
      : null;
  const pinnedBlockTimestamp = blockReads[0]?.timestamp ?? null;
  const blockAgeSeconds =
    pinnedBlockTimestamp === null ? null : Math.round(Date.now() / 1000) - pinnedBlockTimestamp;

  const pin: PinEvidence = {
    strategy,
    heads,
    sortedHeads,
    secondHighestHead,
    offset: config.pin.offset,
    pinnedBlockNumber,
    maxHead,
    divergenceBlocks,
    pinLagBlocks: maxHead - pinnedBlockNumber,
    maxLagBlocks: config.pin.maxLagBlocks,
    formula,
    pinnedBlockHash: blockHash,
    pinnedBlockTimestamp,
    blockAgeSeconds,
  };
  if (headerDisagreement !== null) {
    return finish(
      "DISAGREEMENT",
      {
        pin,
        paths: [],
        fallbackPath: "",
        implementations: [],
        checks: [],
        disagreements: [headerDisagreement],
      },
      noImplementations,
      headerDisagreement.message,
    );
  }

  // ---- 3. ERC-1967 implementations at the pinned block -----------------------------
  const implementationReads = await Promise.all(
    operators.map(async (operator) => {
      try {
        const observations = await checkAllImplementations(
          operator.client,
          config,
          pinnedBlock,
        );
        return { operator: operator.operator, observations, error: null as unknown };
      } catch (error) {
        return { operator: operator.operator, observations: null, error };
      }
    }),
  );
  const implementationErrors = implementationReads.filter((read) => read.error !== null);
  if (implementationErrors.length > 0) {
    const allUnsupported = implementationErrors.every(
      (read) => isTapeCiError(read.error) && read.error.code === "IMPLEMENTATION_CHANGED",
    );
    return finish(
      allUnsupported ? "UNSUPPORTED_IMPLEMENTATION" : "INCOMPLETE",
      emptyState(pin),
      noImplementations,
      `implementation read failed at block ${pinnedBlockNumber}: ${implementationErrors
        .map((read) => `${read.operator}: ${errorMessage(read.error)}`)
        .join("; ")}`,
    );
  }

  const implementations: ImplementationEvidence[] = [];
  const implementationDisagreements: DisagreementDetail[] = [];
  for (const entry of config.allowlist) {
    const byOperator: Record<string, Hex | null> = {};
    const codeSizes: Record<string, number | null> = {};
    for (const read of implementationReads) {
      const observation: ImplementationObservation | null =
        read.observations?.find((candidate) => candidate.role === entry.role) ?? null;
      byOperator[read.operator] = observation?.implementation ?? null;
      codeSizes[read.operator] = observation?.codeSize ?? null;
    }
    const values = Object.values(byOperator);
    const minimumOperators = options.allowSingleOperator === true ? 1 : 2;
    const operatorsAgree =
      values.length >= minimumOperators &&
      values.every(
        (value) => value !== null && values[0] !== null && value === values[0],
      );
    const primary = byOperator[operators[0]?.operator ?? ""] ?? null;
    const allowlisted =
      primary !== null &&
      entry.implementations.some(
        (candidate) => candidate.toLowerCase() === primary.toLowerCase(),
      );
    implementations.push({
      role: entry.role,
      proxy: entry.proxy,
      implementation: primary,
      allowlisted,
      codeSize: codeSizes[operators[0]?.operator ?? ""] ?? 0,
      expected: entry.implementations,
      byOperator,
      operatorsAgree,
    });
    if (!operatorsAgree) {
      implementationDisagreements.push({
        path: null,
        field: `implementation.${entry.role}`,
        operators: nodeOperators,
        values: byOperator,
        message: `operators returned different ${entry.role} implementations at block ${pinnedBlockNumber}`,
      });
    }
  }
  const registryImplementation =
    implementations.find((entry) => entry.role === "siteRegistry")?.implementation ?? null;
  const bindingImplementation =
    implementations.find((entry) => entry.role === "domainBinding")?.implementation ?? null;
  const implementationValues = { registryImplementation, bindingImplementation };

  if (implementationDisagreements.length > 0) {
    return finish(
      "DISAGREEMENT",
      { ...emptyState(pin), implementations, disagreements: implementationDisagreements },
      implementationValues,
      implementationDisagreements.map((item) => item.message).join("; "),
    );
  }
  const unsupported = implementations.filter(
    (entry) => !entry.allowlisted || entry.codeSize === 0,
  );
  if (unsupported.length > 0) {
    return finish(
      "UNSUPPORTED_IMPLEMENTATION",
      { ...emptyState(pin), implementations },
      implementationValues,
      `implementation not allowlisted at block ${pinnedBlockNumber}: ${unsupported
        .map((entry) => `${entry.role}=${entry.implementation ?? "unreadable"}`)
        .join(", ")}`,
    );
  }

  // ---- 4. site metadata: paths + fallback ------------------------------------------
  const canonicalPaths =
    options.paths === undefined
      ? null
      : [...new Set(options.paths.map((path) => canonicalizeSitePath(path)))];
  if (canonicalPaths !== null && canonicalPaths.length === 0) {
    return finish(
      "INCOMPLETE",
      { ...emptyState(pin), implementations },
      implementationValues,
      "no paths were supplied to verify",
    );
  }

  const metadataReads = await Promise.all(
    operators.map(async (operator): Promise<SiteMetadata | { operator: string; error: string }> => {
      try {
        if (canonicalPaths === null) {
          const [count, pathList, fallback] = await Promise.all([
            pathCountAt(operator.client, registry, container, pinnedBlock),
            pathsAt(operator.client, registry, container, pinnedBlock),
            fallbackPathAt(operator.client, registry, container, pinnedBlock),
          ]);
          return { operator: operator.operator, pathCount: count, paths: pathList, fallbackPath: fallback };
        }
        const fallback = await fallbackPathAt(operator.client, registry, container, pinnedBlock);
        return {
          operator: operator.operator,
          pathCount: canonicalPaths.length,
          paths: canonicalPaths,
          fallbackPath: fallback,
        };
      } catch (error) {
        return { operator: operator.operator, error: errorMessage(error) };
      }
    }),
  );
  const metadataErrors = metadataReads.filter(
    (read): read is { operator: string; error: string } => "error" in read,
  );
  if (metadataErrors.length > 0) {
    return finish(
      "INCOMPLETE",
      { ...emptyState(pin), implementations },
      implementationValues,
      `site metadata read failed: ${metadataErrors
        .map((read) => `${read.operator}: ${read.error}`)
        .join("; ")}`,
    );
  }
  const metadata = metadataReads.filter((read): read is SiteMetadata => !("error" in read));
  const primaryMetadata = metadata[0];
  if (primaryMetadata === undefined) {
    return finish(
      "INCOMPLETE",
      { ...emptyState(pin), implementations },
      implementationValues,
      "no operator returned site metadata",
    );
  }

  const metadataDisagreements: DisagreementDetail[] = [];
  if (canonicalPaths === null) {
    const counts: Record<string, number> = {};
    for (const read of metadata) counts[read.operator] = read.pathCount;
    if (new Set(Object.values(counts)).size > 1) {
      metadataDisagreements.push({
        path: null,
        field: "pathCount",
        operators: nodeOperators,
        values: counts,
        message: `operators disagree on pathCount at block ${pinnedBlockNumber}`,
      });
    }
    const pathLists: Record<string, string> = {};
    for (const read of metadata) pathLists[read.operator] = JSON.stringify(read.paths);
    if (new Set(Object.values(pathLists)).size > 1) {
      metadataDisagreements.push({
        path: null,
        field: "paths",
        operators: nodeOperators,
        values: pathLists,
        message: `operators disagree on the path list at block ${pinnedBlockNumber}`,
      });
    }
  }
  const fallbacks: Record<string, string> = {};
  for (const read of metadata) fallbacks[read.operator] = read.fallbackPath;
  if (new Set(Object.values(fallbacks)).size > 1) {
    metadataDisagreements.push({
      path: null,
      field: "fallbackPath",
      operators: nodeOperators,
      values: fallbacks,
      message: `operators disagree on fallbackPath at block ${pinnedBlockNumber}`,
    });
  }

  const discoveredPaths =
    canonicalPaths ??
    [...new Set(primaryMetadata.paths)];
  if (metadataDisagreements.length > 0) {
    return finish(
      "DISAGREEMENT",
      {
        ...emptyState(pin),
        implementations,
        paths: discoveredPaths,
        fallbackPath: primaryMetadata.fallbackPath,
        disagreements: metadataDisagreements,
      },
      implementationValues,
      metadataDisagreements.map((item) => item.message).join("; "),
    );
  }
  if (discoveredPaths.length === 0 || (canonicalPaths === null && primaryMetadata.pathCount === 0)) {
    return finish(
      "INCOMPLETE",
      {
        ...emptyState(pin),
        implementations,
        paths: discoveredPaths,
        fallbackPath: primaryMetadata.fallbackPath,
      },
      implementationValues,
      `container has no files on chain (pathCount=${primaryMetadata.pathCount}) at block ${pinnedBlockNumber}`,
    );
  }
  if (
    canonicalPaths === null &&
    primaryMetadata.pathCount !== primaryMetadata.paths.length
  ) {
    return finish(
      "INCOMPLETE",
      {
        ...emptyState(pin),
        implementations,
        paths: primaryMetadata.paths,
        fallbackPath: primaryMetadata.fallbackPath,
      },
      implementationValues,
      `pathCount=${primaryMetadata.pathCount} but paths() returned ${primaryMetadata.paths.length} entries at block ${pinnedBlockNumber}`,
    );
  }
  if (discoveredPaths.length > MAX_VERIFY_PATHS) {
    return finish(
      "INCOMPLETE",
      {
        ...emptyState(pin),
        implementations,
        paths: discoveredPaths.slice(0, MAX_VERIFY_PATHS),
        fallbackPath: primaryMetadata.fallbackPath,
      },
      implementationValues,
      `site has ${discoveredPaths.length} paths, above the supported ${MAX_VERIFY_PATHS}`,
    );
  }

  // ---- 5. per-file byte verification through both operators ------------------------
  const checks: FileCheck[] = [];
  const fileDisagreements: DisagreementDetail[] = [];
  const problems: string[] = [];
  for (const path of discoveredPaths) {
    const reads = await Promise.all(
      operators.map((operator: OperatorClient) =>
        readOperatorFile(operator.client, operator.operator, registry, container, path, pinnedBlock),
      ),
    );
    const evaluated = evaluatePathReads(path, reads, nodeOperators);
    checks.push(evaluated.check);
    fileDisagreements.push(...evaluated.disagreements);
    if (evaluated.problem !== null) problems.push(evaluated.problem);
  }

  if (fileDisagreements.length > 0) {
    return finish(
      "DISAGREEMENT",
      {
        pin,
        paths: discoveredPaths,
        fallbackPath: primaryMetadata.fallbackPath,
        implementations,
        checks,
        disagreements: fileDisagreements,
      },
      implementationValues,
      `${fileDisagreements.length} disagreement(s): ${fileDisagreements
        .map((item) => item.message)
        .join("; ")}`,
    );
  }
  if (problems.length > 0 || checks.some((check) => !check.matched)) {
    return finish(
      "INCOMPLETE",
      {
        pin,
        paths: discoveredPaths,
        fallbackPath: primaryMetadata.fallbackPath,
        implementations,
        checks,
        disagreements: [],
      },
      implementationValues,
      problems.length > 0
        ? problems.join("; ")
        : "one or more files did not verify at the pinned block",
    );
  }

  return finish(
    "VERIFIED",
    {
      pin,
      paths: discoveredPaths,
      fallbackPath: primaryMetadata.fallbackPath,
      implementations,
      checks,
      disagreements: [],
    },
    implementationValues,
  );
}
