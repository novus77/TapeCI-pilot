/**
 * Resource index bookkeeping — SPEC §8.1–§8.4, §8.8.
 *
 * The index is the only enumerable source of "which circuits does this address
 * hold". `processorAbi` is plain ERC-721 with no enumerable extension (TapeKit
 * does not prove `ERC721Enumerable`), so §8.2 requires candidates from verified
 * `Transfer` events, never an invented `tokensOfOwner`. This module owns:
 *
 * - the Factory catalogue read (`cpuCount`/`cpuAt`, bounded concurrency, §8.1);
 * - `mint`/`transfer`/`burn` folding in log order with a per-processor
 *   checkpoint that carries the block hash (§8.3);
 * - the definition of "partial" vs "complete": coverage must start at the
 *   trusted scan origin (the processor deployment block) and reach
 *   `indexedThroughBlock`. A failed page never advances the checkpoint, so a
 *   failed read is a shorter covered range, never a "you own nothing" (§8.4).
 *
 * Persistence is behind `ResourceIndexStore`. Dev-2 owns the PostgreSQL tables
 * (`resource_index_checkpoints`, `wallet_resources`, SPEC §6); until those land,
 * `InMemoryResourceIndex` is the working implementation and the store seam is
 * where the PG adapter plugs in without touching the discovery service
 * (`resources.ts`) or the public routes.
 */
import { parseAbiItem, type Hex } from "viem";
import type { ChainConfig } from "@tapeci/config";
import { factoryAbi, type ReadClient } from "@tapeci/chain";
import type { ResourceSyncStatus } from "@tapeci/shared";

/** One row of the Factory's append-only processor catalogue (§8.1). */
export interface ProcessorRef {
  readonly processorIndex: number;
  readonly processor: Hex;
}

/** `cpuAt(i)` for every `i < cpuCount()`, pinned to one block. */
export async function readProcessorCatalogue(
  client: ReadClient,
  config: ChainConfig,
  blockNumber?: bigint,
): Promise<readonly ProcessorRef[]> {
  const readOptions = blockNumber === undefined ? {} : { blockNumber };
  const rawCount = await client.readContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: "cpuCount",
    ...readOptions,
  });
  const count = Number(rawCount);
  // `cpuCount` is a uint256. A value that does not fit a safe integer is either a
  // hostile/broken node or a different contract; enumerating it would silently
  // truncate the catalogue, so fail the read instead.
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`factory ${config.factory} returned an unreadable cpuCount`);
  }
  const processors: ProcessorRef[] = [];
  const CONCURRENCY = 20;
  for (let start = 0; start < count; start += CONCURRENCY) {
    const indexes = Array.from(
      { length: Math.min(CONCURRENCY, count - start) },
      (_value, offset) => start + offset,
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
    indexes.forEach((index, offset) => {
      const address = addresses[offset];
      if (address === undefined) return;
      processors.push({ processorIndex: index, processor: normalizeAddress(address) });
    });
  }
  return processors;
}

/** A circuit the index currently attributes to an owner (§8.3). */
export interface IndexedResource {
  readonly processorIndex: number;
  readonly processor: Hex;
  readonly tokenId: bigint;
  readonly owner: Hex;
  readonly observedBlock: bigint;
}

/**
 * One ownership change in log order. `mint`/`transfer` set the current owner;
 * `burn` removes the row. Anything else is out of scope by definition.
 */
export type OwnershipDelta =
  | {
      readonly kind: "mint" | "transfer";
      readonly tokenId: bigint;
      readonly owner: Hex;
      readonly blockNumber: bigint;
    }
  | { readonly kind: "burn"; readonly tokenId: bigint; readonly blockNumber: bigint };

/**
 * Coverage of one processor: `[fromBlock, throughBlock]` folded into the index.
 * `throughBlockHash` is the canonical-chain handle §8.8 uses on restart.
 */
export interface ProcessorCoverage {
  readonly processor: Hex;
  readonly fromBlock: bigint;
  readonly throughBlock: bigint;
  readonly throughBlockHash: Hex;
}

/** Stable page position; ordered by `(processorIndex, tokenId)` — never by address. */
export interface ResourceCursor {
  readonly processorIndex: number;
  readonly tokenId: bigint;
}

export interface ResourceIndexPage {
  readonly rows: readonly IndexedResource[];
  readonly nextCursor: ResourceCursor | null;
}

/**
 * Read side used by the discovery service and the public routes. Dev-2's PG
 * adapter implements this (per chain: one store instance per `chain_id`).
 */
export interface ResourceIndexReader {
  readOriginBlock(): Promise<bigint | null>;
  readCoverage(): Promise<readonly ProcessorCoverage[]>;
  listByOwner(input: {
    readonly owner: Hex;
    readonly after: ResourceCursor | null;
    readonly limit: number;
  }): Promise<ResourceIndexPage>;
  isSyncing(): Promise<boolean>;
}

/** Write side used only by `syncResourceIndex`. */
export interface ResourceIndexWriter {
  writeOriginBlock(block: bigint): Promise<void>;
  writeCoverage(coverage: ProcessorCoverage): Promise<void>;
  /** Drop coverage *and* rows for a processor whose checkpoint left the canonical chain. */
  invalidateProcessor(processor: Hex): Promise<void>;
  applyDeltas(input: {
    readonly processor: Hex;
    readonly processorIndex: number;
    readonly deltas: readonly OwnershipDelta[];
  }): Promise<void>;
  setSyncing(syncing: boolean): Promise<void>;
}

export interface ResourceIndexStore extends ResourceIndexReader, ResourceIndexWriter {}

/** Coverage view the routes expose; "partial" means the scan is not from the origin. */
export interface ResourceIndexSnapshot {
  readonly syncStatus: ResourceSyncStatus;
  readonly complete: boolean;
  readonly indexedThroughBlock: bigint | null;
  readonly coverage: readonly ProcessorCoverage[];
  readonly originBlock: bigint | null;
}

/**
 * Completeness is a range claim, not a row count (§8.4):
 * `complete` is true only when every catalogue processor is covered from the
 * trusted origin block through `indexedThroughBlock`. A missing origin, a
 * processor with no coverage, or coverage that started mid-chain all yield
 * `false` — the UI must then render "discovery unfinished", never "no assets".
 */
export async function readResourceIndexSnapshot(
  index: ResourceIndexReader,
  catalogue: readonly ProcessorRef[],
): Promise<ResourceIndexSnapshot> {
  const [originBlock, coverage, syncing] = await Promise.all([
    index.readOriginBlock(),
    index.readCoverage(),
    index.isSyncing(),
  ]);
  const byProcessor = new Map(coverage.map((entry) => [entry.processor, entry]));
  const covered = catalogue.flatMap((ref) => {
    const entry = byProcessor.get(ref.processor);
    return entry === undefined ? [] : [entry];
  });
  const coversCatalogue = catalogue.length > 0 && covered.length === catalogue.length;
  const fromOrigin =
    originBlock !== null && covered.every((entry) => entry.fromBlock === originBlock);
  // The lowest committed checkpoint is the block every processor agrees on.
  const indexedThroughBlock = coversCatalogue
    ? covered.reduce<bigint>(
        (lowest, entry) => (entry.throughBlock < lowest ? entry.throughBlock : lowest),
        covered[0]?.throughBlock ?? 0n,
      )
    : null;
  const complete = coversCatalogue && fromOrigin && indexedThroughBlock !== null;
  return {
    syncStatus: syncing ? "syncing" : complete ? "ready" : "partial",
    complete,
    indexedThroughBlock,
    coverage,
    originBlock,
  };
}

/**
 * In-memory index (Dev-2 replaces it with the PostgreSQL tables). One instance
 * per chain; addresses and owners are stored lowercase, token ids as decimal
 * strings so nothing above `Number.MAX_SAFE_INTEGER` is ever coerced.
 */
export class InMemoryResourceIndex implements ResourceIndexStore {
  private originBlock: bigint | null = null;
  private syncing = false;
  /** processor (lowercase) → tokenId (decimal) → current holder. */
  private readonly holdings = new Map<Hex, Map<string, HeldToken>>();
  private readonly coverage = new Map<Hex, ProcessorCoverage>();

  async readOriginBlock(): Promise<bigint | null> {
    return this.originBlock;
  }

  async writeOriginBlock(block: bigint): Promise<void> {
    this.originBlock = block;
  }

  async isSyncing(): Promise<boolean> {
    return this.syncing;
  }

  async setSyncing(syncing: boolean): Promise<void> {
    this.syncing = syncing;
  }

  async readCoverage(): Promise<readonly ProcessorCoverage[]> {
    return [...this.coverage.values()];
  }

  async writeCoverage(coverage: ProcessorCoverage): Promise<void> {
    this.coverage.set(normalizeAddress(coverage.processor), coverage);
  }

  async invalidateProcessor(processor: Hex): Promise<void> {
    const key = normalizeAddress(processor);
    this.coverage.delete(key);
    this.holdings.delete(key);
  }

  async applyDeltas(input: {
    readonly processor: Hex;
    readonly processorIndex: number;
    readonly deltas: readonly OwnershipDelta[];
  }): Promise<void> {
    const key = normalizeAddress(input.processor);
    const tokens = this.holdings.get(key) ?? new Map<string, HeldToken>();
    this.holdings.set(key, tokens);
    for (const delta of input.deltas) {
      const tokenId = delta.tokenId.toString(10);
      if (delta.kind === "burn") {
        tokens.delete(tokenId);
        continue;
      }
      tokens.set(tokenId, {
        processorIndex: input.processorIndex,
        owner: normalizeAddress(delta.owner),
        observedBlock: delta.blockNumber,
      });
    }
  }

  async listByOwner(input: {
    readonly owner: Hex;
    readonly after: ResourceCursor | null;
    readonly limit: number;
  }): Promise<ResourceIndexPage> {
    const owner = normalizeAddress(input.owner);
    const rows: IndexedResource[] = [];
    for (const [processor, tokens] of this.holdings) {
      for (const [tokenId, held] of tokens) {
        if (held.owner !== owner) continue;
        rows.push({
          processorIndex: held.processorIndex,
          processor,
          tokenId: BigInt(tokenId),
          owner: held.owner,
          observedBlock: held.observedBlock,
        });
      }
    }
    rows.sort(compareResources);
    const after = input.after;
    const remaining =
      after === null ? rows : rows.filter((row) => comparePosition(row, after) > 0);
    const page = remaining.slice(0, input.limit);
    const last = page[page.length - 1];
    const nextCursor =
      remaining.length > page.length && last !== undefined
        ? { processorIndex: last.processorIndex, tokenId: last.tokenId }
        : null;
    return { rows: page, nextCursor };
  }
}

/** Cursors are opaque to clients; the pair is the stable sort key, not an address. */
export function encodeResourceCursor(cursor: ResourceCursor): string {
  return Buffer.from(
    `${cursor.processorIndex}:${cursor.tokenId.toString(10)}`,
    "utf8",
  ).toString("base64url");
}

/** Returns `null` for anything that is not a cursor this service issued. */
export function decodeResourceCursor(value: string): ResourceCursor | null {
  const text = Buffer.from(value, "base64url").toString("utf8");
  const match = /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(text);
  if (match === null) return null;
  const indexText = match[1];
  const tokenIdText = match[2];
  if (indexText === undefined || tokenIdText === undefined) return null;
  const processorIndex = Number(indexText);
  if (!Number.isSafeInteger(processorIndex)) return null;
  return { processorIndex, tokenId: BigInt(tokenIdText) };
}

export interface ResourceIndexSyncOptions {
  readonly client: ReadClient;
  readonly config: ChainConfig;
  readonly index: ResourceIndexStore;
  /**
   * Trusted scan origin: the processor deployment block recorded by ops. Without
   * it no range can be proven covered, so the sync requires it instead of
   * inventing a start and claiming completeness (§8.4).
   */
  readonly originBlock: bigint;
  /** Defaults to the current head; tests pin it. */
  readonly throughBlock?: bigint;
  /** Blocks per `eth_getLogs` page — X Layer RPCs rate-limit wide ranges (§8.3). */
  readonly chunkSize?: number;
}

export type ResourceIndexSyncStage = "head" | "catalogue" | "logs" | "checkpoint";

export interface ResourceIndexSyncFailure {
  /** `null` only for a failure that precedes processor enumeration. */
  readonly processor: Hex | null;
  readonly stage: ResourceIndexSyncStage;
  readonly message: string;
}

export interface ResourceIndexSyncResult {
  readonly syncStatus: ResourceSyncStatus;
  readonly complete: boolean;
  readonly indexedThroughBlock: bigint | null;
  readonly observedBlock: bigint | null;
  readonly failures: readonly ResourceIndexSyncFailure[];
}

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_CHUNK_SIZE = 5_000;

/**
 * Fold `Transfer` logs into the index, resuming from the last checkpoint.
 *
 * A failed `eth_getLogs` page or an unreadable block hash stops that processor
 * without advancing its checkpoint, so the next run re-reads the same range
 * instead of marking a partial scan complete (§8.3–§8.4). A checkpoint whose
 * block hash no longer matches the canonical chain invalidates the processor and
 * restarts it from the origin (§8.8).
 */
export async function syncResourceIndex(
  options: ResourceIndexSyncOptions,
): Promise<ResourceIndexSyncResult> {
  await options.index.setSyncing(true);
  let run: SyncRun;
  try {
    run = await runSync(options);
  } finally {
    await options.index.setSyncing(false);
  }
  const { catalogue, head, failures } = run;
  if (catalogue === null || head === null) {
    return {
      syncStatus: "unavailable",
      complete: false,
      indexedThroughBlock: null,
      observedBlock: head,
      failures,
    };
  }
  const snapshot = await readResourceIndexSnapshot(options.index, catalogue);
  // The result answers "did this run reach its target?", while the page's
  // `syncStatus` answers "is the index's covered range complete?" (SPEC §8.4).
  // `complete` is the DTO's range claim and stays independent of this run.
  const reachedTarget = snapshot.indexedThroughBlock !== null && snapshot.indexedThroughBlock >= head;
  return {
    syncStatus:
      snapshot.complete && reachedTarget && failures.length === 0 ? "ready" : "partial",
    complete: snapshot.complete,
    indexedThroughBlock: snapshot.indexedThroughBlock,
    observedBlock: head,
    failures,
  };
}

interface SyncRun {
  readonly catalogue: readonly ProcessorRef[] | null;
  /** `null` when the head itself could not be read. */
  readonly head: bigint | null;
  readonly failures: readonly ResourceIndexSyncFailure[];
}

async function runSync(options: ResourceIndexSyncOptions): Promise<SyncRun> {
  const { client, config, index } = options;
  const pinned = options.throughBlock;
  const headRead: ReadResult<bigint> =
    pinned === undefined ? await attempt(() => client.getBlockNumber()) : { ok: true, value: pinned };
  if (!headRead.ok) {
    return {
      catalogue: null,
      head: null,
      failures: [{ processor: null, stage: "head", message: describeError(headRead.error) }],
    };
  }
  const head = headRead.value;

  const catalogueRead = await attempt(() => readProcessorCatalogue(client, config, head));
  if (!catalogueRead.ok) {
    return {
      catalogue: null,
      head,
      failures: [
        { processor: null, stage: "catalogue", message: describeError(catalogueRead.error) },
      ],
    };
  }
  const catalogue = catalogueRead.value;

  const storedOrigin = await index.readOriginBlock();
  if (storedOrigin !== null && storedOrigin !== options.originBlock) {
    // A different trusted start means every existing range claims the wrong
    // beginning; drop them and let this run rebuild from the new origin.
    for (const entry of await index.readCoverage()) {
      await index.invalidateProcessor(entry.processor);
    }
  }
  await index.writeOriginBlock(options.originBlock);

  const failures: ResourceIndexSyncFailure[] = [];
  const chunkSize = BigInt(options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  if (chunkSize < 1n) throw new Error("chunkSize must be at least one block");

  const coverageByProcessor = new Map(
    (await index.readCoverage()).map((entry) => [entry.processor, entry]),
  );
  for (const ref of catalogue) {
    const checkpoint = coverageByProcessor.get(ref.processor);
    let fromBlock = options.originBlock;
    let coveredFrom = options.originBlock;
    if (checkpoint !== undefined) {
      const canonical = await attempt(() =>
        client.getBlock({ blockNumber: checkpoint.throughBlock }),
      );
      const hash = canonical.ok ? canonical.value.hash : null;
      if (hash === null) {
        // An unreadable checkpoint block is not evidence of a reorg: keep the
        // coverage and retry on the next run instead of discarding good rows.
        failures.push({
          processor: ref.processor,
          stage: "checkpoint",
          message: `could not re-read checkpoint block ${checkpoint.throughBlock}`,
        });
        continue;
      }
      if (normalizeAddress(hash) === normalizeAddress(checkpoint.throughBlockHash)) {
        fromBlock = checkpoint.throughBlock + 1n;
        coveredFrom = checkpoint.fromBlock;
      } else {
        // §8.8: the covered range is no longer the canonical chain. Drop the
        // processor's rows and rebuild it from the trusted origin in this run.
        await index.invalidateProcessor(ref.processor);
        failures.push({
          processor: ref.processor,
          stage: "checkpoint",
          message: `checkpoint block ${checkpoint.throughBlock} left the canonical chain`,
        });
      }
    }
    if (fromBlock > head) continue;

    for (let start = fromBlock; start <= head; start += chunkSize) {
      const candidateEnd = start + chunkSize - 1n;
      const end = candidateEnd > head ? head : candidateEnd;
      const logsRead = await attempt(() =>
        readTransferDeltas(client, ref.processor, start, end),
      );
      if (!logsRead.ok) {
        failures.push({
          processor: ref.processor,
          stage: "logs",
          message: describeError(logsRead.error),
        });
        break;
      }
      const blockRead = await attempt(() => client.getBlock({ blockNumber: end }));
      const endHash = blockRead.ok ? blockRead.value.hash : null;
      if (endHash === null) {
        // Without the canonical hash the range cannot be re-checked on restart,
        // so the checkpoint must not advance over it (§8.3, §8.8).
        failures.push({
          processor: ref.processor,
          stage: "checkpoint",
          message: `could not read block ${end} for the checkpoint hash`,
        });
        break;
      }
      await index.applyDeltas({
        processor: ref.processor,
        processorIndex: ref.processorIndex,
        deltas: logsRead.value,
      });
      await index.writeCoverage({
        processor: ref.processor,
        fromBlock: coveredFrom,
        throughBlock: end,
        throughBlockHash: endHash,
      });
    }
  }

  return { catalogue, head, failures };
}

/** Decode one `eth_getLogs` page into ordered deltas (mint/transfer/burn). */
async function readTransferDeltas(
  client: ReadClient,
  processor: Hex,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<readonly OwnershipDelta[]> {
  const logs = await client.getLogs({
    address: processor,
    event: TRANSFER_EVENT,
    fromBlock,
    toBlock,
  });
  return logs.flatMap((log): OwnershipDelta[] => {
    const args = log.args;
    if (log.blockNumber === null || args.tokenId === undefined || args.to === undefined) return [];
    const tokenId = args.tokenId;
    const blockNumber = log.blockNumber;
    if (args.to === ZERO_ADDRESS) return [{ kind: "burn", tokenId, blockNumber }];
    return [
      {
        // The index only needs the current holder; "mint" vs "transfer" is
        // kept so the PG adapter can preserve the log kind for auditing.
        kind: args.from === ZERO_ADDRESS ? "mint" : "transfer",
        tokenId,
        owner: normalizeAddress(args.to),
        blockNumber,
      },
    ];
  });
}

interface HeldToken {
  readonly processorIndex: number;
  readonly owner: Hex;
  readonly observedBlock: bigint;
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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeAddress(value: Hex): Hex {
  return value.toLowerCase() as Hex;
}

/** `(processorIndex, tokenId)` — the asset key, never the container address. */
function comparePosition(
  left: { readonly processorIndex: number; readonly tokenId: bigint },
  right: { readonly processorIndex: number; readonly tokenId: bigint },
): number {
  if (left.processorIndex !== right.processorIndex) {
    return left.processorIndex < right.processorIndex ? -1 : 1;
  }
  if (left.tokenId === right.tokenId) return 0;
  return left.tokenId < right.tokenId ? -1 : 1;
}

function compareResources(left: IndexedResource, right: IndexedResource): number {
  return comparePosition(left, right);
}
