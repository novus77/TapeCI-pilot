import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OBSERVED_XLAYER_SITE, XLAYER_MAINNET } from "@tapeci/config";
import { toErrorBody } from "@tapeci/shared";
import { verifySite, type VerificationReport } from "@tapeci/verifier";

const DEFAULT_OUT = "docs/evidence/verification-evidence.json";
const DEFAULT_KERNEL_DIR = "/tmp/TapeKit_inspect";

interface CliOptions {
  readonly container: string;
  readonly outPath: string;
  readonly pinnedBlock: string | undefined;
  readonly paths: readonly string[] | undefined;
  readonly kernelDir: string | null;
  readonly siteName: string | null;
  readonly help: boolean;
  readonly rawArgs: readonly string[];
}

interface KernelResolved {
  readonly status: string | null;
  readonly name: string | null;
  readonly container: string | null;
  readonly chainId: number | null;
  readonly pinnedBlockNumber: string | null;
  readonly pinStrategy: string | null;
}

interface KernelRunnerFile {
  readonly path: string;
  readonly status?: string | null;
  readonly size?: number | null;
  readonly sha256?: string | null;
  readonly contentType?: string | null;
}

interface KernelRunnerOutput {
  readonly siteName: string;
  readonly kernelEntry: string;
  readonly resolved: KernelResolved;
  readonly manifestBlockNumber?: string | null;
  readonly files: readonly KernelRunnerFile[];
}

interface KernelFileEvidence {
  readonly path: string;
  readonly status: string | null;
  readonly size: number | null;
  readonly sha256: string | null;
  readonly contentType: string | null;
  readonly matchesReportCheck: boolean | null;
}

interface KernelCrossCheckEvidence {
  readonly status: "ok" | "mismatch" | "error" | "skipped";
  readonly note: string;
  readonly kernelDir: string | null;
  readonly kernelCommit: string | null;
  readonly command: string | null;
  readonly siteName: string | null;
  readonly expectedContainer: string;
  readonly readBlockNumber: string | null;
  readonly resolved: KernelResolved | null;
  readonly files: readonly KernelFileEvidence[];
  readonly containerMatches: boolean | null;
  readonly filesConsistent: boolean | null;
  readonly consistentWithReport: boolean | null;
  readonly error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function defaultKernelDir(): string | null {
  const fromEnv = process.env.TAPECI_TAPEKIT_KERNEL?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return existsSync(DEFAULT_KERNEL_DIR) ? DEFAULT_KERNEL_DIR : null;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let container: string = OBSERVED_XLAYER_SITE.container;
  let outPath = DEFAULT_OUT;
  let pinnedBlock: string | undefined;
  let paths: string[] | undefined;
  let kernelDir: string | null = defaultKernelDir();
  let siteName: string | null = null;
  let siteNameGiven = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        // `pnpm run verify -- --flag` forwards the separator to the script.
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      case "--container":
        container = requireValue(argv, (index += 1), arg);
        break;
      case "--out":
        outPath = requireValue(argv, (index += 1), arg);
        break;
      case "--pinned-block":
        pinnedBlock = requireValue(argv, (index += 1), arg);
        break;
      case "--paths": {
        const raw = requireValue(argv, (index += 1), arg);
        paths = raw
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        break;
      }
      case "--tapekit-kernel":
        kernelDir = requireValue(argv, (index += 1), arg);
        break;
      case "--no-tapekit-kernel":
        kernelDir = null;
        break;
      case "--site-name":
        siteName = requireValue(argv, (index += 1), arg);
        siteNameGiven = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!siteNameGiven && container.toLowerCase() === OBSERVED_XLAYER_SITE.container.toLowerCase()) {
    siteName = OBSERVED_XLAYER_SITE.name;
  }

  return {
    container,
    outPath,
    pinnedBlock,
    paths,
    kernelDir,
    siteName,
    help,
    rawArgs: argv,
  };
}

function usage(): string {
  return [
    "TapeCI P0-06 multi-operator pinned-block verifier (read-only)",
    "",
    "Usage: corepack pnpm verify -- [options]",
    "",
    "  --container <0x...>     container to verify (default: live X Layer site)",
    "  --paths <a,b>           paths to check; discovered from chain when omitted",
    "  --pinned-block <n|0x..> reproduce an earlier report at an exact block",
    "  --out <file>            evidence JSON path (default: docs/evidence/verification-evidence.json)",
    "  --tapekit-kernel <dir>  TapeKit checkout for the reference-kernel cross-check",
    "  --no-tapekit-kernel     skip the TapeKit reference-kernel cross-check",
    "  --site-name <name>      TapeOut name used for the kernel cross-check (default 2.2.0.tape)",
    "",
    "Exit code: 0 = VERIFIED, 1 = report written but not VERIFIED, 2 = error before a report.",
  ].join("\n");
}

function runTapekitKernelCrossCheck(
  kernelDir: string,
  siteName: string,
  report: VerificationReport,
): KernelCrossCheckEvidence {
  const runnerPath = fileURLToPath(new URL("./tapekit-kernel-crosscheck.mjs", import.meta.url));
  const command = `node ${relative(process.cwd(), runnerPath)} ${kernelDir} ${siteName}`;
  const base = {
    kernelDir,
    kernelCommit: null as string | null,
    command,
    siteName,
    expectedContainer: report.container,
    readBlockNumber: null as string | null,
    resolved: null as KernelResolved | null,
    files: [] as readonly KernelFileEvidence[],
    containerMatches: null as boolean | null,
    filesConsistent: null as boolean | null,
    consistentWithReport: null as boolean | null,
    error: null as string | null,
  };

  if (!existsSync(resolve(kernelDir, "kernel", "src", "index.js"))) {
    return {
      status: "skipped",
      note: `TapeKit kernel entry not found under ${kernelDir}; cross-check skipped`,
      ...base,
    };
  }
  try {
    base.kernelCommit = execFileSync("git", ["-C", kernelDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  } catch {
    base.kernelCommit = null;
  }

  try {
    const stdout = execFileSync(process.execPath, [runnerPath, kernelDir, siteName], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
      env: process.env,
    });
    const parsed = JSON.parse(stdout) as KernelRunnerOutput;
    const reportChecks = new Map(report.checks.map((check) => [check.path.toLowerCase(), check]));
    const files: KernelFileEvidence[] = parsed.files.map((file) => {
      const check = reportChecks.get(file.path.toLowerCase()) ?? null;
      const sha256 = file.sha256 ?? null;
      const size = file.size ?? null;
      const matches =
        check !== null &&
        sha256 !== null &&
        size !== null &&
        check.expectedSha256.toLowerCase() === sha256.toLowerCase() &&
        check.expectedSize === size;
      return {
        path: file.path,
        status: file.status ?? null,
        size,
        sha256,
        contentType: file.contentType ?? null,
        matchesReportCheck: matches,
      };
    });
    const containerMatches =
      parsed.resolved.container !== null &&
      parsed.resolved.container.toLowerCase() === report.container.toLowerCase();
    const filesConsistent =
      files.length === report.checks.length &&
      files.every((file) => file.status === "ok" && file.matchesReportCheck === true);
    const consistent =
      parsed.resolved.status === "ok" && containerMatches && filesConsistent;
    return {
      status: consistent ? "ok" : "mismatch",
      note: consistent
        ? "TapeKit reference kernel independently resolved the same container and file hashes; its own pin may differ from this report's pin because it ran later."
        : "TapeKit reference kernel did not confirm this report (see resolved/files)",
      ...base,
      readBlockNumber: parsed.manifestBlockNumber ?? parsed.resolved.pinnedBlockNumber,
      resolved: parsed.resolved,
      files,
      containerMatches,
      filesConsistent,
      consistentWithReport: consistent,
    };
  } catch (error) {
    return {
      status: "error",
      note: "TapeKit reference-kernel cross-check failed",
      ...base,
      error: errorMessage(error),
    };
  }
}

function buildEvidence(
  report: VerificationReport,
  crossCheck: KernelCrossCheckEvidence,
  options: CliOptions,
): Record<string, unknown> {
  return {
    ...report,
    evidenceMeta: {
      schema: "tapeci.verification-evidence.v1",
      generator: "scripts/verify/verify.ts",
      generatedAt: new Date().toISOString(),
      command: `corepack pnpm verify${options.rawArgs.length > 0 ? ` -- ${options.rawArgs.join(" ")}` : ""}`,
      requestedContainer: options.container,
      requestedPinnedBlock: options.pinnedBlock ?? null,
      config: {
        chainId: XLAYER_MAINNET.chainId,
        name: XLAYER_MAINNET.name,
        factory: XLAYER_MAINNET.factory,
        opener: XLAYER_MAINNET.opener,
        registry: XLAYER_MAINNET.registries[0] ?? null,
        binding: XLAYER_MAINNET.binding,
        pinOffset: XLAYER_MAINNET.pin.offset,
        maxLagBlocks: XLAYER_MAINNET.pin.maxLagBlocks,
        maxBlockAgeSeconds: XLAYER_MAINNET.pin.maxBlockAgeSeconds,
      },
      notes: [
        "Read-only verification: no chain writes, no secrets.",
        "Every read in this report is bound to one pinned block.",
        "Pin = second-highest operator head minus 2 (TapeKit SPEC §4.2); one vote per independent operator.",
        "Any operator disagreement is rejection, never a majority vote.",
        "TapeKit reference-kernel cross-check is additional independent evidence, not a replacement for the two-operator byte comparison.",
        "VERIFIED is a statement about one pinned block; it is not an L2 finality guarantee.",
      ],
    },
    tapekitKernelCrossCheck: crossCheck,
  };
}

function printSummary(
  report: VerificationReport,
  evidencePath: string,
  crossCheck: KernelCrossCheckEvidence,
): void {
  const lines: string[] = [];
  lines.push("TapeCI P0-06 multi-operator pinned-block verification (read-only)");
  lines.push(`  container:      ${report.container}`);
  lines.push(`  registry:       ${report.registry}`);
  for (const head of report.pin.heads) {
    lines.push(`  operator:       ${head.operator} ${head.url} head=${head.head ?? "?"}`);
  }
  lines.push(`  pin:            ${report.pin.formula}`);
  lines.push(
    `  pinned block:   ${report.pinnedBlockNumber ?? "unavailable"} hash=${report.pin.pinnedBlockHash ?? "?"} timestamp=${report.pin.pinnedBlockTimestamp ?? "?"}`,
  );
  lines.push(
    `  implementations: siteRegistry=${report.registryImplementation ?? "?"} domainBinding=${report.bindingImplementation ?? "?"}`,
  );
  lines.push(`  fallbackPath:   ${report.fallbackPath || "(none)"}`);
  lines.push(`  files:          ${report.checks.length}`);
  for (const check of report.checks) {
    lines.push(
      `    ${check.path} matched=${check.matched} expectedSha256=${check.expectedSha256} actualSha256=${check.actualSha256} expectedSize=${check.expectedSize} actualSize=${check.actualSize}`,
    );
  }
  lines.push(`  kernel cross-check: ${crossCheck.status}${crossCheck.kernelCommit === null ? "" : ` @ ${crossCheck.kernelCommit}`}`);
  if (crossCheck.readBlockNumber !== null) {
    lines.push(`    kernel read block: ${crossCheck.readBlockNumber}`);
  }
  lines.push(`  status:         ${report.status}`);
  if (report.detail !== undefined) lines.push(`  detail:         ${report.detail}`);
  lines.push(`  evidence:       ${evidencePath}`);
  console.log(lines.join("\n"));
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${errorMessage(error)}`);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  let report: VerificationReport;
  try {
    report = await verifySite({
      container: options.container,
      ...(options.paths === undefined ? {} : { paths: options.paths }),
      ...(options.pinnedBlock === undefined ? {} : { pinnedBlock: options.pinnedBlock }),
    });
  } catch (error) {
    console.error(JSON.stringify(toErrorBody(error), null, 2));
    return 2;
  }

  let crossCheck: KernelCrossCheckEvidence;
  if (options.kernelDir === null || options.siteName === null) {
    crossCheck = {
      status: "skipped",
      note:
        options.kernelDir === null
          ? "TapeKit reference-kernel cross-check disabled"
          : "no TapeOut site name for this container; kernel cross-check skipped",
      kernelDir: options.kernelDir,
      kernelCommit: null,
      command: null,
      siteName: options.siteName,
      expectedContainer: report.container,
      readBlockNumber: null,
      resolved: null,
      files: [],
      containerMatches: null,
      filesConsistent: null,
      consistentWithReport: null,
      error: null,
    };
  } else {
    crossCheck = runTapekitKernelCrossCheck(options.kernelDir, options.siteName, report);
  }

  const evidencePath = resolve(process.cwd(), options.outPath);
  mkdirSync(dirname(evidencePath), { recursive: true });
  const evidence = buildEvidence(report, crossCheck, options);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

  printSummary(report, evidencePath, crossCheck);
  return report.status === "VERIFIED" ? 0 : 1;
}

process.exitCode = await main();
