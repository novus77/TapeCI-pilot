/**
 * Domain-binding core — pure unit tests (no network, no clock, no keys).
 *
 * Covers the plan's acceptance bullet "unit: name validation, months bounds, fee
 * maths, idempotency decision" plus the fee-0 reality observed on X Layer on
 * 2026-10-25 (`monthlyFee()` = 0, so `valueWei` must be exactly 0 and the whole
 * quoted cost is gas).
 */
import { describe, expect, it } from "vitest";
import { parseAbiItem, toFunctionSelector } from "viem";
import { WRITE_SIGNATURES, bindingAbi, selectorOf } from "@tapeci/chain";
import {
  MAX_LABEL_LENGTH,
  MAX_MONTHS,
  MAX_NAME_LENGTH,
  MIN_MONTHS,
  bindDecision,
  planBind,
  validateMonths,
  validateOnChainName,
  type BindDecisionInput,
} from "@tapeci/deployer";

describe("validateOnChainName", () => {
  it("accepts the real mainnet names", () => {
    for (const name of ["10.2.4.tape", "2.2.0.tape", "a.b", "x.tape", "a-b.c-d.tape", "0.0.0"]) {
      expect(validateOnChainName(name), name).toEqual({ ok: true });
    }
  });

  it("accepts a name at exactly the maximum lengths", () => {
    const label = "a".repeat(MAX_LABEL_LENGTH);
    expect(validateOnChainName(`${label}.${label}.${label}`)).toEqual({ ok: true });
    const longest = `${"b".repeat(MAX_LABEL_LENGTH)}.${"c".repeat(MAX_LABEL_LENGTH)}.${"d".repeat(MAX_LABEL_LENGTH)}.${"e".repeat(MAX_NAME_LENGTH - 3 * MAX_LABEL_LENGTH - 3)}`;
    expect(longest.length).toBe(MAX_NAME_LENGTH);
    expect(validateOnChainName(longest)).toEqual({ ok: true });
  });

  it("rejects a name one character over 253", () => {
    const name = `${"b".repeat(MAX_LABEL_LENGTH)}.${"c".repeat(MAX_LABEL_LENGTH)}.${"d".repeat(MAX_LABEL_LENGTH)}.${"e".repeat(MAX_NAME_LENGTH - 3 * MAX_LABEL_LENGTH - 3 + 1)}`;
    expect(name.length).toBe(MAX_NAME_LENGTH + 1);
    const result = validateOnChainName(name);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("253");
  });

  it("rejects empty and dotless names", () => {
    expect(validateOnChainName("")).toEqual({ ok: false, reason: "name is empty" });
    expect(validateOnChainName("tape").ok).toBe(false);
    expect(validateOnChainName("localhost").ok).toBe(false);
  });

  it("rejects uppercase with a dedicated reason", () => {
    const result = validateOnChainName("10.2.4.Tape");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("lowercase");
  });

  it("rejects labels that are empty, too long or contain other characters", () => {
    expect(validateOnChainName(".tape").ok).toBe(false);
    expect(validateOnChainName("tape.").ok).toBe(false);
    expect(validateOnChainName("a..tape").ok).toBe(false);
    expect(validateOnChainName(`${"a".repeat(MAX_LABEL_LENGTH + 1)}.tape`).ok).toBe(false);
    for (const name of ["a_b.tape", "a b.tape", "a+b.tape", "ü.tape", "a/.tape", "a\0.tape"]) {
      expect(validateOnChainName(name).ok, name).toBe(false);
    }
  });

  it("rejects leading/trailing hyphens in a label", () => {
    expect(validateOnChainName("-a.tape").ok).toBe(false);
    expect(validateOnChainName("a-.tape").ok).toBe(false);
    expect(validateOnChainName("a.-b.tape").ok).toBe(false);
    // a hyphen in the middle is fine
    expect(validateOnChainName("a-b.tape")).toEqual({ ok: true });
  });
});

describe("validateMonths", () => {
  it("accepts the contract range 1..120", () => {
    expect(MIN_MONTHS).toBe(1);
    expect(MAX_MONTHS).toBe(120);
    for (const months of [1, 2, 12, 119, 120]) {
      expect(validateMonths(months)).toEqual({ ok: true });
    }
  });

  it("rejects out-of-range values", () => {
    for (const months of [0, -1, 121, 1_000]) {
      expect(validateMonths(months).ok, String(months)).toBe(false);
    }
  });

  it("rejects non-integers and non-numbers", () => {
    for (const months of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateMonths(months).ok, String(months)).toBe(false);
    }
    // runtime guard against untyped callers (CLI/JSON bodies)
    expect(validateMonths("12" as unknown as number).ok).toBe(false);
    expect(validateMonths(undefined as unknown as number).ok).toBe(false);
  });
});

describe("planBind fee maths", () => {
  const base = {
    name: "10.2.4.tape",
    months: 1,
    monthlyFeeWei: 0n,
    gasPriceWei: 20_000_000n,
    estimatedGas: 187_763n,
  };

  it("is value 0 when monthlyFee() is 0 (current X Layer state)", () => {
    const plan = planBind(base);
    expect(plan.valueWei).toBe(0n);
    expect(plan.estimatedCostWei).toBe(187_763n * 20_000_000n);
    expect(plan.months).toBe(1);
    expect(plan.name).toBe("10.2.4.tape");
  });

  it("value = months * monthlyFee", () => {
    for (const [months, fee] of [
      [1, 1_000_000_000_000_000_000n],
      [12, 500n],
      [120, 3n],
    ] as const) {
      expect(planBind({ ...base, months, monthlyFeeWei: fee }).valueWei).toBe(BigInt(months) * fee);
    }
    expect(planBind({ ...base, months: 12, monthlyFeeWei: 10n ** 18n }).valueWei).toBe(12n * 10n ** 18n);
  });

  it("cost scales with gas only (fee does not enter the cost)", () => {
    const cheap = planBind({ ...base, monthlyFeeWei: 0n });
    const dear = planBind({ ...base, monthlyFeeWei: 10n ** 18n });
    expect(dear.estimatedCostWei).toBe(cheap.estimatedCostWei);
    expect(planBind({ ...base, estimatedGas: 2n * base.estimatedGas }).estimatedCostWei).toBe(
      2n * cheap.estimatedCostWei,
    );
  });

  it("rejects invalid months", () => {
    expect(() => planBind({ ...base, months: 0 })).toThrow(/months/u);
    expect(() => planBind({ ...base, months: 121 })).toThrow(/months/u);
    expect(() => planBind({ ...base, months: 1.5 })).toThrow(/months/u);
  });

  it("rejects negative inputs", () => {
    expect(() => planBind({ ...base, monthlyFeeWei: -1n })).toThrow(/monthlyFeeWei/u);
    expect(() => planBind({ ...base, gasPriceWei: -1n })).toThrow(/gasPriceWei/u);
    expect(() => planBind({ ...base, estimatedGas: -1n })).toThrow(/estimatedGas/u);
  });
});

describe("bindDecision", () => {
  const NOW = 1_790_000_000;
  const input = (patch: Partial<BindDecisionInput>): BindDecisionInput => ({
    isLive: false,
    isContainerLive: false,
    paidUntil: 0,
    nowSeconds: NOW,
    ...patch,
  });

  it("BIND when nothing is active", () => {
    expect(bindDecision(input({}))).toBe("BIND");
    expect(bindDecision(input({ paidUntil: NOW }))).toBe("BIND");
    // a record that expired strictly before now is a renewal, not a first bind
    expect(bindDecision(input({ paidUntil: NOW - 1 }))).toBe("RENEW");
    expect(bindDecision(input({ isLive: true, paidUntil: 0 }))).toBe("BIND");
  });

  it("ALREADY_LIVE when paidUntil is in the future and either flag is true", () => {
    expect(bindDecision(input({ isLive: true, paidUntil: NOW + 1 }))).toBe("ALREADY_LIVE");
    expect(bindDecision(input({ isContainerLive: true, paidUntil: NOW + 86_400 }))).toBe("ALREADY_LIVE");
    expect(bindDecision(input({ isLive: true, isContainerLive: true, paidUntil: NOW + 86_400 }))).toBe(
      "ALREADY_LIVE",
    );
  });

  it("does not trust a live flag past paidUntil", () => {
    expect(bindDecision(input({ isLive: true, paidUntil: NOW - 1 }))).toBe("RENEW");
    expect(bindDecision(input({ isContainerLive: true, paidUntil: NOW - 1 }))).toBe("RENEW");
    // paidUntil in the future but no live flag: not live *for this name*
    expect(bindDecision(input({ isContainerLive: true, paidUntil: 0 }))).toBe("BIND");
  });

  it("RENEW when a paid record exists but has expired", () => {
    expect(bindDecision(input({ paidUntil: NOW - 1 }))).toBe("RENEW");
    expect(bindDecision(input({ paidUntil: NOW - 31_536_000 }))).toBe("RENEW");
    expect(bindDecision(input({ isLive: true, paidUntil: NOW - 1 }))).toBe("RENEW");
  });

  it("never reports an expired record as ALREADY_LIVE, at any paidUntil", () => {
    for (const offset of [-100, -1, 1, 100]) {
      const decision = bindDecision(input({ isLive: true, isContainerLive: true, paidUntil: NOW + offset }));
      expect(decision, `offset ${String(offset)}`).toBe(offset > 0 ? "ALREADY_LIVE" : "RENEW");
    }
    // paidUntil == now is outside the still-covered window: never ALREADY_LIVE.
    expect(bindDecision(input({ isLive: true, isContainerLive: true, paidUntil: NOW }))).toBe("BIND");
    // never bound at all is a first bind, regardless of the live flags
    expect(bindDecision(input({ isLive: true, isContainerLive: true, paidUntil: 0 }))).toBe("BIND");
  });

  it("rejects non-finite timestamps", () => {
    expect(() => bindDecision(input({ paidUntil: Number.NaN }))).toThrow(/finite/u);
    expect(() => bindDecision(input({ nowSeconds: Number.POSITIVE_INFINITY }))).toThrow(/finite/u);
  });
});

const indexedKey = (input: { readonly type: string; readonly name: string; readonly indexed?: boolean }): string =>
  `${input.type}:${input.name}:${String(input.indexed ?? false)}`;

describe("bindingAbi write surface", () => {
  it("declares bind and syncContainer with the documented signatures", () => {
    expect(selectorOf(WRITE_SIGNATURES.bind)).toBe(toFunctionSelector("bind(string,address,uint256)"));
    expect(selectorOf(WRITE_SIGNATURES.syncContainer)).toBe(
      toFunctionSelector("syncContainer(string,address)"),
    );
    const bind = bindingAbi.find((item) => item.type === "function" && item.name === "bind");
    expect(bind?.stateMutability).toBe("payable");
    expect(bind?.inputs.map((i) => i.type)).toEqual(["string", "address", "uint256"]);
  });

  it("declares the Bound / ContainerPaid / Unbound events", () => {
    const bound = bindingAbi.find((item) => item.type === "event" && item.name === "Bound");
    expect(bound).toEqual(
      expect.objectContaining({
        inputs: expect.arrayContaining([
          expect.objectContaining({ type: "bytes32", name: "domainHash", indexed: true }),
          expect.objectContaining({ type: "string", name: "domain" }),
          expect.objectContaining({ type: "address", name: "container", indexed: true }),
          expect.objectContaining({ type: "uint40", name: "paidUntil" }),
          expect.objectContaining({ type: "uint256", name: "paid" }),
        ]),
      }),
    );
    const containerPaid = bindingAbi.find((item) => item.type === "event" && item.name === "ContainerPaid");
    expect(containerPaid?.inputs.map(indexedKey)).toEqual([
      "address:container:true",
      "uint40:paidUntil:false",
    ]);
    const unbound = bindingAbi.find((item) => item.type === "event" && item.name === "Unbound");
    expect(unbound?.inputs.map(indexedKey)).toEqual([
      "bytes32:domainHash:true",
      "address:container:true",
    ]);
    // the event fragment must be parseable on its own (watchers build it from this ABI)
    expect(() =>
      parseAbiItem("event Bound(bytes32 indexed domainHash, string domain, address indexed container, uint40 paidUntil, uint256 paid)"),
    ).not.toThrow();
  });
});
