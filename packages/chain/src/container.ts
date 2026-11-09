import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  getAddress,
  isAddressEqual,
  type Address,
  type Hex,
} from "viem";
import type { ChainConfig } from "@tapeci/config";
import { TapeCiError } from "@tapeci/shared";
import { containerAbi, factoryAbi, openerAbi, processorAbi } from "./abis.js";
import type { ReadClient } from "./clients.js";

export interface ProcessorToken {
  readonly processorIndex: number;
  readonly processor: Hex;
  readonly tokenId: bigint;
  readonly container: Hex;
  readonly owner: Hex;
  readonly opened: boolean;
}

/**
 * `"verified"` — every value is a real chain read and `false` is a real answer.
 * `"not_found"` — the chain explicitly said this address holds no TapeOut container
 * token (a revert or empty return, never a transport failure).
 * `"unavailable"` — at least one read failed; unknown values are `null` and no
 * "not opened" / "no circuit" conclusion may be drawn (SPEC §8.6).
 *
 * Same union as `WalletResource["readStatus"]` (SPEC §5); `tests/unit/resource-discovery.test.ts`
 * asserts the two stay identical, so the chain layer does not import the resource DTO.
 */
export type ContainerReadStatus = "verified" | "not_found" | "unavailable";

/** Which read left the facts unknown. Only produced with `readStatus: "unavailable"`. */
export type ContainerReadStage =
  | "block"
  | "token"
  | "processor"
  | "derivation"
  | "owner"
  | "deployed"
  | "opened";

export interface ContainerReadFailure {
  readonly stage: ContainerReadStage;
  readonly message: string;
}

/** Why the chain says this address is not a TapeOut container. */
export type ContainerNotFoundReason =
  | "not_tapeout_container"
  | "processor_not_registered"
  | "derivation_mismatch"
  | "token_does_not_exist";

/** Every fact `inspectContainer` can establish; `null` always means "not established". */
interface ContainerFacts {
  readonly tokenChainId: bigint | null;
  readonly processor: Hex | null;
  readonly tokenId: bigint | null;
  readonly derivedContainer: Hex | null;
  readonly derivedMatches: boolean | null;
  readonly isProcessor: boolean | null;
  readonly owner: Hex | null;
  /** Opener `isDeployed`: `false` is a real answer, `null` means the read failed. */
  readonly deployed: boolean | null;
  /** Opener `isOpened`: `false` is a real answer, `null` means the read failed. */
  readonly opened: boolean | null;
}

interface ContainerInspectionBase extends ContainerFacts {
  readonly container: Hex;
  readonly readStatus: ContainerReadStatus;
  /** Block every read was pinned to; `null` only when the head itself was unreadable. */
  readonly observedBlock: bigint | null;
  readonly processorIndex: number | null;
}

/**
 * The chain answered every question. `isProcessor` and `derivedMatches` are `true`
 * by construction (any other value produces `not_found`); they stay `boolean` so
 * existing guards keep type-checking.
 */
export interface VerifiedContainerInspection extends ContainerInspectionBase {
  readonly readStatus: "verified";
  readonly tokenChainId: bigint;
  readonly processor: Hex;
  readonly tokenId: bigint;
  readonly derivedContainer: Hex;
  readonly derivedMatches: boolean;
  readonly isProcessor: boolean;
  readonly owner: Hex;
  readonly deployed: boolean;
  readonly opened: boolean;
  readonly observedBlock: bigint;
  readonly reason: null;
  readonly failure: null;
}

/** Explicit absence: a revert/empty return, or a valid account that is not the derivation. */
export interface NotFoundContainerInspection extends ContainerInspectionBase {
  readonly readStatus: "not_found";
  readonly reason: ContainerNotFoundReason;
  readonly owner: null;
  readonly deployed: null;
  readonly opened: null;
  readonly failure: null;
}

/** A failed read. Facts that did succeed are kept; the rest stay `null`, never `false`. */
export interface UnavailableContainerInspection extends ContainerInspectionBase {
  readonly readStatus: "unavailable";
  readonly reason: null;
  readonly failure: ContainerReadFailure;
}

export type ContainerInspection =
  | VerifiedContainerInspection
  | NotFoundContainerInspection
  | UnavailableContainerInspection;

type ReadResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** No fact is known yet: every field stays `null` instead of guessing `false`. */
const NO_FACTS: ContainerFacts = {
  tokenChainId: null,
  processor: null,
  tokenId: null,
  derivedContainer: null,
  derivedMatches: null,
  isProcessor: null,
  owner: null,
  deployed: null,
  opened: null,
};

/** Derive a container from (processor index, tokenId) — never trust a caller-supplied container. */
export async function deriveContainer(
  client: ReadClient,
  config: ChainConfig,
  processorIndex: number,
  tokenId: bigint,
  blockNumber?: bigint,
): Promise<ProcessorToken> {
  const readOptions = blockNumber === undefined ? {} : { blockNumber };
  const processor = await client.readContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: "cpuAt",
    args: [BigInt(processorIndex)],
    ...readOptions,
  });
  const [container, owner, opened] = await Promise.all([
    client.readContract({
      address: config.opener,
      abi: openerAbi,
      functionName: "accountOf",
      args: [processor, tokenId],
      ...readOptions,
    }),
    client.readContract({
      address: processor,
      abi: processorAbi,
      functionName: "ownerOf",
      args: [tokenId],
      ...readOptions,
    }),
    client.readContract({
      address: config.opener,
      abi: openerAbi,
      functionName: "isOpened",
      args: [processor, tokenId],
      ...readOptions,
    }),
  ]);
  return {
    processorIndex,
    processor,
    tokenId,
    container: getAddress(container),
    owner: getAddress(owner),
    opened,
  };
}

/** Resolve the processor index for a processor address (factory has no reverse table). */
export async function findProcessorIndex(
  client: ReadClient,
  config: ChainConfig,
  processor: Hex,
  blockNumber?: bigint,
): Promise<number | null> {
  const readOptions = blockNumber === undefined ? {} : { blockNumber };
  const count = Number(
    await client.readContract({
      address: config.factory,
      abi: factoryAbi,
      functionName: "cpuCount",
      ...readOptions,
    }),
  );
  const CONCURRENCY = 20;
  for (let start = 0; start < count; start += CONCURRENCY) {
    const indexes = Array.from(
      { length: Math.min(CONCURRENCY, count - start) },
      (_, offset) => start + offset,
    );
    const addresses = await Promise.all(
      indexes.map((index) =>
        client.readContract({
          address: config.factory,
          abi: factoryAbi,
          functionName: "cpuAt",
          args: [BigInt(index)],
          ...readOptions,
        }),
      ),
    );
    const hit = indexes.find((_index, offset) =>
      isAddressEqual(addresses[offset] as Address, processor),
    );
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * Inspect a container address claimed by a user. Checks:
 * `container.token()` → (chainId, processor, tokenId), factory.isCPU, recomputed
 * `accountOf` equality, current ERC-721 holder, opener `isDeployed` and `isOpened`
 * (PRD §3.4, SPEC §8.5-8.6).
 *
 * The result is a discriminated union over `readStatus`. A failed read never becomes
 * `opened: false`: `false` only ever comes from a successful `isOpened` call, and an
 * unknown value is `null`. Callers must branch on `readStatus` before drawing any
 * "not opened" conclusion — `assertContainerVerified` does that for them.
 */
export async function inspectContainer(
  client: ReadClient,
  config: ChainConfig,
  containerInput: Hex,
  blockNumber?: bigint,
): Promise<ContainerInspection> {
  const container = getAddress(containerInput);

  // Pin before reading so `observedBlock` proves which block the answer came from.
  const pin: ReadResult<bigint> =
    blockNumber !== undefined
      ? { ok: true, value: blockNumber }
      : await attempt(() => client.getBlockNumber());

  if (!pin.ok) {
    return unavailable({ container, observedBlock: null, facts: NO_FACTS, failure: failureAt("block", pin.error) });
  }
  const observedBlock = pin.value;
  const pinOptions = { blockNumber: observedBlock };

  const tokenRead: ReadResult<readonly [bigint, Address, bigint]> = await attempt(
    () =>
      client.readContract({
        address: container,
        abi: containerAbi,
        functionName: "token",
        ...pinOptions,
      }) as Promise<readonly [bigint, Address, bigint]>,
  );
  if (!tokenRead.ok) {
    // A revert/empty return is the chain saying "not a TapeOut container"; anything
    // else (timeout, 5xx, rate limit) is a failed read and must stay unknown.
    if (isExplicitContractAnswer(tokenRead.error)) {
      return notFound(container, observedBlock, "not_tapeout_container");
    }
    return unavailable({
      container,
      observedBlock,
      facts: NO_FACTS,
      failure: failureAt("token", tokenRead.error),
    });
  }

  const [tokenChainId, processor, tokenId] = tokenRead.value;
  const facts: ContainerFacts = { ...NO_FACTS, tokenChainId, processor, tokenId };

  const [processorRead, derivationRead] = await Promise.all([
    attempt(() =>
      client.readContract({
        address: config.factory,
        abi: factoryAbi,
        functionName: "isCPU",
        args: [processor],
        ...pinOptions,
      }),
    ),
    attempt(() =>
      client.readContract({
        address: config.opener,
        abi: openerAbi,
        functionName: "accountOf",
        args: [processor, tokenId],
        ...pinOptions,
      }),
    ),
  ]);

  const withDerivation: ContainerFacts = derivationRead.ok
    ? { ...facts, derivedContainer: getAddress(derivationRead.value) }
    : facts;

  if (!processorRead.ok) {
    return unavailable({
      container,
      observedBlock,
      facts: withDerivation,
      failure: failureAt("processor", processorRead.error),
    });
  }
  if (!derivationRead.ok) {
    // `accountOf` reverting for a processor that IS registered means the opener has
    // no account for that (processor, tokenId) — explicit absence, not a transport error.
    if (isExplicitContractAnswer(derivationRead.error)) {
      return notFound(container, observedBlock, "token_does_not_exist", { ...withDerivation, isProcessor: processorRead.value });
    }
    return unavailable({
      container,
      observedBlock,
      facts: { ...withDerivation, isProcessor: processorRead.value },
      failure: failureAt("derivation", derivationRead.error),
    });
  }

  const isProcessor = processorRead.value;
  const derivedMatches = isAddressEqual(derivationRead.value, container);
  const settled: ContainerFacts = { ...withDerivation, isProcessor, derivedMatches };

  if (!isProcessor) return notFound(container, observedBlock, "processor_not_registered", settled);
  if (!derivedMatches) return notFound(container, observedBlock, "derivation_mismatch", settled);

  const [ownerRead, deployedRead, openedRead] = await Promise.all([
    attempt(() =>
      client.readContract({
        address: processor,
        abi: processorAbi,
        functionName: "ownerOf",
        args: [tokenId],
        ...pinOptions,
      }),
    ),
    attempt(() =>
      client.readContract({
        address: config.opener,
        abi: openerAbi,
        functionName: "isDeployed",
        args: [processor, tokenId],
        ...pinOptions,
      }),
    ),
    attempt(() =>
      client.readContract({
        address: config.opener,
        abi: openerAbi,
        functionName: "isOpened",
        args: [processor, tokenId],
        ...pinOptions,
      }),
    ),
  ]);

  if (!ownerRead.ok) {
    if (isExplicitContractAnswer(ownerRead.error)) {
      return notFound(container, observedBlock, "token_does_not_exist", settled);
    }
    return unavailable({
      container,
      observedBlock,
      facts: settled,
      failure: failureAt("owner", ownerRead.error),
    });
  }

  const owner = getAddress(ownerRead.value);
  // `deployed`/`opened` are read independently: one failing read must not hide the
  // other's real answer, and neither may fall back to `false`.
  const withOwner: ContainerFacts = {
    ...settled,
    owner,
    ...(deployedRead.ok ? { deployed: deployedRead.value } : {}),
    ...(openedRead.ok ? { opened: openedRead.value } : {}),
  };

  if (!deployedRead.ok) {
    return unavailable({
      container,
      observedBlock,
      facts: withOwner,
      failure: failureAt("deployed", deployedRead.error),
    });
  }
  if (!openedRead.ok) {
    return unavailable({
      container,
      observedBlock,
      facts: withOwner,
      failure: failureAt("opened", openedRead.error),
    });
  }

  return {
    container,
    readStatus: "verified",
    observedBlock,
    tokenChainId,
    processor: getAddress(processor),
    tokenId,
    derivedContainer: getAddress(derivationRead.value),
    derivedMatches: true,
    isProcessor: true,
    owner,
    deployed: deployedRead.value,
    opened: openedRead.value,
    processorIndex: null,
    reason: null,
    failure: null,
  };
}

/**
 * Thrown by `assertContainerVerified` when the read itself failed. It is deliberately
 * not a `TapeCiError`: `CONTAINER_READ_UNAVAILABLE` is not (yet) in the shared
 * `TapeCiErrorCode` union, and reusing `CONTAINER_NOT_OPEN`/`RPC_DISAGREEMENT` would
 * re-create the exact conflation this type exists to prevent. The API resolver maps
 * it to its own `ApiError` instead of relying on the shared status table.
 */
export class ContainerReadUnavailableError extends Error {
  readonly code = "CONTAINER_READ_UNAVAILABLE";
  readonly retryable = true;

  constructor(
    readonly container: Hex,
    readonly stage: ContainerReadStage,
    readonly observedBlock: bigint | null,
    detail: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(
      `could not read container ${container} at ${describeBlock(observedBlock)}: ${detail}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ContainerReadUnavailableError";
  }
}

/**
 * Turn an inspection into the "every fact is known" shape, or throw the error that
 * matches the real outcome. A failed read throws `ContainerReadUnavailableError`,
 * never `CONTAINER_NOT_OPEN`, so a caller cannot render "could not read" as
 * "not activated" (SPEC §8.6).
 */
export function assertContainerVerified(inspection: ContainerInspection): VerifiedContainerInspection {
  if (inspection.readStatus === "verified") return inspection;
  if (inspection.readStatus === "unavailable") {
    throw new ContainerReadUnavailableError(
      inspection.container,
      inspection.failure.stage,
      inspection.observedBlock,
      inspection.failure.message,
    );
  }
  throw new TapeCiError("CONTAINER_NOT_TAPEOUT", notFoundMessage(inspection.container, inspection.reason), {
    details: {
      container: inspection.container,
      reason: inspection.reason,
      observedBlock: toBlockString(inspection.observedBlock),
    },
  });
}

export interface WriteAuthorization {
  readonly container: Hex;
  readonly owner: Hex;
  readonly opened: boolean;
  readonly signer: Hex;
  readonly authorized: boolean;
  readonly reason?: string;
}

/**
 * App-level authorization gate. This is a fail-closed pre-check only: the on-chain
 * `onlyEditor` modifier is the authoritative check (PRD §7.2, §9.2).
 */
export async function checkContainerAuthorization(
  client: ReadClient,
  config: ChainConfig,
  container: Hex,
  signer: Hex,
  blockNumber?: bigint,
): Promise<WriteAuthorization> {
  const inspection = assertContainerVerified(
    await inspectContainer(client, config, container, blockNumber),
  );
  if (inspection.tokenChainId !== BigInt(config.chainId)) {
    throw new TapeCiError("CHAIN_MISMATCH", `container token chainId ${inspection.tokenChainId} != ${config.chainId}`, {
      details: { container, tokenChainId: inspection.tokenChainId.toString() },
    });
  }
  if (!inspection.opened) {
    throw new TapeCiError("CONTAINER_NOT_OPEN", `container ${container} is not opened`, {
      details: { container },
    });
  }
  const authorized = isAddressEqual(inspection.owner, signer);
  return {
    container,
    owner: inspection.owner,
    opened: inspection.opened,
    signer,
    authorized,
    ...(authorized
      ? {}
      : { reason: "signer is not the current circuit holder (operator delegation checked by contract)" }),
  };
}

/** Await a read and classify the outcome without letting the throw escape. */
async function attempt<T>(read: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * `true` only when the chain itself answered: a revert (`ContractFunctionRevertedError`)
 * or a call that returned no data at all (`ContractFunctionZeroDataError`, i.e. the
 * address is not a contract). Timeouts, HTTP 5xx, rate limits and decode failures are
 * *not* answers and must stay `unavailable`.
 */
function isExplicitContractAnswer(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError,
    ) !== null
  );
}

function failureAt(stage: ContainerReadStage, error: unknown): ContainerReadFailure {
  return { stage, message: describeError(error) };
}

function describeError(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  if (error instanceof Error) return error.message;
  return String(error);
}

function describeBlock(block: bigint | null): string {
  return block === null ? "an unpinned head" : `block ${block}`;
}

/** Base-10 block string for evidence/details; `null` stays `null`, never `"0"`. */
function toBlockString(block: bigint | null): string | null {
  return block === null ? null : block.toString();
}

function notFoundMessage(container: Hex, reason: ContainerNotFoundReason): string {
  if (reason === "not_tapeout_container") return `address ${container} is not an ERC-6551 TapeOut container`;
  if (reason === "processor_not_registered") return `container ${container} names a processor the factory does not list`;
  if (reason === "derivation_mismatch") return `container ${container} is not the opener derivation of its token`;
  return `circuit for container ${container} does not exist`;
}

function unavailable(input: {
  readonly container: Hex;
  readonly observedBlock: bigint | null;
  readonly facts: ContainerFacts;
  readonly failure: ContainerReadFailure;
}): UnavailableContainerInspection {
  return {
    container: input.container,
    readStatus: "unavailable",
    observedBlock: input.observedBlock,
    ...input.facts,
    processorIndex: null,
    reason: null,
    failure: input.failure,
  };
}

function notFound(
  container: Hex,
  observedBlock: bigint,
  reason: ContainerNotFoundReason,
  facts: ContainerFacts = NO_FACTS,
): NotFoundContainerInspection {
  return {
    container,
    readStatus: "not_found",
    observedBlock,
    ...facts,
    // Absence is not an ownership fact: these stay unknown even if a sibling read succeeded.
    owner: null,
    deployed: null,
    opened: null,
    processorIndex: null,
    reason,
    failure: null,
  };
}
