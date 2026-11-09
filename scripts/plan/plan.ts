#!/usr/bin/env tsx
/**
 * `tapeci plan` (P1-05) — read-only release plan: chain diff, chunks, gas, cost,
 * budget cap and signer balance. Never sends a transaction.
 *
 * Usage:
 *   corepack pnpm plan --config .tapeci.json --commit <40-hex> --repository-id <id>
 *   corepack pnpm plan --config .tapeci.json --commit <sha> --repository-id 123 \
 *     --dist dist --cap 50000000000000000 --signer 0x... --out plan.json
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildReleaseManifest } from "@tapeci/artifact";
import { XLAYER_MAINNET, loadTapeCiConfig } from "@tapeci/config";
import { formatOkb, planRelease, planToJson, type ReleasePlan } from "@tapeci/deployer";
import { TapeCiError, toErrorBody } from "@tapeci/shared";
import { scanArtifactDirectory } from "@tapeci/validator";
import { createOperatorClients } from "@tapeci/verifier";

interface CliArgs {
  config?: string;
  dist?: string;
  commit?: string;
  repositoryId?: string;
  cap?: string;
  signer?: string;
  pinnedBlock?: string;
  out?: string;
  json: boolean;
  help: boolean;
}

function parseArgv(argv: readonly string[]): CliArgs {
  const args: CliArgs = { json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === undefined) continue;
    if (raw === "--json") {
      args.json = true;
      continue;
    }
    if (raw === "--help" || raw === "-h") {
      args.help = true;
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(raw);
    if (match === null) throw new Error(`unknown argument: ${raw}`);
    const key = match[1] as string;
    const inline = match[2];
    const value = inline ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    if (inline === undefined) index += 1;
    switch (key) {
      case "config":
        args.config = value;
        break;
      case "dist":
        args.dist = value;
        break;
      case "commit":
        args.commit = value;
        break;
      case "repository-id":
        args.repositoryId = value;
        break;
      case "cap":
        args.cap = value;
        break;
      case "signer":
        args.signer = value;
        break;
      case "pinned-block":
        args.pinnedBlock = value;
        break;
      case "out":
        args.out = value;
        break;
      default:
        throw new Error(`unknown argument: --${key}`);
    }
  }
  return args;
}

function usage(): string {
  return [
    "tapeci plan — read-only release plan (P1-05)",
    "",
    "Usage:",
    "  corepack pnpm plan --config <path> --commit <40-hex> --repository-id <id> [options]",
    "",
    "Required:",
    "  --config <path>        .tapeci.json (P1-02 schema)",
    "  --commit <40-hex>      fixed Git commit SHA being released",
    "  --repository-id <n>    numeric GitHub repository id (manifest field)",
    "",
    "Options:",
    "  --dist <dir>           build output directory (default: config build.outputDir)",
    "  --cap <wei>            approved cost cap in wei (decimal or 0x hex)",
    "  --signer <address>     intended signer; also read from TAPECI_SIGNER",
    "  --pinned-block <n>     reproduce a plan at an exact block",
    "  --out <file>           write the JSON plan to this file",
    "  --json                 print the JSON plan instead of the human summary",
    "  --help                 show this help",
    "",
    "Exit codes: 0 = plan ready, 1 = blocked (conflict/budget/balance), 2 = error.",
    "This command performs only eth_blockNumber/eth_getBlockByNumber/eth_call/eth_getStorageAt/eth_getBalance.",
  ].join("\n");
}

function parseWei(value: string, label: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw new TapeCiError("INVALID_CONFIG", `invalid ${label}: ${value}`);
  }
}

function printSummary(plan: ReleasePlan, budgetCap: bigint | null): void {
  const lines: string[] = [];
  lines.push("TapeCI plan (read-only — no transaction is sent)");
  lines.push(`  target      ${plan.container}${plan.containerOpened ? "" : " (NOT OPENED)"}`);
  lines.push(`  owner       ${plan.containerOwner ?? "unknown"}`);
  lines.push(`  release     ${plan.releaseId}  commit ${plan.commitSha}`);
  lines.push(`  manifest    ${plan.releaseManifestHash}`);
  lines.push(`  pin         block ${plan.pinnedBlockNumber} (${plan.operators.join(" + ")})`);
  lines.push(
    `  files       ${plan.totals.files} (write ${plan.totals.writes}, unchanged ${plan.totals.unchanged}, conflict ${plan.totals.conflicts}), ` +
      `${plan.totals.chunks} chunk(s), ${plan.totals.bytes} byte(s)`,
  );
  lines.push("");
  for (const file of plan.files) {
    lines.push(
      `  ${file.action.padEnd(9)} ${file.path}  [${file.chunks} chunk(s), ${file.size} B, gas ${file.estimatedGas.toString()}]`,
    );
  }
  lines.push("");
  lines.push(
    `  gas         ${plan.fees.estimatedGas.toString()} @ ${plan.fees.gasPriceWei.toString()} wei = ${formatOkb(plan.fees.estimatedCostWei)}`,
  );
  lines.push(
    `  cap         estimate ${formatOkb(plan.fees.estimatedCostWei)}, recommended ${formatOkb(plan.fees.recommendedCapWei)} (+${(plan.fees.marginBps / 100).toFixed(1)}%)`,
  );
  if (budgetCap !== null) {
    lines.push(
      `  budget      ${formatOkb(budgetCap)} approved -> ${plan.fees.withinBudget ? "within budget" : `OVER by ${formatOkb(plan.fees.overBudgetByWei)}`}`,
    );
  } else {
    lines.push("  budget      no cap supplied (the plan is advisory only)");
  }
  if (plan.signer !== null) {
    lines.push(
      `  signer      ${plan.signer} (holder: ${plan.signerIsHolder === true ? "yes" : plan.signerIsHolder === false ? "no — operator authorization required" : "unknown"})`,
    );
    lines.push(
      `  balance     ${plan.signerBalanceWei === null ? "unknown" : formatOkb(plan.signerBalanceWei)} -> ${plan.sufficientBalance === false ? "INSUFFICIENT" : "sufficient"}`,
    );
  }
  lines.push("");
  lines.push(
    plan.blocked
      ? `  status      BLOCKED (${plan.blockedReasons.join(", ")})`
      : "  status      PLAN_READY",
  );
  for (const warning of plan.warnings) lines.push(`  warning     ${warning}`);
  console.log(lines.join("\n"));
}

async function main(): Promise<number> {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.config === undefined || args.commit === undefined || args.repositoryId === undefined) {
    console.error(usage());
    return 2;
  }

  const config = loadTapeCiConfig(resolve(args.config));
  const distDir = resolve(args.dist ?? config.build.outputDir);
  const repositoryId = Number(args.repositoryId);
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new TapeCiError("INVALID_CONFIG", `invalid --repository-id: ${args.repositoryId}`);
  }
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new TapeCiError("INTERNAL", "no registry configured");

  const scan = await scanArtifactDirectory(distDir, {
    entryPath: config.site.entryPath,
    maxFileBytes: config.policy.maxFileBytes,
    strictOnChain: config.policy.strictOnChain,
    ignore: config.policy.ignore,
  });
  const built = buildReleaseManifest({
    chainId: 196,
    siteRegistry: registry,
    container: config.site.container,
    repositoryId,
    commitSha: args.commit,
    entryPath: config.site.entryPath,
    fallbackPath: config.site.fallbackPath,
    pathPrefix: config.release.pathPrefix,
    files: scan.files,
  });

  const signerRaw = args.signer ?? process.env.TAPECI_SIGNER;
  const signer: `0x${string}` | undefined =
    signerRaw === undefined || signerRaw === "" ? undefined : (signerRaw as `0x${string}`);
  const budgetCap = args.cap === undefined ? null : parseWei(args.cap, "--cap");
  const plan = await planRelease({
    manifest: built.manifest,
    files: scan.files.map((file) => ({ sourcePath: file.path, bytes: file.bytes })),
    operators: createOperatorClients(XLAYER_MAINNET),
    ...(signer === undefined ? {} : { signer }),
    ...(budgetCap === null ? {} : { costCapWei: budgetCap }),
    ...(args.pinnedBlock === undefined
      ? {}
      : { pinnedBlockNumber: parseWei(args.pinnedBlock, "--pinned-block") }),
  });

  if (args.out !== undefined) {
    await writeFile(args.out, `${JSON.stringify(planToJson(plan), null, 2)}\n`, "utf8");
  }
  if (args.json) {
    console.log(JSON.stringify(planToJson(plan), null, 2));
  } else {
    printSummary(plan, budgetCap);
  }
  return plan.blocked ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  const body = toErrorBody(error);
  console.error(`tapeci plan: ${body.error.code}: ${body.error.message}`);
  if (error instanceof Error && error.stack !== undefined) console.error(error.stack);
  process.exitCode = 2;
}
