/**
 * P1-C / SPEC §15.1 — fee display precision (issue P0-09, I04, I05).
 *
 * Two defects are pinned here:
 *
 * 1. `formatGwei` converted through `Number(BigInt(wei))`, so any value above
 *    2^53 was silently rounded (measured: 24 digits).
 * 2. `formatWeiAsOkb` truncated to four decimal places, so every positive
 *    amount below 0.0001 OKB rendered `0.0000 OKB` — a number that reads as
 *    free.
 *
 * The assertions below therefore check three different things: the exact
 * rendered string, a round trip back to wei (which proves nothing was rounded
 * or truncated), and the rule that a positive amount is never zero-shaped.
 * `null` means unknown and must never be rendered as zero.
 */
import { describe, expect, it } from "vitest";

import { UNKNOWN_AMOUNT, formatGwei, formatWeiAsOkb } from "../../apps/web/lib/format.js";

/**
 * Independent of the implementation: parse a rendered `<decimal> <unit>` string
 * back into wei. Returns `null` when the text is not a plain decimal so a
 * failure is a readable assertion rather than a BigInt throw.
 */
function toWei(rendered: string, unit: string, decimals: number): bigint | null {
  const suffix = ` ${unit}`;
  if (!rendered.endsWith(suffix)) return null;
  const decimal = rendered.slice(0, -suffix.length).replace(/,/gu, "");
  const [whole, fraction = ""] = decimal.split(".");
  if (whole === undefined || !/^\d+$/u.test(whole) || !/^\d*$/u.test(fraction)) return null;
  if (fraction.length > decimals) return null;
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
/** 2^53 + 2: the smallest integer a `Number` can no longer represent exactly. */
const ABOVE_SAFE_INTEGER = "9007199254740993";
/** 24 digits, the length at which the old `formatGwei` was measured to corrupt. */
const TWENTY_FOUR_DIGITS = "123456789012345678901234";

const OKB_CASES: readonly { readonly wei: string; readonly expected: string }[] = [
  { wei: "0", expected: "0.0000 OKB" },
  { wei: "1", expected: "0.000000000000000001 OKB" },
  { wei: "99999999999999", expected: "0.000099999999999999 OKB" },
  { wei: "100000000000000", expected: "0.0001 OKB" },
  { wei: ABOVE_SAFE_INTEGER, expected: "0.009007199254740993 OKB" },
  { wei: TWENTY_FOUR_DIGITS, expected: "123,456.789012345678901234 OKB" },
  { wei: "1500000000000000000", expected: "1.5000 OKB" },
];

const GWEI_CASES: readonly { readonly wei: string; readonly expected: string }[] = [
  { wei: "0", expected: "0.00 gwei" },
  { wei: "1", expected: "0.000000001 gwei" },
  { wei: "99999999999999", expected: "99,999.999999999 gwei" },
  { wei: "100000000000000", expected: "100,000.00 gwei" },
  { wei: ABOVE_SAFE_INTEGER, expected: "9,007,199.254740993 gwei" },
  { wei: TWENTY_FOUR_DIGITS, expected: "123,456,789,012,345.678901234 gwei" },
  { wei: "20000001", expected: "0.020000001 gwei" },
];

describe("formatWeiAsOkb", () => {
  it("renders zero as zero, not as unknown", () => {
    expect(formatWeiAsOkb("0")).toBe("0.0000 OKB");
  });

  it("renders 1 wei as a non-zero amount instead of 0.0000 OKB", () => {
    // The old implementation printed "0.0000 OKB" here: a positive amount that
    // reads as free.
    expect(formatWeiAsOkb("1")).toBe("0.000000000000000001 OKB");
  });

  it("renders 99999999999999 wei as a non-zero amount", () => {
    expect(formatWeiAsOkb("99999999999999")).toBe("0.000099999999999999 OKB");
  });

  it("renders the 0.0001 OKB boundary at four decimal places", () => {
    expect(formatWeiAsOkb("100000000000000")).toBe("0.0001 OKB");
  });

  it("keeps every digit above Number.MAX_SAFE_INTEGER", () => {
    expect(formatWeiAsOkb(ABOVE_SAFE_INTEGER)).toBe("0.009007199254740993 OKB");
  });

  it("renders null as unknown, never as zero", () => {
    expect(formatWeiAsOkb(null)).toBe(UNKNOWN_AMOUNT);
    expect(formatWeiAsOkb(null)).not.toContain("0");
    expect(formatWeiAsOkb(null)).not.toContain("OKB");
  });

  it("renders a non-decimal input as unknown instead of guessing", () => {
    for (const value of ["", "1.5", "-1", "1e18", "0x10", " 1"]) {
      expect(formatWeiAsOkb(value), value).toBe(UNKNOWN_AMOUNT);
    }
  });

  it.each(OKB_CASES)("renders $wei wei as $expected", ({ wei, expected }) => {
    expect(formatWeiAsOkb(wei)).toBe(expected);
  });

  it.each(OKB_CASES)("round-trips $wei wei without loss", ({ wei }) => {
    expect(toWei(formatWeiAsOkb(wei), "OKB", 18)).toBe(BigInt(wei));
  });

  it("never renders a positive amount as a zero-shaped number", () => {
    for (const { wei } of OKB_CASES) {
      if (wei === "0") continue;
      expect(formatWeiAsOkb(wei), wei).not.toMatch(/^0(?:\.0+)? OKB$/u);
      expect(formatWeiAsOkb(wei), wei).toMatch(/[1-9]/u);
    }
  });

  it("groups the integer part but never the fraction", () => {
    expect(formatWeiAsOkb("1234567000000000000000000")).toBe("1,234,567.0000 OKB");
  });
});

describe("formatGwei", () => {
  it("renders zero as zero, not as unknown", () => {
    expect(formatGwei("0")).toBe("0.00 gwei");
  });

  it("renders 1 wei of gas price as a non-zero gwei value", () => {
    expect(formatGwei("1")).toBe("0.000000001 gwei");
  });

  it("renders 99999999999999 wei as a non-zero gwei value", () => {
    expect(formatGwei("99999999999999")).toBe("99,999.999999999 gwei");
  });

  it("renders 100000000000000 wei exactly", () => {
    expect(formatGwei("100000000000000")).toBe("100,000.00 gwei");
  });

  it("keeps every digit above Number.MAX_SAFE_INTEGER", () => {
    // `Number(9007199254740993n)` is 9007199254740992 — the last digit is lost.
    expect(formatGwei(ABOVE_SAFE_INTEGER)).toBe("9,007,199.254740993 gwei");
    expect(Number(ABOVE_SAFE_INTEGER)).toBe(Number(MAX_SAFE_INTEGER + 1n));
  });

  it("does not corrupt a 24-digit gas price", () => {
    // The measured defect: `Number(BigInt(wei))` produced
    // "123456789012345.69 gwei", losing the trailing ".678901234".
    expect(formatGwei(TWENTY_FOUR_DIGITS)).toBe("123,456,789,012,345.678901234 gwei");
  });

  it("renders null as unknown, never as zero", () => {
    expect(formatGwei(null)).toBe(UNKNOWN_AMOUNT);
    expect(formatGwei(null)).not.toContain("0");
    expect(formatGwei(null)).not.toContain("gwei");
  });

  it("renders a non-decimal input as unknown instead of guessing", () => {
    for (const value of ["", "0.02", "-1", "1e9", "0x10", " 1"]) {
      expect(formatGwei(value), value).toBe(UNKNOWN_AMOUNT);
    }
  });

  it.each(GWEI_CASES)("renders $wei wei as $expected", ({ wei, expected }) => {
    expect(formatGwei(wei)).toBe(expected);
  });

  it.each(GWEI_CASES)("round-trips $wei wei without loss", ({ wei }) => {
    expect(toWei(formatGwei(wei), "gwei", 9)).toBe(BigInt(wei));
  });

  it("never renders a positive amount as a zero-shaped number", () => {
    for (const { wei } of GWEI_CASES) {
      if (wei === "0") continue;
      expect(formatGwei(wei), wei).not.toMatch(/^0(?:\.0+)? gwei$/u);
      expect(formatGwei(wei), wei).toMatch(/[1-9]/u);
    }
  });

  it("keeps a realistic X Layer gas price exact", () => {
    // 0.020000001 gwei — the observed mainnet price in docs/P2-10_BUDGET.md.
    expect(formatGwei("20000001")).toBe("0.020000001 gwei");
    expect(formatGwei("20000000")).toBe("0.02 gwei");
  });
});
