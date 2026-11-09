/**
 * Choosing a processor that can actually mint
 * (SPEC `2026-10-28-self-mint-spec.md` §12).
 *
 * The first version of self-mint measured processor 0, found it sold out, and concluded the
 * whole path was impossible. It was wrong: X Layer has 398 processors with independent
 * supplies and 357 still have stock. These cases pin the two behaviours that mistake implied:
 * **sold-out processors are filtered**, and **the cheapest available one is suggested**.
 */
import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { listMintableProcessors, readMintableTerms, type MintableReadClient } from "../../apps/api/src/provisioning/mintable.js";

const FACTORY = "0x1f09daefa827f02cbb40967cc91b259763760761" as Address;

interface ProcessorFixture {
  readonly minted: bigint;
  readonly supplyCap: bigint;
  readonly mintPriceWei: bigint;
  readonly protocolFeeWei: bigint;
  readonly tapeoutFeeWei?: bigint;
  readonly nextId?: bigint;
  /** Set to make every read throw, so `null` (cannot verify) can be distinguished. */
  readonly unreadable?: boolean;
}

/** A fake chain whose processor catalogue is exactly the given fixtures. */
const OPENER = "0x536add8f30f03b69f6fbf29d425a816a0dc50106" as Address;

function fakeClient(processors: readonly ProcessorFixture[]): MintableReadClient {
  const processorAddress = (index: number): Address =>
    `0x${String(index + 1).padStart(2, "0").repeat(20).slice(0, 40)}` as Address;
  const transistorsAddress = (index: number): Address =>
    `0x${String(index + 1).padStart(2, "0")}ff`.repeat(20).slice(0, 42) as Address;

  return {
    getBlockNumber: async () => 1_000n,
    readContract: async (args) => {
      // The opener's fee is a quote input too, and it is not a processor read.
      if (args.address === OPENER && args.functionName === "FEE") {
        return 80_000_000_000_000_000n;
      }
      if (args.functionName === "NAND") return 0n;

      if (args.address === FACTORY && args.functionName === "cpuCount") {
        return BigInt(processors.length);
      }
      if (args.address === FACTORY && args.functionName === "cpuAt") {
        const target = Number((args.args?.[0] as bigint) ?? 0n);
        return processorAddress(target);
      }

      // Which processor does this address belong to?
      const owner = processors.findIndex(
        (_entry, position) =>
          processorAddress(position) === args.address || transistorsAddress(position) === args.address,
      );
      if (owner === -1) throw new Error("unknown address");
      const entry = processors[owner];
      if (entry === undefined || entry.unreadable === true) throw new Error("unreadable");

      const isTransistors = transistorsAddress(owner) === args.address;
      if (args.functionName === "transistors") return transistorsAddress(owner);
      if (args.functionName === "minted") return entry.minted;
      if (args.functionName === "supplyCap") return entry.supplyCap;
      if (args.functionName === "mintPrice") return entry.mintPriceWei;
      if (args.functionName === "protocolFee") return entry.protocolFeeWei;
      if (args.functionName === "TAPEOUT_FEE") return entry.tapeoutFeeWei ?? 1_300_000_000_000_000n;
      if (args.functionName === "nextId") return entry.nextId ?? 1n;
      void isTransistors;
      throw new Error(`unexpected call ${args.functionName}`);
    },
  };
}

describe("mintable processors (§12)", () => {
  it("omits a sold-out processor instead of offering a mint that would revert", async () => {
    // Exactly the situation processor 0 was in: minted == supplyCap.
    const client = fakeClient([
      { minted: 100_000n, supplyCap: 100_000n, mintPriceWei: 1n, protocolFeeWei: 1n },
      { minted: 181n, supplyCap: 100_000n, mintPriceWei: 10n, protocolFeeWei: 2n },
    ]);
    const listed = await listMintableProcessors({ client, factory: FACTORY });

    expect(listed.syncStatus).toBe("verified");
    expect(listed.examined).toBe(2);
    expect(listed.soldOut).toBe(1);
    expect(listed.processors).toHaveLength(1);
    expect(listed.processors[0]?.cpuIndex).toBe(1);
  });

  it("suggests the CHEAPEST available processor, not processor 0", async () => {
    // Prices differ by an order of magnitude in reality, so the default must be a price
    // decision the user can see, not an arbitrary index.
    const client = fakeClient([
      { minted: 0n, supplyCap: 100n, mintPriceWei: 10_000_000_000_000_000n, protocolFeeWei: 660_000_000_000_000n },
      { minted: 0n, supplyCap: 100n, mintPriceWei: 660_000_000_000_000n, protocolFeeWei: 660_000_000_000_000n },
      { minted: 0n, supplyCap: 100n, mintPriceWei: 1_000_000_000_000_000n, protocolFeeWei: 660_000_000_000_000n },
    ]);
    const listed = await listMintableProcessors({ client, factory: FACTORY });

    expect(listed.processors).toHaveLength(3);
    // Cheapest total first: cpu 1 (0.00132) < cpu 2 (0.00166) < cpu 0 (0.01066).
    expect(listed.processors.map((entry) => entry.cpuIndex)).toEqual([1, 2, 0]);
    expect(listed.processors[0]?.totalBeforeOpenWei).toBeLessThan(
      listed.processors[1]?.totalBeforeOpenWei ?? 0n,
    );
  });

  it("reports the all-in mint cost as mintPrice + protocolFee, and adds the tapeout fee", async () => {
    const client = fakeClient([
      {
        minted: 5n,
        supplyCap: 100n,
        mintPriceWei: 660_000_000_000_000n,
        protocolFeeWei: 660_000_000_000_000n,
        tapeoutFeeWei: 1_300_000_000_000_000n,
      },
    ]);
    const terms = await readMintableTerms(client, FACTORY, 0, 1_000n);
    expect(terms).not.toBeNull();
    expect(terms?.mintCostWei).toBe(1_320_000_000_000_000n);
    expect(terms?.totalBeforeOpenWei).toBe(2_620_000_000_000_000n);
  });

  it("treats an unreadable processor as unavailable rather than as available", async () => {
    // An unverifiable supply must never be offered: quoting it could produce a revert.
    const client = fakeClient([
      { minted: 0n, supplyCap: 100n, mintPriceWei: 1n, protocolFeeWei: 1n, unreadable: true },
      { minted: 0n, supplyCap: 100n, mintPriceWei: 1n, protocolFeeWei: 1n },
    ]);
    const listed = await listMintableProcessors({ client, factory: FACTORY });
    expect(listed.processors.map((entry) => entry.cpuIndex)).toEqual([1]);
    expect(listed.soldOut).toBe(1);
  });

  it("returns unavailable (not an empty list) when the catalogue cannot be read at all", async () => {
    const client: MintableReadClient = {
      getBlockNumber: async () => {
        throw new Error("rpc down");
      },
      readContract: async () => {
        throw new Error("rpc down");
      },
    };
    const listed = await listMintableProcessors({ client, factory: FACTORY });
    // An empty list would read as "no stock"; this says "we could not check".
    expect(listed.syncStatus).toBe("unavailable");
    expect(listed.processors).toEqual([]);
    expect(listed.observedBlock).toBeNull();
  });

  it("bounds the scan with maxProcessors and the result with limit", async () => {
    const client = fakeClient(
      Array.from({ length: 10 }, (_, index) => ({
        minted: 0n,
        supplyCap: 100n,
        mintPriceWei: BigInt(10 - index),
        protocolFeeWei: 1n,
      })),
    );
    const listed = await listMintableProcessors({ client, factory: FACTORY, maxProcessors: 4, limit: 2 });
    expect(listed.examined).toBe(4);
    expect(listed.processors).toHaveLength(2);
  });
});

describe("self-mint quote (§12, §4)", () => {
  it("prices the two authorised steps and states the opener fee separately", async () => {
    const { buildSelfMintQuote } = await import(
      "../../apps/api/src/provisioning/self-mint-quote.js"
    );
    const client = fakeClient([
      {
        minted: 181n,
        supplyCap: 100_000n,
        mintPriceWei: 660_000_000_000_000n,
        protocolFeeWei: 660_000_000_000_000n,
        tapeoutFeeWei: 1_300_000_000_000_000n,
        nextId: 9n,
      },
    ]);
    const quote = await buildSelfMintQuote({
      client,
      factory: FACTORY,
      opener: OPENER,
      cpuIndex: 0,
    });
    expect(quote).not.toBeNull();
    if (quote === null) return;

    // Only mint and tapeout are authorised by this quote; open needs the real token id.
    expect(quote.steps.map((step) => step.kind)).toEqual(["mint", "tapeout"]);
    expect(quote.openQuotedSeparately).toBe(true);

    // tapeout's value must be exactly the fee — the contract refuses anything else.
    expect(quote.steps[1]?.valueWei).toBe("1300000000000000");
    expect(quote.steps[0]?.valueWei).toBe("1320000000000000");

    expect(quote.predictedTokenId).toBe("10");
    expect(quote.processor.available).toBe("99819");
    expect(quote.sourceId).toBe("builtin:self-mint");
  });

  it("returns null for a sold-out processor so the route can offer the ones with stock", async () => {
    const { buildSelfMintQuote } = await import(
      "../../apps/api/src/provisioning/self-mint-quote.js"
    );
    const client = fakeClient([
      { minted: 100_000n, supplyCap: 100_000n, mintPriceWei: 1n, protocolFeeWei: 1n },
    ]);
    const quote = await buildSelfMintQuote({
      client,
      factory: FACTORY,
      opener: OPENER,
      cpuIndex: 0,
    });
    expect(quote).toBeNull();
  });
});
