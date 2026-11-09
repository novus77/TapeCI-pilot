/**
 * The quote for acquiring a circuit by minting it, then opening it
 * (SPEC `2026-10-28-self-mint-spec.md` §12, §4).
 *
 * This is the priced answer to "I have no circuit — what will it cost?". It exists because
 * the platform has no pre-priced inventory: the user buys a transistor from the protocol and
 * tapes out, so the prices have to be read from the chosen processor's own contracts at quote
 * time, not looked up in a catalogue.
 *
 * Three facts shape the design:
 *
 * 1. **The processor must be chosen, not assumed.** 398 exist with independent supplies and
 *    prices spanning more than an order of magnitude; index 0 happens to be sold out.
 * 2. **Acquisition and opening are two separate payments.** §9.3 forbids folding them into
 *    one authorisation: the token id is unknown until the tapeout lands, so the open price is
 *    quoted against a *known* resource in a second step.
 * 3. **Nothing here signs.** The quote carries calldata and exact values; the user's wallet
 *    signs, which is what keeps the platform away from private keys.
 */
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";

import { encodeNetlist, inverterCircuit } from "@tapeci/tapekit";

import { readMintableTerms, type MintableReadClient, type MintableProcessorTerms } from "./mintable.js";

export const SELF_MINT_SOURCE_ID = "builtin:self-mint";

/** One priced step: what to send, to whom, for exactly how much. */
export interface SelfMintStep {
  readonly kind: "mint" | "tapeout";
  /** `null` only on `tapeout`, whose target is the processor resolved below. */
  readonly to: Address;
  readonly data: Hex;
  /** Exact `msg.value`. For `tapeout` the contract requires equality. */
  readonly valueWei: string;
  readonly functionName: string;
}

export interface SelfMintQuote {
  readonly sourceId: typeof SELF_MINT_SOURCE_ID;
  readonly chainId: 196;
  readonly processor: {
    readonly cpuIndex: number;
    readonly address: Address;
    readonly transistors: Address;
    /** Remaining transistors, so the UI can show that the choice has stock. */
    readonly available: string;
  };
  readonly steps: readonly SelfMintStep[];
  readonly prices: {
    readonly mintCostWei: string;
    readonly tapeoutFeeWei: string;
    /** The opener fee is quoted here as a *reference*; see `openQuotedSeparately`. */
    readonly openerFeeWei: string;
    readonly totalWei: string;
  };
  readonly observedBlock: string;
  readonly expiresAt: string;
  /**
   * Always `true`: the container is opened in a second, separately-quoted step, because the
   * token id does not exist until the tapeout lands (§9.3).
   */
  readonly openQuotedSeparately: true;
  /** Predicted id; the receipt decides, because a concurrent tapeout can push it higher. */
  readonly predictedTokenId: string;
  readonly termsVersion: string;
}

const SELF_MINT_TERMS_VERSION = "self-mint-v1";

function selector(signature: string): Hex {
  return keccak256(toHex(signature)).slice(0, 10) as Hex;
}

const word = (value: bigint): string => value.toString(16).padStart(64, "0");

/** `mint(uint256 id, uint256 amount)`. */
function mintCalldata(nandId: bigint): Hex {
  return `${selector("mint(uint256,uint256)")}${word(nandId)}${word(1n)}` as Hex;
}

/** `tapeout(bytes netlist, uint32 nIn, uint32 nOut)` with the standard head/tail layout. */
function tapeoutCalldata(netlistHex: Hex, nIn: number, nOut: number): Hex {
  const raw = netlistHex.slice(2);
  const padded = raw.padEnd(Math.ceil(raw.length / 64) * 64, "0");
  return `${selector("tapeout(bytes,uint32,uint32)")}${word(0x60n)}${word(BigInt(nIn))}${word(
    BigInt(nOut),
  )}${word(BigInt(raw.length / 2))}${padded}` as Hex;
}

export interface BuildSelfMintQuoteInput {
  readonly client: MintableReadClient;
  readonly factory: Address;
  readonly opener: Address;
  /** Which processor the user picked from `GET /v1/resources/mintable-processors`. */
  readonly cpuIndex: number;
  /** §7.2: the quote is only payable for a while. */
  readonly ttlSeconds?: number;
  readonly now?: () => Date;
}

const DEFAULT_TTL_SECONDS = 300;

/**
 * Build a quote for minting one circuit on the chosen processor.
 *
 * Returns `null` when that processor cannot mint — sold out, or its supply cannot be read.
 * Returning `null` rather than throwing lets the route answer with the list of processors
 * that *can*, which is more useful than an error about one the user did not choose.
 */
export async function buildSelfMintQuote(
  input: BuildSelfMintQuoteInput,
): Promise<SelfMintQuote | null> {
  const pin = await input.client.getBlockNumber();
  const terms: MintableProcessorTerms | null = await readMintableTerms(
    input.client,
    input.factory,
    input.cpuIndex,
    pin,
  );
  if (terms === null) return null;

  const circuit = inverterCircuit();
  const encoded = encodeNetlist(circuit.ops, circuit.nIn, circuit.nOut);

  // The transistors id is `NAND()`; the first circuit needs exactly one.
  const nandId = await readNandId(input.client, terms.transistors, pin);
  const openerFeeWei = await readOpenerFee(input.client, input.opener, pin);

  const now = input.now?.() ?? new Date();
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  return {
    sourceId: SELF_MINT_SOURCE_ID,
    chainId: 196,
    processor: {
      cpuIndex: terms.cpuIndex,
      address: terms.processor,
      transistors: terms.transistors,
      available: terms.transistorBalanceAvailable.toString(10),
    },
    steps: [
      {
        kind: "mint",
        to: terms.transistors,
        data: mintCalldata(nandId),
        valueWei: terms.mintCostWei.toString(10),
        functionName: "mint",
      },
      {
        kind: "tapeout",
        to: terms.processor,
        data: tapeoutCalldata(encoded.hex, circuit.nIn, circuit.nOut),
        // The contract refuses anything but equality, so this is not a cap.
        valueWei: terms.tapeoutFeeWei.toString(10),
        functionName: "tapeout",
      },
    ],
    prices: {
      mintCostWei: terms.mintCostWei.toString(10),
      tapeoutFeeWei: terms.tapeoutFeeWei.toString(10),
      openerFeeWei: openerFeeWei.toString(10),
      // The open fee is included in the headline total because the user will pay it, but the
      // step list contains only the two this quote authorises.
      totalWei: (terms.mintCostWei + terms.tapeoutFeeWei + openerFeeWei).toString(10),
    },
    observedBlock: pin.toString(10),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    openQuotedSeparately: true,
    predictedTokenId: (terms.nextId + 1n).toString(10),
    termsVersion: SELF_MINT_TERMS_VERSION,
  };
}

const nandAbi = [
  { type: "function", name: "NAND", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const openerFeeAbi = [
  { type: "function", name: "FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function readNandId(
  client: MintableReadClient,
  transistors: Address,
  pin: bigint,
): Promise<bigint> {
  return (await client.readContract({
    address: transistors,
    abi: nandAbi,
    functionName: "NAND",
    blockNumber: pin,
  })) as bigint;
}

async function readOpenerFee(
  client: MintableReadClient,
  opener: Address,
  pin: bigint,
): Promise<bigint> {
  return (await client.readContract({
    address: opener,
    abi: openerFeeAbi,
    functionName: "FEE",
    blockNumber: pin,
  })) as bigint;
}

/** Re-exported so a route can validate an address without importing viem conventions itself. */
export function normalizeProcessorAddress(value: string): Address {
  return getAddress(value);
}
