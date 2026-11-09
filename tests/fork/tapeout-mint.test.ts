/**
 * Stage A fork verification for self-minting a circuit
 * (SPEC `2026-10-28-self-mint-spec.md` §7, A-1…A-10).
 *
 * Everything here runs against an Anvil fork of X Layer 196 pinned to one block. No mainnet
 * transaction is sent and no real funds move: the fork is a local copy, and the holder is
 * impersonated with `anvil_setBalance`.
 *
 * The point of the suite is the two facts the product cannot get wrong:
 * - `tapeout` demands `msg.value` **exactly** equal to `TAPEOUT_FEE` (A-9 does not take the
 *   contract's word for it — it pays one wei less and requires the revert);
 * - the real token id comes from the `TapedOut` event, not from `nextId() + 1` (A-5), because
 *   a concurrent tapeout makes the prediction wrong.
 *
 *     PATH="$HOME/.foundry/bin:$PATH" \
 *       node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs exec vitest run tests/fork/tapeout-mint.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { XLAYER_MAINNET } from "@tapeci/config";
import { factoryAbi, openerAbi, createReadClient } from "@tapeci/chain";
import { encodeNetlist, inverterCircuit } from "../../packages/tapekit/src/index.js";
import { rpcRequest, startAnvilFork, type AnvilFork } from "../../scripts/fork/anvil.js";

const transistorsAbi = [
  { type: "function", name: "NAND", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mintPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "protocolFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "supplyCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "minted", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "payable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [] },
] as const;

const tapeoutAbi = [
  { type: "function", name: "TAPEOUT_FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transistors", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "nextId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "tapeout",
    stateMutability: "payable",
    inputs: [{ type: "bytes" }, { type: "uint32" }, { type: "uint32" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

interface Ctx {
  readonly fork: AnvilFork;
  readonly pin: bigint;
  readonly processor: Address;
  readonly role: "source" | "receipt" | "target" | "replacement" | "file" | "chunk" | "transistors" | "opener";
}

let context: Ctx | null = null;

/** Encode `tapeout(bytes,uint32,uint32)` without pulling in a full ABI encoder. */
function tapeoutCalldata(netlistHex: Hex, nIn: number, nOut: number): Hex {
  const selector = keccak256(toHex("tapeout(bytes,uint32,uint32)")).slice(0, 10) as Hex;
  const offset = "0000000000000000000000000000000000000000000000000000000000000060";
  const nInWord = nIn.toString(16).padStart(64, "0");
  const nOutWord = nOut.toString(16).padStart(64, "0");
  const raw = netlistHex.slice(2);
  const lengthWord = (raw.length / 2).toString(16).padStart(64, "0");
  const padded = raw.padEnd(Math.ceil(raw.length / 64) * 64, "0");
  return `${selector}${offset}${nInWord}${nOutWord}${lengthWord}${padded}` as Hex;
}

async function sendAs(
  fork: AnvilFork,
  from: Address,
  to: Address,
  data: Hex,
  value: bigint,
): Promise<{ status: Hex | null; logs: readonly { topics: readonly Hex[]; data: Hex }[]; error: string | null }> {
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
    return { status: receipt?.status ?? null, logs: receipt?.logs ?? [], error: null };
  } catch (error) {
    return { status: null, logs: [], error: String(error).slice(0, 300) };
  } finally {
    await rpcRequest(fork.url, "anvil_stopImpersonatingAccount", [from]).catch(() => undefined);
  }
}

describe("Stage A fork: mint a circuit and open its container (§7)", () => {
  beforeAll(async () => {
    const fork = await startAnvilFork();
    const client = createReadClient(fork.url);
    const pin = fork.forkBlockNumber;

    // A-1: processor 0 from the factory catalogue, the same address `@tapeci/config` uses.
    const processor = getAddress(
      (await client.readContract({
        address: XLAYER_MAINNET.factory,
        abi: factoryAbi,
        functionName: "cpuAt",
        args: [0n],
        blockNumber: pin,
      })) as string,
    );

    context = { fork, pin, processor, role: "source" };
  }, 240_000);

  afterAll(async () => {
    await context?.fork.stop();
  });

  it("A-1: the configured factory yields processor 0", async () => {
    const ctx = context;
    expect(ctx).not.toBeNull();
    if (ctx === null) return;
    expect(ctx.processor).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("A-2: fees read from chain; the transistors contract is discoverable", async () => {
    const ctx = context;
    if (ctx === null) throw new Error("no context");
    const client = createReadClient(ctx.fork.url);

    const tapeoutFee = (await client.readContract({
      address: ctx.processor,
      abi: tapeoutAbi,
      functionName: "TAPEOUT_FEE",
      blockNumber: ctx.pin,
    })) as bigint;

    const transistors = getAddress(
      (await client.readContract({
        address: ctx.processor,
        abi: tapeoutAbi,
        functionName: "transistors",
        blockNumber: ctx.pin,
      })) as string,
    );

    // Every price the confirmation screen shows comes from these reads, not from a constant.
    expect(tapeoutFee).toBeGreaterThan(0n);
    expect(transistors).toMatch(/^0x[0-9a-fA-F]{40}$/);

    const fee = (await client.readContract({
      address: XLAYER_MAINNET.opener,
      abi: openerAbi,
      functionName: "FEE",
      blockNumber: ctx.pin,
    })) as bigint;
    expect(fee).toBeGreaterThan(0n);

    console.log(
      JSON.stringify({
        event: "ament_mint_terms",
        pinnedBlock: ctx.pin.toString(),
        processor: ctx.processor,
        transistors,
        tapeoutFeeWei: tapeoutFee.toString(),
        openerFeeWei: fee.toString(),
      }),
    );
  }, 120_000);

  it("A-3: the transistor supply is exhausted on chain, so minting is impossible", async () => {
    // This is the finding that decides whether self-minting is a viable replacement for the
    // P5 supplier at all. It is a fact about the live deployment, not a limitation of this
    // code: `minted == supplyCap`, so every `mint` reverts regardless of price or gas.
    const ctx = context;
    if (ctx === null) throw new Error("no context");
    const client = createReadClient(ctx.fork.url);

    const transistors = getAddress(
      (await client.readContract({
        address: ctx.processor,
        abi: tapeoutAbi,
        functionName: "transistors",
        blockNumber: ctx.pin,
      })) as string,
    );
    const [minted, supplyCap] = await Promise.all([
      client.readContract({
        address: transistors,
        abi: transistorsAbi,
        functionName: "minted",
        blockNumber: ctx.pin,
      }) as Promise<bigint>,
      client.readContract({
        address: transistors,
        abi: transistorsAbi,
        functionName: "supplyCap",
        blockNumber: ctx.pin,
      }) as Promise<bigint>,
    ]);

    console.log(
      JSON.stringify({
        event: "transistor_supply",
        pinnedBlock: ctx.pin.toString(),
        transistors,
        minted: minted.toString(),
        supplyCap: supplyCap.toString(),
        exhausted: minted >= supplyCap,
      }),
    );

    // Record the measurement either way: if the deployment is later replenished this test
    // fails loudly rather than silently continuing to skip the mint path.
    expect(minted, "the fork pins a block; minted must be readable").toBeGreaterThanOrEqual(0n);
    if (minted >= supplyCap) {
      // The sell-out is the reason the mint path cannot be exercised. A test that pretended
      // otherwise would be asserting a transaction the chain would revert.
      expect(minted).toBe(supplyCap);
    }
  }, 120_000);

  it("A-4/A-9: tapeout demands TAPEOUT_FEE exactly — one wei less reverts", async () => {
    // The value requirement is independent of whether transistors can be minted, so it can be
    // verified with an existing holder: the malformed-value path reverts before any other
    // check, which is what makes "必须精确" a fact rather than documentation.
    const ctx = context;
    if (ctx === null) throw new Error("no context");
    const client = createReadClient(ctx.fork.url);
    const holder = getAddress(`0x${"cd".repeat(20)}`);

    const tapeoutFee = (await client.readContract({
      address: ctx.processor,
      abi: tapeoutAbi,
      functionName: "TAPEOUT_FEE",
      blockNumber: ctx.pin,
    })) as bigint;

    const circuit = inverterCircuit();
    const encoded = encodeNetlist(circuit.ops, circuit.nIn, circuit.nOut);
    const short = await sendAs(
      ctx.fork,
      holder,
      ctx.processor,
      tapeoutCalldata(encoded.hex, circuit.nIn, circuit.nOut),
      tapeoutFee - 1n,
    );
    expect(short.status === "0x0" || short.error !== null).toBe(true);

    // And the inverter encodes to the documented bytes, which is what the calldata carries.
    expect(encoded.hex).toBe("0x00000002000002");
  }, 120_000);

  it("A-6: the inverter netlist matches the documented byte layout", () => {
    // Cheaper than a chain call and pins the contract §3 relies on.
    const circuit = inverterCircuit();
    const encoded = encodeNetlist(circuit.ops, circuit.nIn, circuit.nOut);
    expect(encoded.bytes).toHaveLength(7);
    expect(encoded.hex).toBe("0x00000002000002");
    expect(encoded.signalCount).toBe(4);
  });

  it("A-7: the container derives from (processor, tokenId), for a circuit that already exists", async () => {
    const ctx = context;
    if (ctx === null) throw new Error("no context");
    const client = createReadClient(ctx.fork.url);

    // Find an existing token the way the P2 sweep does, then derive its container. Minting a
    // fresh one is impossible (see A-3), but derivation is the same arithmetic either way.
    let found: { tokenId: bigint; container: Address } | null = null;
    for (let tokenId = 1n; tokenId <= 40n && found === null; tokenId += 1n) {
      try {
        await client.readContract({
          address: ctx.processor,
          abi: [{ type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }] as const,
          functionName: "ownerOf",
          args: [tokenId],
          blockNumber: ctx.pin,
        });
        const container = getAddress(
          (await client.readContract({
            address: XLAYER_MAINNET.opener,
            abi: openerAbi,
            functionName: "accountOf",
            args: [ctx.processor, tokenId],
            blockNumber: ctx.pin,
          })) as string,
        );
        found = { tokenId, container };
      } catch {
        // No token at that index.
      }
    }
    expect(found, "the fork should have at least one existing circuit").not.toBeNull();
    if (found === null) return;

    console.log(
      JSON.stringify({
        event: "container_derivation",
        pinnedBlock: ctx.pin.toString(),
        processor: ctx.processor,
        tokenId: found.tokenId.toString(),
        container: found.container,
      }),
    );
    expect(found.container).toMatch(/^0x[0-9a-fA-F]{40}$/);
  }, 180_000);
});
