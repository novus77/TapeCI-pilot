import { sha256Hex, type Hex } from "@tapeci/shared";

/** Local EVM receipt accounting only; no production/L2 fee or savings attestation. */
export function summarizeForkReceipts(receipts: readonly { hash: Hex; status: "success" | "reverted"; gasUsed: bigint; effectiveGasPrice: bigint }[], expectedTransactions: number, quoteGasPriceWei: bigint) {
  if (!Number.isSafeInteger(expectedTransactions) || expectedTransactions < 0 || receipts.length !== expectedTransactions) throw new Error("Receipt coverage mismatch");
  if (new Set(receipts.map(receipt => receipt.hash.toLowerCase())).size !== receipts.length) throw new Error("Duplicate release receipt");
  if (receipts.some(receipt => receipt.status !== "success")) throw new Error("All release receipts must be successful");
  if (quoteGasPriceWei < 0n || receipts.some(receipt => receipt.gasUsed < 0n || receipt.effectiveGasPrice < 0n)) throw new Error("Negative receipt accounting amount");
  const gasUsed = receipts.reduce((sum, receipt) => sum + receipt.gasUsed, 0n);
  return {
    transactions: receipts.length, gasUsed,
    minedFeeWei: receipts.reduce((sum, receipt) => sum + receipt.gasUsed * receipt.effectiveGasPrice, 0n),
    normalizedCostWei: gasUsed * quoteGasPriceWei, quoteGasPriceWei,
  };
}

export async function verifyMeasuredResponse(response: Response, expected: { bytes: Uint8Array; contentType: string; sha256: Hex; csp: string }): Promise<void> {
  const mime = expected.contentType.split(";")[0]!.trim().toLowerCase();
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const headers = { "content-length": String(expected.bytes.byteLength), "x-tape-sha256": expected.sha256, "x-tape-mode": "server", "x-tape-verified": "1", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-cache", "content-security-policy": expected.csp };
  if (response.status !== 200 || contentType.split(";")[0]!.trim() !== mime || (/^(text\/|application\/(javascript|json|xml))/.test(mime) && !/charset=utf-8/.test(contentType))) throw new Error("Gateway response MIME/status mismatch");
  if (Object.entries(headers).some(([name, value]) => response.headers.get(name) !== value)) throw new Error("Gateway response verification/security header mismatch");
  if (sha256Hex(new Uint8Array(await response.arrayBuffer())) !== expected.sha256 || sha256Hex(expected.bytes) !== expected.sha256) throw new Error("Gateway response byte mismatch");
}
