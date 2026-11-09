/**
 * Public resource discovery — SPEC §7.2, §8.5–§8.6.
 *
 * Three reads, all on one pinned block:
 * - `listProcessors` — the trusted Factory catalogue plus index coverage.
 * - `listWalletResources` — candidates from the index, each re-verified on chain.
 * - `inspectResource` — one `(processor, tokenId)` pair; the container is always
 *   derived server-side from `opener.accountOf` (§2), never supplied by a caller.
 *
 * The invariants this module exists to protect:
 * - `false` only ever comes from a successful `isDeployed`/`isOpened` call. A
 *   failed read projects `readStatus: "unavailable"` with `null` facts, so a
 *   transport error can never be rendered as "not opened" (§8.6).
 * - A page with unverified coverage is never `complete`, so an unfinished scan
 *   cannot be presented as "this wallet owns nothing" (§8.4).
 * - Nothing private is projected: `WalletResource` has no user id, repository,
 *   project or contact fields, so a public caller cannot widen the response by
 *   knowing the address (see the route module).
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type Hex,
} from "viem";
import type { ChainConfig } from "@tapeci/config";
import {
  inspectContainer,
  openerAbi,
  processorAbi,
  type ReadClient,
} from "@tapeci/chain";
import type {
  ResourceRef,
  ResourceSyncStatus,
  WalletResource,
  WalletResourcePage,
} from "@tapeci/shared";
import {
  decodeResourceCursor,
  encodeResourceCursor,
  readProcessorCatalogue,
  readResourceIndexSnapshot,
  type ProcessorRef,
  type ResourceIndexReader,
  type ResourceIndexSnapshot,
} from "./resource-index.js";
import { ApiError } from "./errors.js";

/** v1 is single-network (§1); the DTOs encode the literal. */
const CHAIN_ID = 196;
/** Bounded parallelism: a page is at most 100 rows and the RPCs rate-limit. */
const VERIFY_CONCURRENCY = 4;

export interface ResourceDiscoveryDeps {
  readonly client: ReadClient;
  readonly config: ChainConfig;
  readonly index: ResourceIndexReader;
}

export interface ProcessorCatalogue {
  readonly chainId: 196;
  readonly processors: readonly ProcessorRef[];
  readonly syncStatus: ResourceSyncStatus;
  readonly complete: boolean;
  readonly indexedThroughBlock: string | null;
  readonly observedBlock: string | null;
}

export interface WalletResourceQuery {
  readonly address: Hex;
  /** Opaque cursor returned as `nextCursor` by a previous page. */
  readonly cursor: string | null;
  readonly limit: number;
}

export interface ResourceInspectionInput {
  readonly processor: Hex;
  /** Base-10 string at the HTTP boundary; base 10 here, never `Number`. */
  readonly tokenId: bigint;
  /** Pin every read to this block; default: the current head. */
  readonly blockNumber?: bigint;
}

/** Factory catalogue and how far the index has caught up with it (§8.1, §7.2). */
export async function listProcessors(deps: ResourceDiscoveryDeps): Promise<ProcessorCatalogue> {
  const chainId = requireXLayer(deps.config);
  const head = await attempt(() => deps.client.getBlockNumber());
  if (!head.ok) {
    return {
      chainId,
      processors: [],
      syncStatus: "unavailable",
      complete: false,
      indexedThroughBlock: null,
      observedBlock: null,
    };
  }
  const catalogue = await attempt(() =>
    readProcessorCatalogue(deps.client, deps.config, head.value),
  );
  if (!catalogue.ok) {
    return {
      chainId,
      processors: [],
      syncStatus: "unavailable",
      complete: false,
      indexedThroughBlock: null,
      observedBlock: head.value.toString(10),
    };
  }
  const snapshot = await readSnapshot(deps.index, catalogue.value);
  return {
    chainId,
    processors: catalogue.value,
    syncStatus: snapshot.syncStatus,
    complete: snapshot.complete,
    indexedThroughBlock: toBlockString(snapshot.indexedThroughBlock),
    observedBlock: head.value.toString(10),
  };
}

/**
 * One page of a wallet's circuits (§7.2). Candidates come from the verified
 * `Transfer` index; every row is re-read on chain at `blockNumber` before it is
 * projected, so a stale index snapshot never becomes an ownership claim (§8.5).
 */
export async function listWalletResources(
  deps: ResourceDiscoveryDeps,
  query: WalletResourceQuery,
): Promise<WalletResourcePage> {
  const chainId = requireXLayer(deps.config);
  const address = normalizeAddress(query.address);
  const after = query.cursor === null ? null : decodeResourceCursor(query.cursor);
  if (query.cursor !== null && after === null) {
    throw new ApiError(400, "INVALID_CURSOR", "cursor is not a position this API issued");
  }

  const unavailablePage = (observedBlock: string | null, indexedThroughBlock: string | null): WalletResourcePage => ({
    address,
    chainId,
    resources: [],
    nextCursor: null,
    syncStatus: "unavailable",
    complete: false,
    indexedThroughBlock,
    observedBlock,
  });

  // Pin once: every row on this page answers about the same block.
  const head = await attempt(() => deps.client.getBlockNumber());
  if (!head.ok) return unavailablePage(null, null);
  const pinnedBlock = head.value;
  const catalogue = await attempt(() =>
    readProcessorCatalogue(deps.client, deps.config, pinnedBlock),
  );
  if (!catalogue.ok) return unavailablePage(pinnedBlock.toString(10), null);
  const snapshot = await readSnapshot(deps.index, catalogue.value);
  const page = await attempt(() =>
    deps.index.listByOwner({ owner: address, after, limit: query.limit }),
  );
  const indexedThroughBlock = toBlockString(snapshot.indexedThroughBlock);
  if (!page.ok) return unavailablePage(pinnedBlock.toString(10), indexedThroughBlock);

  const catalogueIndex = new Map(
    catalogue.value.map((ref) => [ref.processor, ref.processorIndex]),
  );
  const resources = await mapWithConcurrency(page.value.rows, VERIFY_CONCURRENCY, (row) => {
    const processorIndex = catalogueIndex.get(row.processor);
    if (processorIndex === undefined) {
      // An index row for a processor the Factory no longer lists cannot be
      // verified. Stay unknown rather than claiming the circuit is absent.
      return Promise.resolve(
        unknownResource(
          {
            resource: {
              chainId,
              processor: row.processor,
              tokenId: row.tokenId.toString(10),
            },
            processorIndex: row.processorIndex,
          },
          pinnedBlock.toString(10),
        ),
      );
    }
    return verifyCandidate(deps, {
      processor: row.processor,
      processorIndex,
      tokenId: row.tokenId,
      blockNumber: pinnedBlock,
    });
  });

  return {
    address,
    chainId,
    resources,
    nextCursor:
      page.value.nextCursor === null ? null : encodeResourceCursor(page.value.nextCursor),
    syncStatus: snapshot.syncStatus,
    complete: snapshot.complete,
    indexedThroughBlock,
    observedBlock: pinnedBlock.toString(10),
  };
}

/**
 * One circuit by `(processor, tokenId)` — the manual lookup §8 closes with
 * ("先提供 processor + tokenId 手工 inspect"). This does not need the index:
 * the container is derived from the trusted opener and then verified.
 */
export async function inspectResource(
  deps: ResourceDiscoveryDeps,
  input: ResourceInspectionInput,
): Promise<WalletResource> {
  requireXLayer(deps.config);
  const processor = normalizeAddress(input.processor);
  const head = await attempt(() =>
    input.blockNumber === undefined
      ? deps.client.getBlockNumber()
      : Promise.resolve(input.blockNumber),
  );
  if (!head.ok) {
    throw new ApiError(
      503,
      "RESOURCE_READ_UNAVAILABLE",
      "could not read the chain head to pin the inspection",
      {},
      true,
    );
  }
  const pinnedBlock = head.value;
  const catalogue = await attempt(() =>
    readProcessorCatalogue(deps.client, deps.config, pinnedBlock),
  );
  if (!catalogue.ok) {
    throw new ApiError(
      503,
      "RESOURCE_READ_UNAVAILABLE",
      "could not read the factory processor catalogue",
      { observedBlock: pinnedBlock.toString(10) },
      true,
    );
  }
  const ref = catalogue.value.find((entry) => entry.processor === processor);
  if (ref === undefined) {
    // §8.1: a caller-supplied address must not extend the trusted catalogue.
    throw new ApiError(
      422,
      "PROCESSOR_NOT_REGISTERED",
      `processor ${processor} is not in the factory catalogue`,
      { processor, observedBlock: pinnedBlock.toString(10) },
    );
  }
  return verifyCandidate(deps, {
    processor,
    processorIndex: ref.processorIndex,
    tokenId: input.tokenId,
    blockNumber: pinnedBlock,
  });
}

/**
 * Re-read one candidate at a fixed block (§8.5):
 * `accountOf` → `inspectContainer` (chainId/processor/derivation/owner/isDeployed/
 * isOpened), with one fallback the container read cannot cover — a circuit whose
 * container is derived but **not deployed yet** has no code at that address, so
 * `container.token()` cannot answer. That case is still a real owned asset and is
 * verified through `ownerOf`/`isDeployed`/`isOpened` instead of being dropped.
 */
async function verifyCandidate(
  deps: ResourceDiscoveryDeps,
  input: {
    readonly processor: Hex;
    readonly processorIndex: number;
    readonly tokenId: bigint;
    readonly blockNumber: bigint;
  },
): Promise<WalletResource> {
  const chainId = requireXLayer(deps.config);
  const processor = normalizeAddress(input.processor);
  const pinnedBlock = input.blockNumber;
  const observedBlock = pinnedBlock.toString(10);
  const shell = {
    resource: { chainId, processor, tokenId: input.tokenId.toString(10) },
    processorIndex: input.processorIndex,
  } satisfies { resource: ResourceRef; processorIndex: number };

  const containerRead = await attempt(() =>
    deps.client.readContract({
      address: deps.config.opener,
      abi: openerAbi,
      functionName: "accountOf",
      args: [processor, input.tokenId],
      blockNumber: pinnedBlock,
    }),
  );
  if (!containerRead.ok) {
    return isExplicitContractAnswer(containerRead.error)
      ? notFoundResource(shell, observedBlock)
      : unknownResource(shell, observedBlock);
  }
  const container = normalizeAddress(containerRead.value);

  const inspection = await attempt(() =>
    inspectContainer(deps.client, deps.config, container, pinnedBlock),
  );
  if (!inspection.ok) return unknownResource(shell, observedBlock);

  const facts = inspection.value;
  if (facts.readStatus === "verified") {
    // `inspectContainer` starts from the container's own `token()`; these three
    // checks prove it describes the circuit this candidate asked about.
    if (facts.tokenId !== input.tokenId) return notFoundResource(shell, observedBlock);
    if (normalizeAddress(facts.processor) !== processor) return notFoundResource(shell, observedBlock);
    if (facts.tokenChainId !== BigInt(CHAIN_ID)) return notFoundResource(shell, observedBlock);
    return {
      ...shell,
      container,
      owner: normalizeAddress(facts.owner),
      // Real chain answers: `false` here is a fact, not a missing read.
      deployed: facts.deployed,
      opened: facts.opened,
      observedBlock: facts.observedBlock.toString(10),
      readStatus: "verified",
    };
  }
  if (facts.readStatus === "unavailable") {
    return unknownResource(shell, toBlockString(facts.observedBlock));
  }
  if (facts.reason === "token_does_not_exist" || facts.reason === "processor_not_registered") {
    return notFoundResource(shell, observedBlock);
  }
  if (facts.reason === "derivation_mismatch") {
    // The opener derived this address but its own token() names another
    // (processor, tokenId). Contradictory facts: no conclusion is safe.
    return unknownResource(shell, observedBlock);
  }
  return verifyUndeployedCandidate(deps, {
    processor,
    processorIndex: input.processorIndex,
    tokenId: input.tokenId,
    container,
    blockNumber: pinnedBlock,
  });
}

/** The `not_tapeout_container` fallback: `isDeployed === false` is a real circuit. */
async function verifyUndeployedCandidate(
  deps: ResourceDiscoveryDeps,
  input: {
    readonly processor: Hex;
    readonly processorIndex: number;
    readonly tokenId: bigint;
    readonly container: Hex;
    readonly blockNumber: bigint;
  },
): Promise<WalletResource> {
  const { processor, tokenId, blockNumber } = input;
  const observedBlock = blockNumber.toString(10);
  const shell = {
    resource: { chainId: CHAIN_ID, processor, tokenId: tokenId.toString(10) },
    processorIndex: input.processorIndex,
  } satisfies { resource: ResourceRef; processorIndex: number };

  const deployedRead = await attempt(() =>
    deps.client.readContract({
      address: deps.config.opener,
      abi: openerAbi,
      functionName: "isDeployed",
      args: [processor, tokenId],
      blockNumber,
    }),
  );
  if (!deployedRead.ok) return unknownResource(shell, observedBlock);
  if (deployedRead.value) {
    // `isDeployed` says the account exists, yet its `token()` did not answer.
    // The two reads disagree, so nothing is established.
    return unknownResource(shell, observedBlock);
  }

  const [ownerRead, openedRead] = await Promise.all([
    attempt(() =>
      deps.client.readContract({
        address: processor,
        abi: processorAbi,
        functionName: "ownerOf",
        args: [tokenId],
        blockNumber,
      }),
    ),
    attempt(() =>
      deps.client.readContract({
        address: deps.config.opener,
        abi: openerAbi,
        functionName: "isOpened",
        args: [processor, tokenId],
        blockNumber,
      }),
    ),
  ]);
  if (!ownerRead.ok) {
    return isExplicitContractAnswer(ownerRead.error)
      ? notFoundResource(shell, observedBlock)
      : unknownResource(shell, observedBlock);
  }
  if (!openedRead.ok) return unknownResource(shell, observedBlock);

  return {
    ...shell,
    container: input.container,
    owner: normalizeAddress(ownerRead.value),
    deployed: false,
    opened: openedRead.value,
    observedBlock,
    readStatus: "verified",
  };
}

/** `unavailable`: the read failed, so every fact is `null` and `false` is never implied. */
function unknownResource(
  shell: { readonly resource: ResourceRef; readonly processorIndex: number },
  observedBlock: string | null,
): WalletResource {
  return {
    ...shell,
    container: null,
    owner: null,
    deployed: null,
    opened: null,
    observedBlock,
    readStatus: "unavailable",
  };
}

/** `not_found`: the chain explicitly said this circuit does not exist. */
function notFoundResource(
  shell: { readonly resource: ResourceRef; readonly processorIndex: number },
  observedBlock: string | null,
): WalletResource {
  return {
    ...shell,
    container: null,
    owner: null,
    deployed: null,
    opened: null,
    observedBlock,
    readStatus: "not_found",
  };
}

/** A store that cannot answer says "unavailable", never "complete: false, no assets". */
async function readSnapshot(
  index: ResourceIndexReader,
  catalogue: readonly ProcessorRef[],
): Promise<ResourceIndexSnapshot> {
  const read = await attempt(() => readResourceIndexSnapshot(index, catalogue));
  if (read.ok) return read.value;
  return {
    syncStatus: "unavailable",
    complete: false,
    indexedThroughBlock: null,
    coverage: [],
    originBlock: null,
  };
}

function requireXLayer(config: ChainConfig): 196 {
  if (config.chainId !== CHAIN_ID) {
    throw new ApiError(
      500,
      "INVALID_CONFIG",
      `resource discovery supports chain ${CHAIN_ID} only, got ${config.chainId}`,
    );
  }
  return CHAIN_ID;
}

function normalizeAddress(value: Hex): Hex {
  return value.toLowerCase() as Hex;
}

function toBlockString(block: bigint | null): string | null {
  return block === null ? null : block.toString(10);
}

type ReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

async function attempt<T>(read: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * `true` only when the chain answered: a revert or an empty return. A timeout,
 * 5xx or rate limit is not an answer and must stay `unavailable` (§8.6). This
 * mirrors `packages/chain/src/container.ts`, which does not export it and is
 * frozen for this task.
 */
function isExplicitContractAnswer(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk(
      (cause) =>
        cause instanceof ContractFunctionRevertedError ||
        cause instanceof ContractFunctionZeroDataError,
    ) !== null
  );
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    const slice = items.slice(start, start + limit);
    const mapped = await Promise.all(slice.map((item) => run(item)));
    results.push(...mapped);
  }
  return results;
}

/**
 * Anonymous read routes from SPEC §7.2.
 *
 * An exact-path allowlist, never a loose prefix: `path.startsWith("/v1/resource")`
 * would also match the authenticated `POST /v1/resource-quotes` and let it through
 * without a user. The method is checked too, so any future write route under the
 * same path stays protected by default.
 *
 * Lives here rather than in `app.ts` so the audit hook can share one definition.
 */
const PUBLIC_RESOURCE_GET = new Set(["/v1/resources/processors", "/v1/resources/offers"]);
const PUBLIC_RESOURCE_POST = new Set([
  "/v1/resources/inspect",
  // §7.2: a preview is a non-binding estimate, and §7.1 says public chain queries get their
  // own branch. It stays exact-path, so the authenticated `/v1/resource-quotes` sibling is
  // still gated by the login hook.
  "/v1/resource-quotes/preview",
  // §12: pricing a self-mint is a public read of public contract state, like a preview.
  "/v1/resources/self-mint-quote",
]);

export function isPublicReadMethodAndPath(method: string, path: string): boolean {
  if (method === "GET") {
    return PUBLIC_RESOURCE_GET.has(path) || path.startsWith("/v1/resources/wallets/");
  }
  if (method === "POST") return PUBLIC_RESOURCE_POST.has(path);
  return false;
}
