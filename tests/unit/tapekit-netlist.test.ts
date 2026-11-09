/**
 * Netlist encoding (SPEC `2026-10-28-self-mint-spec.md` §3, §7 U-1…U-6).
 *
 * The tapeout is irreversible and costs real money, so the encoder has to reject a malformed
 * netlist locally rather than let the contract revert after the user has paid gas.
 */
import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";

import {
  CONSTANT_ONE,
  CONSTANT_ZERO,
  FIRST_INPUT_SIGNAL,
  NETLIST_OP,
  NetlistEncodingError,
  TAPED_OUT_TOPIC,
  buildMintIntent,
  encodeNetlist,
  inverterCircuit,
  latch,
  nand,
  ref,
} from "../../packages/tapekit/src/index.js";

describe("netlist encoding (§3)", () => {
  it("U-1: encodes nand(2,2) as 7 bytes — opcode then two big-endian u24 indices", () => {
    const encoded = encodeNetlist([nand(FIRST_INPUT_SIGNAL, FIRST_INPUT_SIGNAL)], 1, 1);
    // 0x00 | 00 00 02 | 00 00 02
    expect(encoded.hex).toBe("0x00000002000002");
    expect(encoded.bytes).toHaveLength(7);
  });

  it("U-2: rejects a NAND that references a signal which does not exist yet", () => {
    // Signal 3 would be the NAND's own output — a forward reference the VM cannot evaluate.
    expect(() => encodeNetlist([nand(3, FIRST_INPUT_SIGNAL)], 1, 1)).toThrow(NetlistEncodingError);
    // The first legal output index for a 1-input circuit is 3, so referencing it early fails.
    const legal = encodeNetlist([nand(FIRST_INPUT_SIGNAL, FIRST_INPUT_SIGNAL), nand(3, 3)], 1, 1);
    expect(legal.bytes.length).toBe(14);
  });

  it("U-3: allows a LATCH to point forward, but not outside the signal space", () => {
    // A latch reading its own output is the simplest legal feedback loop.
    const encoded = encodeNetlist([latch(3), nand(3, 3)], 1, 1);
    expect(encoded.bytes[0]).toBe(NETLIST_OP.LATCH);
    expect(encoded.signalCount).toBe(5);

    // One past the end is not a signal, so it must be refused rather than encoded.
    expect(() => encodeNetlist([latch(5)], 1, 1)).toThrow(NetlistEncodingError);
  });

  it("U-4: outputs are the LAST nOut signals, so element order defines the pins", () => {
    // Two elements produce signals 3 and 4; nOut=2 selects the last two, i.e. {3, 4}.
    const two = encodeNetlist([nand(2, 2), nand(3, 3)], 1, 2);
    expect(two.signalCount).toBe(5);

    // An input pin is itself a signal, so `nOut=2` over `[nand(2,2)]` selects {2, 3} and is
    // legal — the last two signals exist. Whatever the pins mean is the circuit's business,
    // not the encoder's.
    expect(encodeNetlist([nand(2, 2)], 1, 2).signalCount).toBe(4);

    // Claiming more outputs than the netlist produces is the real error, because those
    // signals do not exist.
    expect(() => encodeNetlist([nand(2, 2)], 1, 5)).toThrow(NetlistEncodingError);
  });

  it("U-5: multi-byte integers are big-endian", () => {
    // cid = 0x0102030405060708 must appear in that byte order (u64 BE).
    const encoded = encodeNetlist(
      [ref({ cpu: `0x${"11".repeat(20)}`, cid: 0x0102030405060708n, inputs: [2], outputs: 1 })],
      1,
      1,
    );
    const hex = encoded.hex.slice(2).toLowerCase();
    expect(hex).toContain("0102030405060708");
    // Layout: 0x02 | cpu(20B) | cid(8B) | rIn | rOut | inputs
    expect(hex.slice(0, 2)).toBe("02");
    expect(hex.slice(2, 42)).toBe("11".repeat(20));
  });

  it("U-6: rejects an empty netlist, nIn = 0, and nOut beyond the signal space", () => {
    expect(() => encodeNetlist([], 1, 1)).toThrow(NetlistEncodingError);
    expect(() => encodeNetlist([nand(2, 2)], 0, 1)).toThrow(NetlistEncodingError);
    expect(() => encodeNetlist([nand(2, 2)], 1, 5)).toThrow(NetlistEncodingError);
    expect(() => encodeNetlist([nand(2, 2)], 1, 0)).toThrow(NetlistEncodingError);
  });

  it("the inverter circuit is the documented minimal shape", () => {
    const circuit = inverterCircuit();
    expect(circuit).toMatchObject({ nIn: 1, nOut: 1 });
    expect(circuit.ops).toHaveLength(1);
    const encoded = encodeNetlist(circuit.ops, circuit.nIn, circuit.nOut);
    expect(encoded.signalCount).toBe(4); // two constants + 1 input + 1 gate
    expect(encoded.hex).toBe("0x00000002000002");
  });

  it("the signal constants match the VM's layout", () => {
    expect(CONSTANT_ZERO).toBe(0);
    expect(CONSTANT_ONE).toBe(1);
    expect(FIRST_INPUT_SIGNAL).toBe(2);
  });
});

describe("mint intent (§2, §4)", () => {
  const base = {
    processor: `0x${"aa".repeat(20)}` as const,
    transistors: `0x${"bb".repeat(20)}` as const,
    netlistHex: "0x00000002000002" as const,
    nIn: 1,
    nOut: 1,
    tapeoutFeeWei: 80_000_000_000_000_000n,
    mintPriceWei: 1_000_000_000_000_000n,
    protocolFeeWei: 500_000_000_000_000n,
    nandId: 0n,
    transistorBalance: 0n,
    nextId: 42n,
  };

  it("sets tapeout value to the fee EXACTLY — not a cap, not a rounded estimate", () => {
    const intent = buildMintIntent(base);
    expect(intent.tapeout.value).toBe(base.tapeoutFeeWei);
    // One wei either way is a revert on chain, so the value must not be adjusted.
    expect(intent.tapeout.value).not.toBe(base.tapeoutFeeWei + 1n);
  });

  it("charges mintPrice + protocolFee when the wallet has no transistor", () => {
    const intent = buildMintIntent(base);
    expect(intent.mint.value).toBe(base.mintPriceWei + base.protocolFeeWei);
    expect(intent.terms.mintSkipped).toBe(false);
    expect(intent.terms.transistorsNeeded).toBe(1n);
  });

  it("skips the mint when the wallet already holds enough transistors", () => {
    // Paying for a transistor the user already owns is a real waste, so it must be skipped.
    const intent = buildMintIntent({ ...base, transistorBalance: 1n });
    expect(intent.terms.mintSkipped).toBe(true);
    expect(intent.mint.value).toBe(0n);
    expect(intent.terms.transistorsNeeded).toBe(0n);
  });

  it("reports the predicted token id as nextId + 1, never as a promise", () => {
    const intent = buildMintIntent(base);
    expect(intent.terms.predictedTokenId).toBe("43");
  });

  it("rejects negative fees rather than encoding them", () => {
    expect(() => buildMintIntent({ ...base, tapeoutFeeWei: -1n })).toThrow();
  });

  it("computes the TapedOut topic from the full signature, not a truncated selector", () => {
    // The protocol warns about this: an event topic is keccak of the whole signature, so a
    // 4-byte function-selector prefix can never match.
    expect(TAPED_OUT_TOPIC).toBe(
      keccak256(toHex("TapedOut(uint256,address,uint32,uint32)")),
    );
    expect(TAPED_OUT_TOPIC).toHaveLength(66);
    expect(TAPED_OUT_TOPIC.slice(0, 10)).not.toBe("0x00000000");
  });
});
