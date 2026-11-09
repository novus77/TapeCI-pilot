/**
 * Verify a signature produced by a real browser, WalletConnect or hardware wallet.
 *
 * This command is read-only. It never signs, submits an approval, connects to a
 * wallet, or prints signature/key material.
 */
import { pathToFileURL } from "node:url";
import {
  maskAddress,
  readExternalSignatureCase,
  verifyApprovalTypedData,
} from "./harness.js";

export interface VerificationReport {
  readonly walletKind: string;
  readonly chainId: 196;
  readonly expectedSigner: string;
  readonly recoveredSigner: string | null;
  readonly verified: boolean;
  readonly reason: string;
}

async function main(): Promise<void> {
  const external = await readExternalSignatureCase(process.env);
  const result = await verifyApprovalTypedData({
    document: external.document,
    expectedSigner: external.expectedSigner,
    signature: external.signature,
  });
  const report: VerificationReport = {
    walletKind: external.walletKind,
    chainId: result.chainId,
    expectedSigner: maskAddress(result.expectedSigner),
    recoveredSigner:
      result.recoveredAddress === null ? null : maskAddress(result.recoveredAddress),
    verified: result.verified,
    reason: result.reason,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!result.verified) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
