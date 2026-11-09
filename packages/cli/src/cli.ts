#!/usr/bin/env tsx
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { XLAYER_MAINNET, createTapeCiConfig } from "@tapeci/config";
import {
  deriveDeploymentId,
  executeRelease,
  formatOkb,
  planRelease,
  planToJson,
  DeploymentJournal,
  maxMinedBlock,
  readJournalState,
  reverifyMissingFiles,
  type PlanFileBytes,
  type ReleasePlan,
} from "@tapeci/deployer";
import {
  ReleaseStore,
  prepareVersionedRelease,
  rollbackToStoredRelease,
  type PreparedRelease,
} from "@tapeci/release";
import { TapeCiError, toErrorBody, type Hex } from "@tapeci/shared";
import { scanArtifactDirectory, type ScanResult } from "@tapeci/validator";
import {
  journalEvidenceFromState,
  releaseReportToJson,
  verifyRelease,
  type ReleaseVerificationReport,
} from "@tapeci/verifier";
import { flagBool, flagString, parseArgs, requireFlag, type ParsedArgs } from "./args.js";
import { loadProject, type Project } from "./project.js";
import { latestPin, pinAtLeast, readRuntime, signerRuntime } from "./runtime.js";

const execFileAsync = promisify(execFile);

const USAGE = `TapeCI — Git push → verifiable DeWEB on X Layer

Usage: tapeci <command> [options]

Commands:
  init        write a .tapeci.json (requires --container)
  build       run install/build commands, then scan the output
  validate    scan the build output against the on-chain policy (offline)
  plan        read-only release plan: chain diff, chunks, gas, cost, budget
  deploy      execute a plan (journaled), store the release and verify it
  verify      verify a release against its manifest and journal
  rollback    switch the entry back to a stored release (single transaction)
  releases    list stored releases

Common options:
  --config <path>       .tapeci.json (default ./.tapeci.json)
  --dist <dir>          build output directory (default config build.outputDir)
  --commit <40-hex>     fixed Git commit being released
  --repository-id <n>   numeric GitHub repository id
  --json                machine-readable output (plan/verify)
  --help                command help

Write options:
  --cap <wei>           approved cost cap (required for deploy)
  --yes                 confirm deploy after reviewing the plan
  --fork-url <url>      local Anvil fork; use with --signer <address> (impersonation)
  --signer <0x...>      signer address for the fork; ignored on mainnet
  --journal <file>      journal path (deploy default: .tapeci/journal/<id>.jsonl)
  --journal-dir <dir>   directory for journals
  --repair-journal      verify: re-read files missing file_verified on every operator
                        (pinned >= last mined write) and append real evidence; read-only on chain
  --store <dir>         release store (default: .tapeci/releases)
  --report-out <file>   write the verification report JSON

Mainnet signing uses TAPECI_PRIVATE_KEY in the environment. Never commit it.
Exit codes: 0 success, 1 blocked/not verified, 2 invalid input or error.
`;

interface PreparedProject {
  readonly scan: ScanResult;
  readonly prepared: PreparedRelease;
}

function requireCommit(parsed: ParsedArgs): string {
  const commit = requireFlag(parsed, "commit");
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new TapeCiError("INVALID_CONFIG", "--commit must be a 40-character lowercase hex SHA");
  }
  return commit;
}

function requireRepositoryId(parsed: ParsedArgs): number {
  const raw = requireFlag(parsed, "repository-id");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TapeCiError("INVALID_CONFIG", "--repository-id must be a positive integer");
  }
  return value;
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

async function prepareProject(project: Project, parsed: ParsedArgs): Promise<PreparedProject> {
  const commitSha = requireCommit(parsed);
  const repositoryId = requireRepositoryId(parsed);
  const registry = XLAYER_MAINNET.registries[0];
  if (registry === undefined) throw new TapeCiError("INTERNAL", "no registry configured");
  const scan = await scanArtifactDirectory(project.distDir, {
    entryPath: project.config.site.entryPath,
    maxFileBytes: project.config.policy.maxFileBytes,
    strictOnChain: project.config.policy.strictOnChain,
    ignore: project.config.policy.ignore,
  });
  const prepared = prepareVersionedRelease({
    files: scan.files,
    chainId: 196,
    siteRegistry: registry,
    container: project.config.site.container,
    repositoryId,
    commitSha,
    entryPath: project.config.site.entryPath,
    fallbackPath: project.config.site.fallbackPath,
    pathPrefix: project.config.release.pathPrefix,
  });
  return { scan, prepared };
}

function planFiles(project: PreparedProject): PlanFileBytes[] {
  return project.scan.files.map((file) => ({
    sourcePath: file.path,
    bytes:
      file.path === project.prepared.manifest.entryPath
        ? project.prepared.entryBytes
        : file.bytes,
  }));
}

function printPlan(plan: ReleasePlan, cap: bigint | null): void {
  const lines: string[] = [];
  lines.push("TapeCI plan (read-only — no transaction is sent)");
  lines.push(`  container   ${plan.container}${plan.containerOpened ? "" : " (NOT OPENED)"}`);
  lines.push(`  owner       ${plan.containerOwner ?? "unknown"}`);
  lines.push(`  release     ${plan.releaseId}  commit ${plan.commitSha}`);
  lines.push(`  manifest    ${plan.releaseManifestHash}`);
  lines.push(`  pin         block ${plan.pinnedBlockNumber} (${plan.operators.join(" + ")})`);
  lines.push(
    `  files       ${plan.totals.files} (write ${plan.totals.writes}, unchanged ${plan.totals.unchanged}, conflict ${plan.totals.conflicts}), ` +
      `${plan.totals.chunks} chunk(s), ${plan.totals.bytes} byte(s)`,
  );
  lines.push(
    `  gas         ${plan.fees.estimatedGas.toString()} @ ${plan.fees.gasPriceWei.toString()} wei = ${formatOkb(plan.fees.estimatedCostWei)}`,
  );
  lines.push(
    `  cap         estimate ${formatOkb(plan.fees.estimatedCostWei)}, recommended ${formatOkb(plan.fees.recommendedCapWei)} (+${(plan.fees.marginBps / 100).toFixed(1)}%)`,
  );
  lines.push(
    cap === null
      ? "  budget      no cap supplied (advisory only)"
      : `  budget      ${formatOkb(cap)} approved -> ${plan.fees.withinBudget ? "within budget" : `OVER by ${formatOkb(plan.fees.overBudgetByWei)}`}`,
  );
  if (plan.signer !== null) {
    lines.push(
      `  signer      ${plan.signer} (holder: ${plan.signerIsHolder === true ? "yes" : plan.signerIsHolder === false ? "no — operator authorization required" : "unknown"})`,
    );
    lines.push(
      `  balance     ${plan.signerBalanceWei === null ? "unknown" : formatOkb(plan.signerBalanceWei)} -> ${plan.sufficientBalance === false ? "INSUFFICIENT" : "sufficient"}`,
    );
  }
  lines.push(
    plan.blocked ? `  status      BLOCKED (${plan.blockedReasons.join(", ")})` : "  status      PLAN_READY",
  );
  for (const warning of plan.warnings) lines.push(`  warning     ${warning}`);
  console.log(lines.join("\n"));
}

function printVerification(report: ReleaseVerificationReport): void {
  const lines: string[] = [];
  lines.push("TapeCI release verification (read-only — no transaction is sent)");
  lines.push(`  container   ${report.container}`);
  lines.push(`  release     ${report.manifest.releaseId}  commit ${report.manifest.commitSha}`);
  lines.push(
    `  pin         block ${report.pin.pinnedBlockNumber ?? "?"} (${report.nodeOperators.join(" + ")})`,
  );
  lines.push(`  chain       ${report.status}  release ${report.releaseStatus}`);
  lines.push(`  files       ${report.files.filter((file) => file.matched).length}/${report.files.length} matched`);
  if (report.journal !== null) {
    lines.push(
      `  journal     complete=${String(report.journal.complete)} txs=${report.journal.transactionCount} ` +
        `gas=${report.journal.totalGasUsed.toString()} entryLast=${String(report.journal.entryWrittenLast)}`,
    );
  }
  for (const warning of report.warnings) lines.push(`  warning     ${warning}`);
  for (const issue of report.journal?.issues ?? []) lines.push(`  issue       ${issue}`);
  console.log(lines.join("\n"));
}

function artifactFiles(scan: ScanResult): void {
  console.log(`artifact: ${scan.files.length} file(s), ${scan.totalBytes} byte(s), fullyOnChain=${String(scan.fullyOnChain)}`);
  for (const file of scan.files) {
    console.log(`  ${file.path}  ${file.size} B  ${file.sha256.slice(0, 10)}…  ${file.contentType}`);
  }
  for (const reference of scan.externalReferences) {
    console.log(`  external ref: ${reference.filePath} ${reference.url}`);
  }
}

async function runCommand(command: string, cwd: string, timeoutMs: number): Promise<void> {
  console.log(`$ ${command}  (cwd ${cwd})`);
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new TapeCiError("BUILD_FAILED", `command timed out after ${timeoutMs} ms: ${command}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(new TapeCiError("BUILD_FAILED", `command failed to start: ${command}`, { cause: error }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else rejectRun(new TapeCiError("BUILD_FAILED", `command exited with ${String(code)}: ${command}`));
    });
  });
}

async function gitHead(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
    return stdout.trim();
  } catch (error) {
    throw new TapeCiError("BUILD_FAILED", "cannot read git HEAD; use --no-commit-check to skip", {
      cause: error,
    });
  }
}

async function cmdInit(parsed: ParsedArgs): Promise<number> {
  const configPath = resolve(flagString(parsed, "config") ?? ".tapeci.json");
  if (existsSync(configPath) && !flagBool(parsed, "force")) {
    throw new TapeCiError("INVALID_CONFIG", `${configPath} already exists (use --force to overwrite)`);
  }
  const container = requireFlag(parsed, "container");
  const config = createTapeCiConfig({ container });
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`wrote ${configPath}`);
  console.log("next: set build.installCommand/buildCommand/outputDir, then `tapeci validate`.");
  return 0;
}

async function cmdBuild(parsed: ParsedArgs): Promise<number> {
  const project = loadProject(parsed);
  if (!flagBool(parsed, "no-commit-check")) {
    const head = await gitHead(project.root);
    const expected = flagString(parsed, "commit");
    if (expected !== undefined && expected !== head) {
      throw new TapeCiError("BUILD_FAILED", `HEAD ${head} does not match --commit ${expected}`);
    }
    console.log(`git HEAD ${head}`);
  }
  const timeoutMs = project.config.build.timeoutSeconds * 1_000;
  if (!flagBool(parsed, "no-install")) {
    await runCommand(project.config.build.installCommand, project.root, timeoutMs);
  }
  await runCommand(project.config.build.buildCommand, project.root, timeoutMs);
  const scan = await scanArtifactDirectory(project.distDir, {
    entryPath: project.config.site.entryPath,
    maxFileBytes: project.config.policy.maxFileBytes,
    strictOnChain: project.config.policy.strictOnChain,
    ignore: project.config.policy.ignore,
  });
  artifactFiles(scan);
  return 0;
}

async function cmdValidate(parsed: ParsedArgs): Promise<number> {
  const project = loadProject(parsed);
  const scan = await scanArtifactDirectory(project.distDir, {
    entryPath: project.config.site.entryPath,
    maxFileBytes: project.config.policy.maxFileBytes,
    strictOnChain: project.config.policy.strictOnChain,
    ignore: project.config.policy.ignore,
  });
  artifactFiles(scan);
  return 0;
}

async function cmdPlan(parsed: ParsedArgs): Promise<number> {
  const project = loadProject(parsed);
  const prepared = await prepareProject(project, parsed);
  const runtime = readRuntime(parsed);
  const pinnedBlockNumber = await latestPin(runtime);
  const signer = flagString(parsed, "signer");
  const cap = flagString(parsed, "cap");
  const plan = await planRelease({
    manifest: prepared.prepared.manifest,
    files: planFiles(prepared),
    operators: runtime.operators,
    pinnedBlockNumber,
    ...(signer === undefined ? {} : { signer: signer as Hex }),
    ...(cap === undefined ? {} : { costCapWei: parseWei(cap, "--cap") }),
  });
  if (flagString(parsed, "out") !== undefined) {
    await writeFile(
      resolve(flagString(parsed, "out") as string),
      `${JSON.stringify(planToJson(plan), null, 2)}\n`,
      "utf8",
    );
  }
  if (flagBool(parsed, "json")) console.log(JSON.stringify(planToJson(plan), null, 2));
  else printPlan(plan, cap === undefined ? null : parseWei(cap, "--cap"));
  return plan.blocked ? 1 : 0;
}

async function cmdDeploy(parsed: ParsedArgs): Promise<number> {
  if (!flagBool(parsed, "yes")) {
    throw new TapeCiError("INVALID_CONFIG", "deploy requires --yes after reviewing `tapeci plan`");
  }
  const cap = parseWei(requireFlag(parsed, "cap"), "--cap");
  const project = loadProject(parsed);
  const prepared = await prepareProject(project, parsed);
  const runtime = readRuntime(parsed);
  const signer = signerRuntime(parsed);
  const pinnedBlockNumber = await latestPin(runtime);
  const plan = await planRelease({
    manifest: prepared.prepared.manifest,
    files: planFiles(prepared),
    operators: runtime.operators,
    signer: signer.signer,
    costCapWei: cap,
    pinnedBlockNumber,
  });
  printPlan(plan, cap);
  if (plan.blocked) return 1;

  const journalDir = resolve(
    flagString(parsed, "journal-dir") ?? join(project.root, ".tapeci", "journal"),
  );
  await mkdir(journalDir, { recursive: true });
  const journalPath = resolve(
    flagString(parsed, "journal") ??
      join(journalDir, `${deriveDeploymentId(plan)}.jsonl`),
  );
  const execution = await executeRelease({
    plan,
    manifest: prepared.prepared.manifest,
    files: planFiles(prepared),
    client: runtime.readClient,
    wallet: signer.wallet,
    config: XLAYER_MAINNET,
    journalPath,
    signer: signer.signer,
  });
  console.log(
    `executed: ${execution.newTransactions} new transaction(s); journal ${journalPath}`,
  );

  const storeDir = resolve(flagString(parsed, "store") ?? join(project.root, ".tapeci", "releases"));
  const store = new ReleaseStore(storeDir);
  await store.save({
    manifest: prepared.prepared.manifest,
    artifactDigest: prepared.prepared.artifactDigest,
    releaseManifestHash: prepared.prepared.releaseManifestHash,
    entryBytes: prepared.prepared.entryBytes,
  });
  console.log(`stored release ${prepared.prepared.releaseId} in ${storeDir}`);

  const journalState = await readJournalState(journalPath);
  const verifyPin = await pinAtLeast(runtime, maxMinedBlock(journalState));
  const report = await verifyRelease({
    manifest: {
      ...prepared.prepared.manifest,
      artifactDigest: prepared.prepared.artifactDigest,
      releaseManifestHash: prepared.prepared.releaseManifestHash,
    },
    journal: journalEvidenceFromState(journalState),
    pinnedBlock: verifyPin,
    operators: runtime.operators,
    allowSingleOperator: runtime.allowSingleOperator,
  });
  printVerification(report);
  const reportOut = flagString(parsed, "report-out");
  if (reportOut !== undefined) {
    await writeFile(resolve(reportOut), `${JSON.stringify(releaseReportToJson(report), null, 2)}\n`, "utf8");
  }
  return report.releaseMatch ? 0 : 1;
}

/**
 * Read-only journal repair: for manifest files without file_verified, read them on
 * every operator at a pin >= the last mined write and append `recovered` evidence
 * only when all reads match. Sends no transactions and needs no key.
 */
async function repairJournal(
  journalPath: string,
  manifest: Parameters<typeof reverifyMissingFiles>[0]["manifest"],
  releaseManifestHash: Hex,
  runtime: ReturnType<typeof readRuntime>,
): Promise<void> {
  if (!existsSync(journalPath)) throw new TapeCiError("INVALID_CONFIG", `journal not found: ${journalPath}`);
  const journal = await DeploymentJournal.open(journalPath);
  try {
    const plan = journal.state.plan;
    if (plan === null || plan.releaseManifestHash.toLowerCase() !== releaseManifestHash.toLowerCase()) {
      throw new TapeCiError("PLAN_STALE", "journal belongs to a different release manifest; refusing to repair it");
    }
    if (!journal.state.complete) {
      throw new TapeCiError(
        "UPLOAD_INTERRUPTED",
        "journal is not complete; resume it with `tapeci deploy` instead of repairing",
      );
    }
    const registry = XLAYER_MAINNET.registries[0];
    if (registry === undefined) throw new TapeCiError("INTERNAL", "no registry configured");
    const result = await reverifyMissingFiles({
      journal,
      manifest,
      registry,
      readers: runtime.operators.map((operator) => ({ client: operator.client, label: operator.operator })),
      recovered: true,
    });
    if (result.verified.length === 0) console.log("repair-journal: nothing to repair");
    for (const file of result.verified) {
      console.log(`repair-journal: ${file.path} verified at block ${String(result.pin)} (${file.status})`);
    }
  } finally {
    await journal.close();
  }
}

async function cmdVerify(parsed: ParsedArgs): Promise<number> {
  const project = loadProject(parsed);
  const prepared = await prepareProject(project, parsed);
  const runtime = readRuntime(parsed);
  const journal = flagString(parsed, "journal");
  if (flagBool(parsed, "repair-journal")) {
    if (journal === undefined) throw new TapeCiError("INVALID_CONFIG", "--repair-journal requires --journal <file>");
    await repairJournal(resolve(journal), prepared.prepared.manifest, prepared.prepared.releaseManifestHash, runtime);
  }
  const journalState = journal === undefined ? undefined : await readJournalState(resolve(journal));
  const journalEvidence = journalState === undefined ? undefined : journalEvidenceFromState(journalState);
  const pinnedBlockNumber =
    journalState === undefined ? await latestPin(runtime) : await pinAtLeast(runtime, maxMinedBlock(journalState));
  const report = await verifyRelease({
    manifest: {
      ...prepared.prepared.manifest,
      artifactDigest: prepared.prepared.artifactDigest,
      releaseManifestHash: prepared.prepared.releaseManifestHash,
    },
    ...(journalEvidence === undefined ? {} : { journal: journalEvidence }),
    pinnedBlock: pinnedBlockNumber,
    operators: runtime.operators,
    allowSingleOperator: runtime.allowSingleOperator,
  });
  if (flagBool(parsed, "json")) console.log(JSON.stringify(releaseReportToJson(report), null, 2));
  else printVerification(report);
  const out = flagString(parsed, "out");
  if (out !== undefined) {
    await writeFile(resolve(out), `${JSON.stringify(releaseReportToJson(report), null, 2)}\n`, "utf8");
  }
  return report.releaseMatch ? 0 : 1;
}

async function cmdRollback(parsed: ParsedArgs): Promise<number> {
  const releaseId = flagString(parsed, "release") ?? parsed.positionals[0];
  if (releaseId === undefined) {
    throw new TapeCiError("INVALID_CONFIG", "rollback requires --release <id> or a positional release id");
  }
  const project = loadProject(parsed);
  const runtime = readRuntime(parsed);
  const signer = signerRuntime(parsed);
  const storeDir = resolve(flagString(parsed, "store") ?? join(project.root, ".tapeci", "releases"));
  const pinnedBlockNumber = await latestPin(runtime);
  const result = await rollbackToStoredRelease({
    store: new ReleaseStore(storeDir),
    releaseId,
    client: runtime.readClient,
    wallet: signer.wallet,
    config: XLAYER_MAINNET,
    operators: runtime.operators,
    pinnedBlock: pinnedBlockNumber,
    ...(runtime.allowSingleOperator ? { allowSingleOperator: true } : {}),
  });
  console.log(
    `rollback ${result.releaseId}: entry ${result.entrySha256} (previous ${result.previousEntrySha256 ?? "none"}), ` +
      `tx ${result.transactionHashes.join(", ") || "none"}`,
  );
  return 0;
}

async function cmdReleases(parsed: ParsedArgs): Promise<number> {
  const project = loadProject(parsed);
  const storeDir = resolve(flagString(parsed, "store") ?? join(project.root, ".tapeci", "releases"));
  const releases = await new ReleaseStore(storeDir).list();
  if (releases.length === 0) {
    console.log(`no stored releases in ${storeDir}`);
    return 0;
  }
  for (const release of releases) {
    console.log(`${release.releaseId}  ${release.commitSha.slice(0, 12)}  ${release.fileCount} file(s)`);
  }
  return 0;
}

function commandHelp(command: string): string {
  return `tapeci ${command} — see \`tapeci --help\` for common options.`;
}

/** Run one CLI invocation; returns the process exit code (no process.exit here). */
export async function runCli(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (parsed.command === null) {
    console.log(USAGE);
    return 0;
  }
  if (flagBool(parsed, "help")) {
    console.log(commandHelp(parsed.command));
    return 0;
  }
  try {
    switch (parsed.command) {
      case "init":
        return await cmdInit(parsed);
      case "build":
        return await cmdBuild(parsed);
      case "validate":
        return await cmdValidate(parsed);
      case "plan":
        return await cmdPlan(parsed);
      case "deploy":
        return await cmdDeploy(parsed);
      case "verify":
        return await cmdVerify(parsed);
      case "rollback":
        return await cmdRollback(parsed);
      case "releases":
        return await cmdReleases(parsed);
      default:
        console.error(`unknown command: ${parsed.command}\n`);
        console.log(USAGE);
        return 2;
    }
  } catch (error) {
    const body = toErrorBody(error);
    console.error(`tapeci ${parsed.command}: ${body.error.code}: ${body.error.message}`);
    if (error instanceof TapeCiError) {
      const blocked = new Set([
        "BUILD_FAILED",
        "UPLOAD_INTERRUPTED",
        "UPLOAD_CONFLICT",
        "VERIFICATION_FAILED",
        "SWITCH_FAILED",
        "FEE_OVER_BUDGET",
        "INSUFFICIENT_BALANCE",
        "PLAN_STALE",
      ]);
      if (blocked.has(error.code)) return 1;
    }
    return 2;
  }
}

export { parseArgs, flagBool, flagString } from "./args.js";
