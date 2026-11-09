/**
 * Minting a circuit through the protocol's own contracts
 * (SPEC `2026-10-28-self-mint-spec.md` §2, §4).
 *
 * The signatures below were extracted from the protocol's own `SIGS` table rather than
 * guessed, and the address book is the one already in `@tapeci/config` — the same factory and
 * opener this repository has been reading from since P1.
 *
 * Nothing here signs anything. It builds the exact calldata and reads the exact prices, so a
 * caller can show them and the user's wallet can sign. That split is what keeps the platform
 * away from private keys.
 */
import { encodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";

/** Functions the mint path needs, taken from the protocol kernel's own signature table. */
export const transistorsAbi = parseAbi([
  "function NAND() view returns (uint256)",
  "function mintPrice() view returns (uint256)",
  "function protocolFee() view returns (uint256)",
  "function supplyCap() view returns (uint256)",
  "function minted() view returns (uint256)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function mint(uint256 id, uint256 amount) payable",
]);

export const tapeoutAbi = parseAbi([
  "function TAPEOUT_FEE() view returns (uint256)",
  "function transistors() view returns (address)",
  "function nextId() view returns (uint256)",
  "function tapeout(bytes netlist, uint32 nIn, uint32 nOut) payable returns (uint256)",
  "event TapedOut(uint256 indexed tokenId, address indexed owner, uint32 nIn, uint32 nOut)",
]);

/**
 * The `TapedOut` topic.
 *
 * Computed from the **full** signature. The protocol's own implementation carries a warning
 * about this: an event topic is `keccak256` of the whole signature, so truncating it to a
 * 4-byte function selector can never match.
 */
export const TAPED_OUT_TOPIC: Hex = keccak256(
  toHex("TapedOut(uint256,address,uint32,uint32)"),
);

export interface MintIntent {
  /** Calldata for `tapeout(bytes,uint32,uint32)` on the processor contract. */
  readonly tapeout: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  /** Calldata for `mint(uint256,uint256)` on the transistors contract. */
  readonly mint: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  /** Everything the confirmation screen must show verbatim (§4). */
  readonly terms: {
    readonly tapeoutFeeWei: bigint;
    readonly mintPriceWei: bigint;
    readonly protocolFeeWei: bigint;
    /** `nextId() + 1`: a prediction the receipt may contradict (§4). */
    readonly predictedTokenId: string;
    readonly nandId: bigint;
    /** How many NAND gates this circuit needs; 0 means the wallet already has enough. */
    readonly transistorsNeeded: bigint;
    /** True when the wallet holds enough and the mint transaction can be skipped. */
    readonly mintSkipped: boolean;
  };
}

/**
 * Build the two transactions for one mint-and-tapeout.
 *
 * `msg.value` for `tapeout` must equal `TAPEOUT_FEE()` **exactly** — paying one wei more or
 * less reverts. That is why the value is taken from the chain read rather than computed, and
 * why the fork suite asserts the revert (A-9).
 */
export function buildMintIntent(input: {
  readonly processor: Address;
  readonly transistors: Address;
  readonly netlistHex: Hex;
  readonly nIn: number;
  readonly nOut: number;
  readonly tapeoutFeeWei: bigint;
  readonly mintPriceWei: bigint;
  readonly protocolFeeWei: bigint;
  readonly nandId: bigint;
  readonly transistorBalance: bigint;
  readonly nextId: bigint;
}): MintIntent {
  if (input.tapeoutFeeWei < 0n || input.mintPriceWei < 0n || input.protocolFeeWei < 0n) {
    throw new Error("fees must be non-negative");
  }
  // The threshold is specific: `tapeout` takes one NAND, and paying for more never helps.
  const transistorsNeeded = 1n;
  const mintSkipped = input.transistorBalance >= transistorsNeeded;
  const mintCost = input.mintPriceWei * transistorsNeeded + input.protocolFeeWei;

  return {
    tapeout: {
      to: input.processor,
      data: encodeFunctionData({
        abi: tapeoutAbi,
        functionName: "tapeout",
        args: [input.netlistHex, input.nIn, input.nOut],
      }),
      // Not a cap, not an estimate: the contract requires equality.
      value: input.tapeoutFeeWei,
    },
    mint: {
      to: input.transistors,
      data: encodeFunctionData({
        abi: transistorsAbi,
        functionName: "mint",
        args: [input.nandId, transistorsNeeded],
      }),
      value: mintSkipped ? 0n : mintCost,
    },
    terms: {
      tapeoutFeeWei: input.tapeoutFeeWei,
      mintPriceWei: input.mintPriceWei,
      protocolFeeWei: input.protocolFeeWei,
      predictedTokenId: (input.nextId + 1n).toString(10),
      nandId: input.nandId,
      transistorsNeeded: mintSkipped ? 0n : transistorsNeeded,
      mintSkipped,
    },
  };
}

/**
 * Extract the real token id from a tapeout receipt.
 *
 * The predicted id is `nextId() + 1`, and a concurrent tapeout that lands first makes the
 * actual id larger — so the receipt decides, never the prediction (§4). A receipt without the
 * event is an error rather than a guess, because guessing here would attribute someone else's
 * circuit to this user.
 */
export function tokenIdFromTapeoutLogs(
  logs: readonly { readonly topics: readonly Hex[]; readonly data: Hex }[],
): string {
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TAPED_OUT_TOPIC.toLowerCase()) continue;
    const tokenIdTopic = log.topics[1];
    if (tokenIdTopic === undefined) continue;
    // `tokenId` is the first indexed parameter, so it is topic[1] as a full 32-byte word.
    return BigInt(tokenIdTopic).toString(10);
  }
  throw new Error("the tapeout receipt carries no TapedOut event; the token id is unknown");
}
