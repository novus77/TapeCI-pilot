#!/usr/bin/env tsx
/**
 * `tapeci verify:release` (P1-07) — verify an executed release against its
 * manifest and journal at one pinned block through two independent operators.
 * Read-only: no transaction is sent.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildReleaseManifest } from "@tapeci/artifact";
import { XLAYER_MAINNET, loadTapeCiConfig } from "@tapeci/config";
import { readJournalState } from "@tapeci/deployer";
import { TapeCiError, toErrorBody } from "@tapeci/shared";
import { scanArtifactDirectory } from "@tapeci/validator";
import {
  createOperatorClients,
  journalEvidenceFromState,
  releaseReportToJson,
  verifyRelease,
  type ReleaseVerificationReport,
} from "@tapeci/verifier";

interface CliArgs {
  config?: string;
  commit?: string;
  repositoryId?: string;
  dist?: string;
  journal?: string;
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
    const value = match[2] ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    if (match[2] === undefined) index += 1;
    switch (key) {
      case "config":
        args.config = value;
        break;
      case "commit":
        args.commit = value;
        break;
      case "repository-id":
        args.repositoryId = value;
        break;
      case "dist":
        args.dist = value;
        break;
      case "journal":
        args.journal = value;
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
    "tapeci verify:release — read-only release verification (P1-07)",
    "",
    "Usage:",
    "  corepack pnpm verify:release --config <path> --commit <40-hex> --repository-id <id> [options]",
    "",
    "Required:",
    "  --config <path>        .tapeci.json",
    "  --commit <40-hex>      Git commit of the release",
    "  --repository-id <n>    numeric GitHub repository id",
    "",
    "Options:",
    "  --dist <dir>           build output directory (default: config build.outputDir)",
    "  --journal <file>       P1-06 deployment journal (enables write/cutover checks)",
    "  --pinned-block <n>     reproduce an earlier verification pin",
    "  --out <file>           write the JSON report",
    "  --json                 print the JSON report",
    "  --help                 show this help",
    "",
    "Exit codes: 0 = release verified, 1 = not verified, 2 = error.",
    "Reads only: eth_blockNumber/eth_getBlockByNumber/eth_call/eth_getStorageAt.",
  ].join("\n");
}

function printReport(report: ReleaseVerificationReport): void {
  const lines: string[] = [];
  lines.push("TapeCI release verification (read-only — no transaction is sent)");
  lines.push(`  container   ${report.container}`);
  lines.push(`  release     ${report.manifest.releaseId}  commit ${report.manifest.commitSha}`);
  lines.push(
    `  pin         block ${report.pin.pinnedBlockNumber ?? "?"} (${report.nodeOperators.join(" + ")})`,
  );
  lines.push(
    `  chain       ${report.status}  registry ${report.registryImplementation ?? "?"}`,
  );
  lines.push(`  release     ${report.releaseStatus}  match=${String(report.releaseMatch)}`);
  const matched = report.files.filter((file) => file.matched).length;
  lines.push(`  files       ${matched}/${report.files.length} matched`);
  if (report.journal !== null) {
    lines.push(
      `  journal     complete=${String(report.journal.complete)} txs=${report.journal.transactionCount} ` +
        `gas=${report.journal.totalGasUsed.toString()} entryLast=${String(report.journal.entryWrittenLast)}`,
    );
  } else {
    lines.push("  journal     (not supplied)");
  }
  lines.push(
    `  finality    safe=${String(report.finality.safeBlockNumber)} finalized=${String(
      report.finality.finalizedBlockNumber,
    )} pinnedSafe=${String(report.finality.pinnedBlockIsSafe)}`,
  );
  for (const warning of report.warnings) lines.push(`  warning     ${warning}`);
  for (const issue of report.journal?.issues ?? []) lines.push(`  issue       ${issue}`);
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
  const repositoryId = Number(args.repositoryId);
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new TapeCiError("INVALID_CONFIG", `invalid --repository-id: ${args.repositoryId}`);
  }
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new TapeCiError("INTERNAL", "no registry configured");

  const scan = await scanArtifactDirectory(resolve(args.dist ?? config.build.outputDir), {
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

  const journalEvidence =
    args.journal === undefined
      ? undefined
      : journalEvidenceFromState(await readJournalState(resolve(args.journal)));

  const report = await verifyRelease({
    manifest: {
      ...built.manifest,
      artifactDigest: built.artifactDigest,
      releaseManifestHash: built.releaseManifestHash,
    },
    ...(journalEvidence === undefined ? {} : { journal: journalEvidence }),
    ...(args.pinnedBlock === undefined
      ? {}
      : { pinnedBlock: BigInt(args.pinnedBlock) }),
    operators: createOperatorClients(XLAYER_MAINNET),
  });

  if (args.out !== undefined) {
    await writeFile(args.out, `${JSON.stringify(releaseReportToJson(report), null, 2)}\n`, "utf8");
  }
  if (args.json) {
    console.log(JSON.stringify(releaseReportToJson(report), null, 2));
  } else {
    printReport(report);
  }
  return report.releaseMatch ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  const body = toErrorBody(error);
  console.error(`tapeci verify:release: ${body.error.code}: ${body.error.message}`);
  process.exitCode = 2;
}
