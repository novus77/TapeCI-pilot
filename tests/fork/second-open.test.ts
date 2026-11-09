/**
 * P3-03 — what does a **second** `open` on an already-opened circuit actually do?
 *
 * This was the programme's largest unmeasured money risk: `open` is permissionless
 * on chain, and nobody had established whether a repeat call reverts, no-ops, or
 * charges `FEE()` again (0.08 OKB). A guess either way is unacceptable, so this
 * measures it against a real X Layer fork.
 *
 * Method: impersonate the current holder on the fork, send the real `open` call
 * twice, and record what the chain does with the second one — status, gas, and the
 * opener balance change. Nothing is signed against mainnet and no real funds move:
 * the fork is a local copy pinned to one block.
 *
 *     PATH="$HOME/.foundry/bin:$PATH" \
 *       node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs exec vitest run tests/fork/second-open.test.ts
 *
 * If the fork cannot start the suite fails; it never reports a skip as a pass.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { XLAYER_MAINNET, type ChainConfig } from "@tapeci/config";
import { factoryAbi, openerAbi, processorAbi } from "@tapeci/chain";
import { createReadClient } from "@tapeci/chain";
import { rpcRequest, startAnvilFork, type AnvilFork } from "../../scripts/fork/anvil.js";

interface OpenFacts {
  readonly tokenId: bigint;
  readonly owner: Address;
  readonly feeWei: bigint;
}

interface Ctx {
  readonly fork: AnvilFork;
  readonly config: ChainConfig;
  readonly pin: bigint;
  readonly processor: Address;
  readonly target: OpenFacts;
}

let context: Ctx | null = null;

/** Sends a transaction on the fork from an impersonated account. */
async function sendAs(
  fork: AnvilFork,
  from: Address,
  to: Address,
  data: Hex,
  value: bigint,
): Promise<{ status: string | null; gasUsed: bigint | null; error: string | null }> {
  await rpcRequest(fork.url, "anvil_impersonateAccount", [from]);
  try {
    const hash = (await rpcRequest(fork.url, "eth_sendTransaction", [
      { from, to, data, value: `0x${value.toString(16)}` },
    ])) as Hex;
    // The fork does not mine per transaction, so the receipt only exists after an
    // explicit block. A pending transaction would otherwise look like "no result".
    await rpcRequest(fork.url, "evm_mine", []).catch(() => undefined);
    const receipt = (await rpcRequest(fork.url, "eth_getTransactionReceipt", [hash])) as {
      status?: string;
      gasUsed?: Hex;
    } | null;
    return {
      status: receipt?.status ?? null,
      gasUsed: receipt?.gasUsed === undefined ? null : BigInt(receipt.gasUsed),
      error: null,
    };
  } catch (error) {
    return { status: null, gasUsed: null, error: String(error).slice(0, 200) };
  } finally {
    await rpcRequest(fork.url, "anvil_stopImpersonatingAccount", [from]).catch(() => undefined);
  }
}

describe("P3-03 fork: a second open on an already-opened circuit", () => {
  beforeAll(async () => {
    const fork = await startAnvilFork();
    const client = createReadClient(fork.url);
    const pin = fork.forkBlockNumber;
    const config = XLAYER_MAINNET;

    // Find an opened circuit and its owner by scanning a processor's tokens.
    // The factory calls a processor a "cpu" (packages/chain/src/abis.ts:33-44).
    const processor = (await client.readContract({
      address: config.factory,
      abi: factoryAbi,
      functionName: "cpuAt",
      args: [0n],
      blockNumber: pin,
    })) as Address;

    const feeWei = (await client.readContract({
      address: config.opener,
      abi: openerAbi,
      functionName: "FEE",
      blockNumber: pin,
    })) as bigint;

    let target: OpenFacts | null = null;
    for (let token = 0n; token <= 40n && target === null; token += 1n) {
      try {
        const owner = (await client.readContract({
          address: processor,
          abi: processorAbi,
          functionName: "ownerOf",
          args: [token],
          blockNumber: pin,
        })) as Address;
        // `isDeployed`/`isOpened` live on the opener and take (circuits, tokenId),
        // not the container address (packages/chain/src/abis.ts:49-50).
        const deployed = (await client.readContract({
          address: config.opener,
          abi: openerAbi,
          functionName: "isDeployed",
          args: [processor, token],
          blockNumber: pin,
        })) as boolean;
        const opened = (await client.readContract({
          address: config.opener,
          abi: openerAbi,
          functionName: "isOpened",
          args: [processor, token],
          blockNumber: pin,
        })) as boolean;
        if (deployed && opened) target = { tokenId: token, owner: getAddress(owner), feeWei };
      } catch {
        // No token at that index; keep scanning.
      }
    }

    context = { fork, config, pin, processor: getAddress(processor), target: target ?? { tokenId: 0n, owner: "0x0000000000000000000000000000000000000000", feeWei } };
  }, 240_000);

  afterAll(async () => {
    await context?.fork.stop();
  });

  it("records what the second open actually does, and never assumes", async () => {
    const ctx = context;
    expect(ctx, "the fork did not start").not.toBeNull();
    if (ctx === null) return;

    // No naturally opened circuit on this processor means the measurement cannot be
    // made; report that plainly rather than inventing a result.
    if (ctx.target.owner === "0x0000000000000000000000000000000000000000") {
      throw new Error(
        `no opened circuit found on processor ${ctx.processor} at block ${ctx.pin}; ` +
          "the second-open behaviour is still UNMEASURED",
      );
    }

    const openData = {
      abi: openerAbi,
      functionName: "open" as const,
      args: [ctx.processor, ctx.target.tokenId] as const,
    };
    const calldata = (await import("viem")).encodeFunctionData(openData);

    // Fund the impersonated holder on the fork first, so the balance delta below
    // measures what the call actually cost rather than the funding change.
    await rpcRequest(ctx.fork.url, "anvil_setBalance", [ctx.target.owner, "0x21e19e0c9bab2400000"]);
    const balanceBefore = (await rpcRequest(ctx.fork.url, "eth_getBalance", [
      ctx.target.owner,
      "latest",
    ])) as Hex;

    const second = await sendAs(
      ctx.fork,
      ctx.target.owner,
      ctx.config.opener,
      calldata,
      ctx.target.feeWei,
    );

    const balanceAfter = (await rpcRequest(ctx.fork.url, "eth_getBalance", [
      ctx.target.owner,
      "latest",
    ])) as Hex;
    const spent = BigInt(balanceBefore) - BigInt(balanceAfter);

    // Record the measurement in one structured line so the evidence is reviewable.
    console.log(
      JSON.stringify({
        event: "second_open_measurement",
        chainId: 196,
        pinnedBlock: ctx.pin.toString(),
        processor: ctx.processor,
        tokenId: ctx.target.tokenId.toString(),
        feeWei: ctx.target.feeWei.toString(),
        secondOpenStatus: second.status,
        secondOpenGasUsed: second.gasUsed?.toString() ?? null,
        secondOpenError: second.error,
        ownerSpentWei: spent.toString(),
        /** A `true` here means a repeat open can charge FEE() a second time. */
        chargedFeeAgain: spent >= ctx.target.feeWei,
      }),
    );

    // The measurement itself must have happened: silence is the only unacceptable
    // outcome, because it would mean the evidence file describes something unobserved.
    expect(
      second.status !== null || second.error !== null,
      "the second open neither returned a receipt nor an error — nothing was measured",
    ).toBe(true);

    // The claim in `p3-13-second-open-fork.json` is specific, so assert it specifically
    // rather than only "something was measured". A changed chain would fail here, which
    // is the point: the evidence must not outlive the behaviour it describes.
    expect(second.error, "the second open reverted as expected, with a receipt").toBeNull();
    expect(second.status, "a second open on an opened circuit reverts").toBe("0x0");

    // Reverting still costs gas, so the holder pays *something* — but never the opener fee.
    expect(spent, "a reverted second open still consumes gas").toBeGreaterThan(0n);
    expect(
      spent,
      `a second open charged ${spent} wei, which is at least the ${ctx.target.feeWei} wei ` +
        "opener fee — this is the double-charge case P3-03 warned about",
    ).toBeLessThan(ctx.target.feeWei);
  }, 120_000);
});
