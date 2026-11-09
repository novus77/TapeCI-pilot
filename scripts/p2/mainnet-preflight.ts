#!/usr/bin/env tsx
/**
 * P2-10 READ-ONLY mainnet preflight. Never signs or sends a transaction.
 *
 *   corepack pnpm preflight:p2 -- --container 0x... --budget-tier A --signer 0x...
 *
 * Without --container it only checks chain identity and RPC agreement.
 * `--out <path>` writes the same JSON report for the authorization packet.
 * Exit code 1 means at least one blocking check failed.
 */
import { formatEther, getAddress, type Address, type Hex } from "viem";
import { XLAYER_MAINNET, oneEndpointPerOperator, resolveRpcEndpoints } from "@tapeci/config";
import { createReadClient, inspectContainer, openerAbi } from "@tapeci/chain";

const BUDGET_TIERS: Record<string, { readonly totalOkb: number; readonly capOkb: number }> = {
  A: { totalOkb: 0.001, capOkb: 0.001 },
  B: { totalOkb: 0.05, capOkb: 0.015 },
  C: { totalOkb: 0.2, capOkb: 0.06 },
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const containerArg = arg("--container");
const outPath = arg("--out");
const signerArg = arg("--signer");
const tier = (arg("--budget-tier") ?? "A").toUpperCase();
const tierConfig = BUDGET_TIERS[tier];
if (tierConfig === undefined) throw new Error(`--budget-tier must be A, B or C (got ${tier})`);

const endpoints = oneEndpointPerOperator(resolveRpcEndpoints());
const reports = [];
for (const endpoint of endpoints) {
  const client = createReadClient(endpoint.url);
  const chainId = await client.getChainId();
  const blockNumber = await client.getBlockNumber();
  const gasPrice = await client.getGasPrice();
  const openerFee = await client.readContract({
    address: XLAYER_MAINNET.opener,
    abi: openerAbi,
    functionName: "FEE",
  });
  const report: Record<string, unknown> = {
    operator: endpoint.operator,
    urlHost: new URL(endpoint.url).host,
    chainId,
    blockNumber: blockNumber.toString(),
    gasPriceWei: gasPrice.toString(),
    openerFeeWei: openerFee.toString(),
    openerFeeOkb: formatEther(openerFee),
  };
  if (containerArg !== undefined) {
    const inspection = await inspectContainer(client, XLAYER_MAINNET, containerArg as Hex, blockNumber);
    // A failed read keeps every unknown as null so the checks below fail closed instead
    // of reading `opened: false` (SPEC §8.6).
    report.container = {
      readStatus: inspection.readStatus,
      observedBlock: inspection.observedBlock === null ? null : inspection.observedBlock.toString(),
      address: inspection.container,
      tokenChainId: inspection.tokenChainId === null ? null : inspection.tokenChainId.toString(),
      processor: inspection.processor,
      tokenId: inspection.tokenId === null ? null : inspection.tokenId.toString(),
      derivedMatches: inspection.derivedMatches,
      isProcessor: inspection.isProcessor,
      owner: inspection.owner,
      deployed: inspection.deployed,
      opened: inspection.opened,
      processorIndex: inspection.processorIndex,
      ...(inspection.readStatus === "unavailable"
        ? { failureStage: inspection.failure.stage, failureMessage: inspection.failure.message }
        : {}),
      ...(inspection.readStatus === "not_found" ? { notFoundReason: inspection.reason } : {}),
    };
  }
  if (signerArg !== undefined) {
    const signer = getAddress(signerArg) as Address;
    const balance = await client.getBalance({ address: signer });
    report.signer = { address: signer, balanceWei: balance.toString(), balanceOkb: formatEther(balance) };
  }
  reports.push(report);
}

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
for (const report of reports) {
  checks.push({
    name: `chainId:${String(report.operator)}`,
    ok: report.chainId === 196,
    detail: `chainId=${String(report.chainId)}`,
  });
}
if (containerArg !== undefined) {
  const inspections = reports.map((report) => report.container as Record<string, unknown> | undefined);
  const first = inspections[0];
  checks.push({
    name: "container.readStatus",
    ok: inspections.every((item) => item?.["readStatus"] === "verified"),
    detail: "every operator must return a verified read, not unavailable/not_found",
  });
  checks.push({
    name: "container.opened",
    ok: inspections.every((item) => item?.["opened"] === true),
    detail: "container must already be opened by its holder",
  });
  checks.push({
    name: "container.owner",
    ok: inspections.every((item) => item?.["owner"] !== null && item?.["owner"] !== undefined),
    detail: "current owner is required for the approval signer",
  });
  checks.push({
    name: "container.derivedMatches",
    ok: inspections.every((item) => item?.["derivedMatches"] === true && item?.["isProcessor"] === true),
    detail: "container must be the canonical factory/opener derivation",
  });
  checks.push({
    name: "rpc.agreement",
    ok: inspections.every((item) => JSON.stringify(item) === JSON.stringify(first)),
    detail: "all RPC operators must agree on owner/opened/processor at the pinned block",
  });
}
const signerReport = reports.find((report) => report.signer !== undefined)?.signer as Record<string, unknown> | undefined;
if (signerReport !== undefined) {
  checks.push({
    name: "signer.balance",
    ok: Number(signerReport["balanceOkb"]) >= tierConfig.capOkb,
    detail: `balance=${String(signerReport["balanceOkb"])} OKB, tier ${tier} cap=${tierConfig.capOkb} OKB`,
  });
}

const blockers = checks.filter((check) => !check.ok);
const output = {
  readOnly: true,
  generatedAt: new Date().toISOString(),
  container: containerArg ?? null,
  budgetTier: { tier, ...tierConfig },
  reports,
  checks,
  blockers,
  note: "Opening fee applies only when creating a new container; deployment gas needs a PLAN_READY artifact. No transaction was signed or sent.",
};
const json = JSON.stringify(output, null, 2);
console.log(json);
if (outPath !== undefined) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(outPath, `${json}\n`, "utf8");
  console.log(`report written: ${outPath}`);
}
if (blockers.length > 0) process.exitCode = 1;
