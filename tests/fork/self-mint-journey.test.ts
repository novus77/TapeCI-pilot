/**
 * The whole self-mint journey, end to end, on a fork of X Layer 196.
 *
 * SPEC `2026-10-28-self-mint-spec.md` §12 says the path is possible **as long as the
 * processor is chosen from the ones that still have stock**. This suite proves that on chain:
 * a wallet with nothing mints a transistor, tapes out a circuit, opens its container, and
 * ends up with a real ERC-6551 account — all with an address that starts at zero balance.
 *
 * It deliberately uses a processor found by `listMintableProcessors` rather than a hardcoded
 * index. Hardcoding processor 0 is the mistake that produced the wrong "sold out" conclusion
 * once already.
 *
 *     PATH="$HOME/.foundry/bin:$PATH" \
 *       node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs exec vitest run tests/fork/self-mint-journey.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { XLAYER_MAINNET } from "@tapeci/config";
import { createReadClient, openerAbi } from "@tapeci/chain";
import { encodeNetlist, inverterCircuit } from "../../packages/tapekit/src/index.js";
import {
  listMintableProcessors,
  type MintableProcessorTerms,
} from "../../apps/api/src/provisioning/mintable.js";
import { rpcRequest, startAnvilFork, type AnvilFork } from "../../scripts/fork/anvil.js";

const transistorsAbi = [
  { type: "function", name: "NAND", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "payable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [] },
] as const;

interface Journey {
  readonly fork: AnvilFork;
  readonly pin: bigint;
  readonly terms: MintableProcessorTerms;
}

let journey: Journey | null = null;

function calldata(signature: string, words: readonly string[]): Hex {
  return `${keccak256(toHex(signature)).slice(0, 10)}${words.join("")}` as Hex;
}

const word = (value: bigint): string => value.toString(16).padStart(64, "0");

/** ABI-encode `tapeout(bytes,uint32,uint32)` — head of three words, then the bytes tail. */
function tapeoutData(netlistHex: Hex, nIn: number, nOut: number): Hex {
  const raw = netlistHex.slice(2);
  const padded = raw.padEnd(Math.ceil(raw.length / 64) * 64, "0");
  return calldata("tapeout(bytes,uint32,uint32)", [
    word(0x60n), // offset to the bytes tail
    word(BigInt(nIn)),
    word(BigInt(nOut)),
    word(BigInt(raw.length / 2)), // tail: length
    padded, // tail: data
  ]);
}

async function send(
  fork: AnvilFork,
  from: Address,
  to: Address,
  data: Hex,
  value: bigint,
): Promise<{ ok: boolean; logs: readonly { topics: readonly Hex[]; data: Hex }[]; error: string | null }> {
  await rpcRequest(fork.url, "anvil_impersonateAccount", [from]);
  await rpcRequest(fork.url, "anvil_setBalance", [from, "0x21e19e0c9bab2400000"]);
  try {
    const hash = (await rpcRequest(fork.url, "eth_sendTransaction", [
      { from, to, data, value: `0x${value.toString(16)}` },
    ])) as Hex;
    await rpcRequest(fork.url, "evm_mine", []);
    const receipt = (await rpcRequest(fork.url, "eth_getTransactionReceipt", [hash])) as {
      status?: Hex;
      logs?: { topics: readonly Hex[]; data: Hex }[];
    } | null;
    return { ok: receipt?.status === "0x1", logs: receipt?.logs ?? [], error: null };
  } catch (error) {
    return { ok: false, logs: [], error: String(error).slice(0, 240) };
  } finally {
    await rpcRequest(fork.url, "anvil_stopImpersonatingAccount", [from]).catch(() => undefined);
  }
}

describe("self-mint journey on a fork (§12)", () => {
  beforeAll(async () => {
    const fork = await startAnvilFork();
    const client = createReadClient(fork.url);
    const pin = fork.forkBlockNumber;

    // Find a processor with stock, the same way the API does. Scanning a bounded prefix keeps
    // the suite fast while still refusing to assume index 0.
    const listed = await listMintableProcessors({
      client,
      factory: XLAYER_MAINNET.factory,
      maxProcessors: 60,
      limit: 5,
    });
    if (listed.syncStatus !== "verified" || listed.processors.length === 0) {
      throw new Error("no mintable processor found in the first 60; the catalogue may be unreadable");
    }
    const terms = listed.processors[0];
    if (terms === undefined) throw new Error("no mintable processor");
    journey = { fork, pin, terms };
  }, 600_000);

  afterAll(async () => {
    await journey?.fork.stop();
  });

  it("starts from a wallet that holds nothing", async () => {
    const ctx = journey;
    if (ctx === null) throw new Error("no journey");
    const client = createReadClient(ctx.fork.url);
    const holder = getAddress(`0x${"4a".repeat(20)}`);
    const balance = (await client.readContract({
      address: ctx.terms.transistors,
      abi: transistorsAbi,
      functionName: "balanceOf",
      args: [holder, 0n],
      blockNumber: ctx.pin,
    })) as bigint;
    expect(balance, "the journey must start from zero").toBe(0n);
  }, 180_000);

  it("mints one transistor, tapes out, and opens the container — in that order", async () => {
    const ctx = journey;
    if (ctx === null) throw new Error("no journey");
    const client = createReadClient(ctx.fork.url);
    const holder = getAddress(`0x${"4b".repeat(20)}`);
    const terms = ctx.terms;

    // ── 1. mint one transistor, paying mintPrice + protocolFee ────────────────
    const minted = await send(
      ctx.fork,
      holder,
      terms.transistors,
      calldata("mint(uint256,uint256)", [word(0n), word(1n)]),
      terms.mintCostWei,
    );
    expect(minted.error, `mint failed: ${minted.error ?? ""}`).toBeNull();
    expect(minted.ok, "mint must succeed on a processor with stock").toBe(true);

    const balanceAfterMint = (await client.readContract({
      address: terms.transistors,
      abi: transistorsAbi,
      functionName: "balanceOf",
      args: [holder, 0n],
    })) as bigint;
    expect(balanceAfterMint).toBe(1n);

    // ── 2. tape out, paying TAPEOUT_FEE exactly ──────────────────────────────
    const circuit = inverterCircuit();
    const encoded = encodeNetlist(circuit.ops, circuit.nIn, circuit.nOut);
    const taped = await send(
      ctx.fork,
      holder,
      terms.processor,
      tapeoutData(encoded.hex, circuit.nIn, circuit.nOut),
      terms.tapeoutFeeWei,
    );
    expect(taped.error, `tapeout failed: ${taped.error ?? ""}`).toBeNull();
    expect(taped.ok, "tapeout must succeed when the holder has a transistor").toBe(true);

    const topic = keccak256(toHex("TapedOut(uint256,address,uint32,uint32)"));
    const event = taped.logs.find((log) => log.topics[0]?.toLowerCase() === topic.toLowerCase());
    expect(event, "a successful tapeout emits TapedOut").toBeDefined();
    const tokenId = BigInt(event?.topics[1] as Hex);
    expect(tokenId).toBeGreaterThan(0n);
    // The predicted id is nextId+1 and the actual can only be >= that.
    expect(tokenId).toBeGreaterThanOrEqual(terms.nextId + 1n);

    // ── 3. derive and open the container ─────────────────────────────────────
    const container = getAddress(
      (await client.readContract({
        address: XLAYER_MAINNET.opener,
        abi: openerAbi,
        functionName: "accountOf",
        args: [terms.processor, tokenId],
      })) as string,
    );
    expect(
      (await client.readContract({
        address: XLAYER_MAINNET.opener,
        abi: openerAbi,
        functionName: "isOpened",
        args: [terms.processor, tokenId],
      })) as boolean,
    ).toBe(false);

    const openerFee = (await client.readContract({
      address: XLAYER_MAINNET.opener,
      abi: openerAbi,
      functionName: "FEE",
      blockNumber: ctx.pin,
    })) as bigint;
    const opened = await send(
      ctx.fork,
      holder,
      XLAYER_MAINNET.opener,
      calldata("open(address,uint256)", [terms.processor.slice(2).toLowerCase().padStart(64, "0"), word(tokenId)]),
      openerFee,
    );
    expect(opened.error, `open failed: ${opened.error ?? ""}`).toBeNull();
    expect(opened.ok, "open must succeed on a freshly taped circuit").toBe(true);

    const openedNow = (await client.readContract({
      address: XLAYER_MAINNET.opener,
      abi: openerAbi,
      functionName: "isOpened",
      args: [terms.processor, tokenId],
    })) as boolean;
    expect(openedNow, "the container is live after open()").toBe(true);

    // The measured journey, so the numbers can be compared against the UI later.
    console.log(
      JSON.stringify({
        event: "self_mint_journey",
        pinnedBlock: ctx.pin.toString(),
        cpuIndex: terms.cpuIndex,
        processor: terms.processor,
        transistors: terms.transistors,
        tokenId: tokenId.toString(),
        container,
        costs: {
          mintCostWei: terms.mintCostWei.toString(),
          tapeoutFeeWei: terms.tapeoutFeeWei.toString(),
          openerFeeWei: openerFee.toString(),
          totalWei: (terms.mintCostWei + terms.tapeoutFeeWei + openerFee).toString(),
        },
      }),
    );
  }, 600_000);
});
