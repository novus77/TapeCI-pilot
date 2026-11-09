/**
 * Which processors can actually mint right now, and what each costs
 * (SPEC `2026-10-28-self-mint-spec.md` §12).
 *
 * The first version of this feature measured processor 0, found its transistors sold out, and
 * concluded the whole path was impossible. That was wrong: X Layer has **398** processors,
 * each with its own independent transistor supply, and 357 of them still have stock. The
 * lesson is encoded here — this module never assumes a processor index, it checks them.
 *
 * Prices differ by more than an order of magnitude between processors, so "which processor"
 * is a real cost decision the user must be shown, not a default to pick for them.
 */
import type { Address } from "viem";

/** The four prices a mint decision depends on, all read from chain. */
export interface MintableProcessorTerms {
  readonly cpuIndex: number;
  readonly processor: Address;
  readonly transistors: Address;
  readonly minted: bigint;
  readonly supplyCap: bigint;
  /** `supplyCap - minted`; zero means the mint would revert. */
  readonly transistorBalanceAvailable: bigint;
  readonly mintPriceWei: bigint;
  readonly protocolFeeWei: bigint;
  /** `TAPEOUT_FEE()` on the processor: must be paid exactly. */
  readonly tapeoutFeeWei: bigint;
  readonly nextId: bigint;
  /** One transistor buys one circuit, so this is the real all-in cost of minting. */
  readonly mintCostWei: bigint;
  /** `mintCost + tapeoutFee`: everything except the opener fee, which P3 already quotes. */
  readonly totalBeforeOpenWei: bigint;
}

export interface MintableProcessorList {
  readonly chainId: 196;
  /** Only processors that can actually mint. Sold-out ones are omitted, not listed as zero. */
  readonly processors: readonly MintableProcessorTerms[];
  /** How many were examined, so a client can tell "all sold out" from "none examined". */
  readonly examined: number;
  readonly soldOut: number;
  readonly observedBlock: string | null;
  readonly syncStatus: "verified" | "unavailable";
}

/** The subset of a viem read client this module needs, so it can be faked in tests. */
export interface MintableReadClient {
  readonly getBlockNumber: () => Promise<bigint>;
  readonly readContract: (args: {
    readonly address: Address;
    readonly abi: readonly unknown[];
    readonly functionName: string;
    readonly args?: readonly unknown[];
    readonly blockNumber?: bigint;
  }) => Promise<unknown>;
}

const factoryAbi = [
  { type: "function", name: "cpuCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cpuAt", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

const processorAbi = [
  { type: "function", name: "transistors", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "TAPEOUT_FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nextId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const transistorsAbi = [
  { type: "function", name: "minted", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "supplyCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mintPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "protocolFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Read one processor's mint terms.
 *
 * Returns `null` when the processor cannot mint **or** when it could not be read. Keeping
 * those two cases together is deliberate: a processor whose supply cannot be verified must
 * not be offered, because offering it would mean quoting a price for a transaction that may
 * revert (§9.2 — an unreadable fact never becomes a happy path).
 */
export async function readMintableTerms(
  client: MintableReadClient,
  factory: Address,
  cpuIndex: number,
  pin: bigint,
): Promise<MintableProcessorTerms | null> {
  try {
    const processor = (await client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "cpuAt",
      args: [BigInt(cpuIndex)],
      blockNumber: pin,
    })) as Address;
    const transistors = (await client.readContract({
      address: processor,
      abi: processorAbi,
      functionName: "transistors",
      blockNumber: pin,
    })) as Address;

    const [minted, supplyCap, mintPriceWei, protocolFeeWei, tapeoutFeeWei, nextId] = await Promise.all([
      client.readContract({ address: transistors, abi: transistorsAbi, functionName: "minted", blockNumber: pin }) as Promise<bigint>,
      client.readContract({ address: transistors, abi: transistorsAbi, functionName: "supplyCap", blockNumber: pin }) as Promise<bigint>,
      client.readContract({ address: transistors, abi: transistorsAbi, functionName: "mintPrice", blockNumber: pin }) as Promise<bigint>,
      client.readContract({ address: transistors, abi: transistorsAbi, functionName: "protocolFee", blockNumber: pin }) as Promise<bigint>,
      client.readContract({ address: processor, abi: processorAbi, functionName: "TAPEOUT_FEE", blockNumber: pin }) as Promise<bigint>,
      client.readContract({ address: processor, abi: processorAbi, functionName: "nextId", blockNumber: pin }) as Promise<bigint>,
    ]);

    const transistorBalanceAvailable = supplyCap > minted ? supplyCap - minted : 0n;
    if (transistorBalanceAvailable === 0n) return null;

    const mintCostWei = mintPriceWei + protocolFeeWei;
    return {
      cpuIndex,
      processor,
      transistors,
      minted,
      supplyCap,
      transistorBalanceAvailable,
      mintPriceWei,
      protocolFeeWei,
      tapeoutFeeWei,
      nextId,
      mintCostWei,
      totalBeforeOpenWei: mintCostWei + tapeoutFeeWei,
    };
  } catch {
    return null;
  }
}

/**
 * List every processor that can mint, cheapest first.
 *
 * Sorted by `totalBeforeOpenWei` because that is the number the user actually pays; the
 * default suggestion should be the cheapest available option, not processor 0.
 *
 * `limit` bounds how many indices are examined, not how many are returned: the catalogue is
 * large (398), and a caller that only needs a workable choice should not pay for a full scan.
 */
export async function listMintableProcessors(input: {
  readonly client: MintableReadClient;
  readonly factory: Address;
  readonly maxProcessors?: number;
  /** How many candidates to return once sorted. */
  readonly limit?: number;
}): Promise<MintableProcessorList> {
  try {
    const pin = await input.client.getBlockNumber();
    const count = Number(
      (await input.client.readContract({
        address: input.factory,
        abi: factoryAbi,
        functionName: "cpuCount",
        blockNumber: pin,
      })) as bigint,
    );
    const examinedCount = Math.min(count, input.maxProcessors ?? count);
    const terms = await Promise.all(
      Array.from({ length: examinedCount }, (_, index) =>
        readMintableTerms(input.client, input.factory, index, pin),
      ),
    );
    const mintable = terms.filter((entry): entry is MintableProcessorTerms => entry !== null);
    const sorted = [...mintable].sort((a, b) =>
      a.totalBeforeOpenWei === b.totalBeforeOpenWei
        ? a.cpuIndex - b.cpuIndex
        : a.totalBeforeOpenWei < b.totalBeforeOpenWei
          ? -1
          : 1,
    );
    return {
      chainId: 196,
      processors: input.limit === undefined ? sorted : sorted.slice(0, input.limit),
      examined: examinedCount,
      soldOut: examinedCount - mintable.length,
      observedBlock: pin.toString(),
      syncStatus: "verified",
    };
  } catch {
    // An unreadable catalogue is `unavailable`, never an empty list that reads as "no stock".
    return {
      chainId: 196,
      processors: [],
      examined: 0,
      soldOut: 0,
      observedBlock: null,
      syncStatus: "unavailable",
    };
  }
}
