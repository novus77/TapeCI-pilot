import { expect, it } from "vitest";
import { verifyMeasuredResponse, summarizeForkReceipts } from "../../scripts/compression/measurement.js";

const receipt = { hash: `0x${"ab".repeat(32)}` as const, status: "success" as const, gasUsed: 10n, effectiveGasPrice: 7n };
it("separates actual mined fee totals from common-price gas comparisons", () => {
  expect(summarizeForkReceipts([receipt, { ...receipt, hash: `0x${"cd".repeat(32)}`, gasUsed: 20n, effectiveGasPrice: 9n }], 2, 5n)).toEqual({ transactions: 2, gasUsed: 30n, minedFeeWei: 250n, normalizedCostWei: 150n, quoteGasPriceWei: 5n });
});
it("refuses incomplete, duplicate, reverted or invalid accounting inputs", () => {
  expect(() => summarizeForkReceipts([receipt], 2, 5n)).toThrow(/coverage/);
  expect(() => summarizeForkReceipts([receipt, receipt], 2, 5n)).toThrow(/duplicate/i);
  expect(() => summarizeForkReceipts([{ ...receipt, status: "reverted" }], 1, 5n)).toThrow(/success/);
  expect(() => summarizeForkReceipts([{ ...receipt, gasUsed: -1n }], 1, 5n)).toThrow(/negative/i);
  expect(() => summarizeForkReceipts([receipt], 1, -1n)).toThrow(/negative/i);
});

it("rejects incorrect MIME, digest and security headers even when response bytes match", async () => {
  const bytes = new TextEncoder().encode("hello");
  const expected = { bytes, contentType: "text/html", sha256: "0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" as const, csp: "default-src 'self'" };
  const headers = { "content-type": "text/html; charset=utf-8", "content-length": "5", "x-tape-sha256": expected.sha256, "x-tape-mode": "server", "x-tape-verified": "1", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-cache", "content-security-policy": expected.csp };
  await expect(verifyMeasuredResponse(new Response(bytes, { headers }), expected)).resolves.toBeUndefined();
  for (const [name, value] of [["content-type", "application/octet-stream"], ["x-tape-sha256", `0x${"00".repeat(32)}`], ["cache-control", "public"], ["x-content-type-options", ""], ["referrer-policy", ""], ["content-length", "1"]]) {
    await expect(verifyMeasuredResponse(new Response(bytes, { headers: { ...headers, [name!]: value! } }), expected)).rejects.toThrow();
  }
});
