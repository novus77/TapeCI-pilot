/**
 * Re-verify a wallet acceptance record offline.
 *
 *   pnpm wallet:acceptance:verify -- wallet-acceptance-1234.json
 *
 * The record is produced by /wallet-check (browser) and contains the signature,
 * the connector, the device note and the recovered address. This recomputes the
 * recovery independently with viem, so a manual run becomes reproducible evidence
 * instead of a claim. Read-only; nothing is sent anywhere.
 */
import { readFile } from "node:fs/promises";
import { getAddress, recoverTypedDataAddress, type Hex } from "viem";
import {
  APPROVAL_CHAIN_ID,
  APPROVAL_PRIMARY_TYPE,
  APPROVAL_TYPES,
} from "../../../apps/web/lib/approval-signature.js";

interface AcceptanceRecord {
  readonly kind?: string;
  readonly connector: string;
  readonly address: Hex;
  readonly chainId: number;
  readonly deploymentId: string;
  readonly signature: Hex;
  readonly recovered: Hex;
  readonly matches: boolean;
  readonly deviceNote: string;
  readonly signedAt: string;
}

// `pnpm run x -- file` forwards a literal `--`; take the first real path so both
// `tsx script.ts file` and `pnpm wallet:acceptance:verify -- file` work.
const path = process.argv.slice(2).find((arg) => arg !== "--" && !arg.startsWith("-"));
if (path === undefined) {
  console.error("usage: verify-acceptance.ts <record.json>");
  process.exit(2);
}
const record = JSON.parse(await readFile(path, "utf8")) as AcceptanceRecord;
if (!/^0x[0-9a-fA-F]{130}$/.test(record.signature)) {
  console.error("signature is not a 65-byte hex string");
  process.exit(2);
}

// Recover from the exact payload the page signed; nothing is guessed.
const payload = (record as unknown as {
  readonly payload?: {
    readonly domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
    readonly message: {
      deploymentId: string;
      manifestHash: Hex;
      container: Hex;
      costCapWei: string;
      nonce: string;
      expiresAt: string;
    };
  };
}).payload;
if (payload === undefined) {
  console.error("record has no payload block; re-run the page after updating it");
  process.exit(2);
}
const domain = payload.domain;
const message = {
  deploymentId: payload.message.deploymentId,
  manifestHash: payload.message.manifestHash,
  container: payload.message.container,
  costCapWei: BigInt(payload.message.costCapWei),
  nonce: payload.message.nonce,
  expiresAt: BigInt(payload.message.expiresAt),
} as const;
if (domain.chainId !== APPROVAL_CHAIN_ID) {
  console.error(`payload chainId ${domain.chainId} is not ${APPROVAL_CHAIN_ID}`);
  process.exit(1);
}

const recovered = await recoverTypedDataAddress({
  domain,
  types: APPROVAL_TYPES,
  primaryType: APPROVAL_PRIMARY_TYPE,
  message,
  signature: record.signature,
});
const ok = getAddress(recovered) === getAddress(record.address);
console.log(
  JSON.stringify(
    {
      connector: record.connector,
      deviceNote: record.deviceNote,
      signedAt: record.signedAt,
      chainId: record.chainId,
      address: getAddress(record.address),
      recovered: getAddress(recovered),
      matches: ok,
      verdict: ok ? "PASS" : "FAIL",
    },
    null,
    2,
  ),
);
if (!ok) process.exitCode = 1;
