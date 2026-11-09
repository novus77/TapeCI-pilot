/**
 * P0-04 evidence: container creation and SiteRegistry write authorization on an
 * Anvil fork of X Layer 196.
 *
 * Run standalone:
 *   corepack pnpm exec tsx scripts/fork/authorization.ts
 * (or `corepack pnpm fork:authorization`).
 *
 * The same scenario is exercised by tests/fork/authorization.test.ts. No real
 * funds, no mainnet transaction: every write goes to the local fork node.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, parseEventLogs, type Hex } from "viem";
import { createForkClients, readFileBytesAt, siteRegistryAbi, type ReadClient } from "@tapeci/chain";
import { XLAYER_MAINNET } from "@tapeci/config";
import { bytesToHex, sha256Hex } from "@tapeci/shared";
import { forkMetadata, startAnvilFork, type AnvilFork } from "./anvil.js";
import {
  IMPERSONATED_FUNDING_WEI,
  check,
  expectRevert,
  fundAndImpersonate,
  makeArtifactFile,
  openNewContainer,
  putFileCallData,
  registryOf,
  summarize,
  waitForSuccessTx,
  walletFor,
  writeEvidence,
  type CheckRecord,
  type ForkTestClient,
  type ForkWallet,
  type OpenedContainer,
  type RejectionRecord,
  type ResultSummary,
  type TxRecord,
} from "./support.js";

export const AUTHORIZATION_EVIDENCE_FILE = "fork-authorization.json";
/** Deterministic impersonated addresses (no private keys anywhere). */
export const OPENER_EOA: Hex = getAddress("0x1000000000000000000000000000000000000001");
export const OPERATOR_EOA: Hex = getAddress("0x1000000000000000000000000000000000000002");
export const RANDOM_EOA_A: Hex = getAddress("0x1000000000000000000000000000000000000003");
export const RANDOM_EOA_B: Hex = getAddress("0x1000000000000000000000000000000000000004");

const OWNER_FILE_PATH = "p0-04/owner.txt";
const OPERATOR_LIVE_PATH = "p0-04/operator-live.txt";
const OWNER_AFTER_EXPIRY_PATH = "p0-04/owner-after-expiry.txt";

export interface WriteVerification {
  readonly path: string;
  readonly size: number;
  readonly sha256: Hex;
  readonly chunkCount: number;
  readonly tx: TxRecord;
  readonly readBackSize: number;
  readonly readBackSha256: Hex;
  readonly matched: boolean;
}

export interface AuthorizationEvidence {
  readonly kind: "tapeci.fork.authorization.v1";
  readonly generatedBy: string;
  readonly generatedAt: string;
  readonly fork: ReturnType<typeof forkMetadata>;
  readonly chain: {
    readonly chainId: number;
    readonly factory: Hex;
    readonly opener: Hex;
    readonly siteRegistry: Hex;
    readonly processorIndex: number;
    readonly processor: Hex;
  };
  readonly fixture: {
    readonly openerEoa: Hex;
    readonly fundingWei: string;
    readonly tokensScanned: number;
    readonly tokenId: string;
    readonly wasOpenedAtForkBlock: boolean;
    readonly ownerAtForkBlock: Hex;
    readonly container: Hex;
    readonly openFeeWei: string;
  };
  readonly create: {
    readonly openTx: TxRecord;
    readonly accountOf: Hex;
    readonly isOpened: boolean;
    readonly ownerOf: Hex;
    readonly containerOwner: Hex;
    readonly containerToken: { readonly chainId: number; readonly processor: Hex; readonly tokenId: string };
    readonly containerCodeSize: number;
    readonly registryIsOpenedContainer: boolean;
  };
  readonly operator: {
    readonly address: Hex;
    readonly grantTtlSeconds: string;
    readonly grantUntilTimestamp: number;
    readonly grantedAtBlockTimestamp: number;
    readonly observedTtlSeconds: number;
    readonly grantTx: TxRecord;
    readonly revocationTtlSeconds: string;
    readonly revocationUntilTimestamp: number;
    readonly revocationTx: TxRecord;
    readonly regrantTtlSeconds: string;
    readonly regrantUntilTimestamp: number;
    readonly regrantTx: TxRecord;
  };
  readonly writes: {
    readonly ownerPutFile: WriteVerification;
    readonly operatorPutFileDuringTtl: WriteVerification;
    readonly ownerPutFileAfterOperatorExpiry: WriteVerification;
  };
  readonly rejections: {
    readonly randomEoaBeforeOperator: RejectionRecord;
    readonly randomEoaAfterOperatorSet: RejectionRecord;
    readonly operatorAfterRevocation: RejectionRecord;
    readonly operatorAfterTtlExpiry: RejectionRecord;
  };
  readonly authorizationModel: {
    readonly sharedRevertSelector: Hex | null;
    readonly knownErrorName: string | null;
    readonly note: string;
    readonly finalPathCount: number;
    readonly expectedPathCount: number;
    readonly finalPaths: readonly string[];
  };
  readonly checks: readonly CheckRecord[];
  readonly result: ResultSummary;
}

interface ScenarioContext {
  readonly fork: AnvilFork;
  readonly client: ReadClient;
  readonly testClient: ForkTestClient;
  readonly config: typeof XLAYER_MAINNET;
  readonly registry: Hex;
}

interface ScenarioOptions {
  readonly generatedBy: string;
  readonly testClient?: ForkTestClient;
}

async function putTextFile(
  context: ScenarioContext,
  wallet: ForkWallet,
  container: Hex,
  path: string,
  text: string,
): Promise<WriteVerification> {
  const file = makeArtifactFile(path, new TextEncoder().encode(text), "text/plain");
  const txHash = await wallet.writeContract({
    address: context.registry,
    abi: siteRegistryAbi,
    functionName: "putFile",
    args: [container, file.path, file.contentType, file.sha256, bytesToHex(file.bytes)],
    chain: wallet.chain,
    account: wallet.account ?? null,
  });
  const tx = await waitForSuccessTx(context.client, txHash);
  const read = await readFileBytesAt(context.client, context.registry, container, file.path);
  const info = read.info;
  return {
    path: file.path,
    size: info.size,
    sha256: info.sha256,
    chunkCount: info.chunkCount,
    tx,
    readBackSize: read.bytes.length,
    readBackSha256: sha256Hex(read.bytes),
    matched:
      read.bytes.length === file.size && sha256Hex(read.bytes).toLowerCase() === file.sha256.toLowerCase(),
  };
}

interface OperatorGrant {
  readonly tx: TxRecord;
  readonly untilTimestamp: number;
  readonly blockTimestamp: number;
  readonly operator: Hex;
  readonly eventCount: number;
}

async function grantOperator(
  context: ScenarioContext,
  ownerWallet: ForkWallet,
  container: Hex,
  ttlSeconds: bigint,
): Promise<OperatorGrant> {
  const txHash = await ownerWallet.writeContract({
    address: context.registry,
    abi: siteRegistryAbi,
    functionName: "setOperator",
    args: [container, OPERATOR_EOA, ttlSeconds],
    chain: ownerWallet.chain,
    account: ownerWallet.account ?? null,
  });
  const tx = await waitForSuccessTx(context.client, txHash);
  const receipt = await context.client.getTransactionReceipt({ hash: txHash });
  const block = await context.client.getBlock({ blockNumber: receipt.blockNumber });
  const events = parseEventLogs({
    abi: siteRegistryAbi,
    eventName: "OperatorSet",
    logs: receipt.logs,
  });
  const event = events[0];
  if (!event) throw new Error("setOperator receipt has no OperatorSet event");
  return {
    tx,
    untilTimestamp: Number(event.args.until),
    blockTimestamp: Number(block.timestamp),
    operator: getAddress(event.args.operator),
    eventCount: events.length,
  };
}

async function advanceTime(
  context: ScenarioContext,
  seconds: number,
): Promise<{ readonly timestamp: number }> {
  await context.testClient.increaseTime({ seconds });
  await context.testClient.mine({ blocks: 1 });
  const block = await context.client.getBlock();
  return { timestamp: Number(block.timestamp) };
}

/** Run the whole P0-04 authorization matrix against a started fork. */
export async function runAuthorizationScenario(
  fork: AnvilFork,
  options: ScenarioOptions,
): Promise<AuthorizationEvidence> {
  const config = XLAYER_MAINNET;
  const registry = registryOf(config);
  const { publicClient, testClient } = createForkClients(fork.url);
  const activeTestClient = options.testClient ?? testClient;
  const context: ScenarioContext = {
    fork,
    client: publicClient,
    testClient: activeTestClient,
    config,
    registry,
  };
  // --- fixture: open a brand-new container -----------------------------------
  const opened: OpenedContainer = await openNewContainer({
    fork,
    client: publicClient,
    testClient: activeTestClient,
    config,
    opener: OPENER_EOA,
  });
  const container = opened.container;
  const ownerWallet = walletFor(fork.url, opened.owner);
  await fundAndImpersonate(activeTestClient, opened.owner);

  const checks: CheckRecord[] = [];
  checks.push(
    check(
      "AUTH-01",
      "opener.open(circuits, tokenId) creates a deployed container and succeeds on chain",
      { status: "success", opened: true, codeSizeGreaterThanZero: true },
      {
        status: opened.openTx.status,
        opened: opened.isOpened,
        codeSizeGreaterThanZero: opened.containerCodeSize > 0,
      },
    ),
    check(
      "AUTH-02",
      "accountOf(circuits, tokenId) and ownerOf(tokenId) match the derived container / holder",
      {
        accountOf: opened.fixture.container,
        ownerOf: opened.fixture.owner,
        registryIsOpenedContainer: true,
      },
      {
        accountOf: opened.container,
        ownerOf: opened.ownerOf,
        registryIsOpenedContainer: opened.registryIsOpenedContainer,
      },
    ),
    check(
      "AUTH-03",
      "container.token() == (196, processor, tokenId) and container.owner() == current circuit holder",
      {
        chainId: 196,
        processor: opened.fixture.processor,
        tokenId: opened.fixture.tokenId.toString(),
        owner: opened.fixture.owner,
      },
      {
        chainId: opened.containerToken.chainId,
        processor: opened.containerToken.processor,
        tokenId: opened.containerToken.tokenId,
        owner: opened.containerOwner,
      },
    ),
  );

  // --- current owner can write ----------------------------------------------
  const ownerPutFile = await putTextFile(
    context,
    ownerWallet,
    container,
    OWNER_FILE_PATH,
    "p0-04: current circuit holder can putFile\n",
  );
  checks.push(
    check(
      "AUTH-04",
      "current holder putFile succeeds and the bytes read back match the raw SHA-256",
      { status: "success", size: ownerPutFile.size, matched: true, chunkCount: 1 },
      {
        status: ownerPutFile.tx.status,
        size: ownerPutFile.size,
        matched: ownerPutFile.matched,
        chunkCount: ownerPutFile.chunkCount,
      },
    ),
  );

  // --- a random funded EOA is rejected --------------------------------------
  await fundAndImpersonate(activeTestClient, RANDOM_EOA_A);
  const randomWalletA = walletFor(fork.url, RANDOM_EOA_A);
  const randomFile = makeArtifactFile("p0-04/random-a.txt", new TextEncoder().encode("nope\n"), "text/plain");
  const randomRejection = await expectRevert({
    case: "random funded EOA putFile before any operator is set",
    forkUrl: fork.url,
    client: publicClient,
    config,
    wallet: randomWalletA,
    to: registry,
    container,
    functionName: "putFile",
    argumentsSummary: { path: randomFile.path, contentType: randomFile.contentType, dataBytes: randomFile.size },
    data: putFileCallData(container, randomFile.path, randomFile.contentType, randomFile.sha256, bytesToHex(randomFile.bytes)),
    signer: RANDOM_EOA_A,
    gas: 1_000_000n,
    snapshotPaths: [OWNER_FILE_PATH, randomFile.path],
  });
  checks.push(
    check(
      "AUTH-05",
      "a funded EOA that is neither holder nor operator is rejected on chain and writes nothing",
      { reverted: true, transactionStatus: "reverted", stateUnchanged: true, hasRevertSelector: true },
      {
        reverted: randomRejection.ethCall.reverted,
        transactionStatus: randomRejection.transaction.receiptStatus,
        stateUnchanged: randomRejection.stateUnchanged,
        hasRevertSelector: randomRejection.ethCall.selector !== null,
      },
    ),
  );

  // --- operator delegation, live TTL ----------------------------------------
  const grantTtl = 120n;
  const grant = await grantOperator(context, ownerWallet, container, grantTtl);
  checks.push(
    check(
      "AUTH-06",
      "setOperator(container, op, ttl) emits OperatorSet with until = block.timestamp + ttl (TTL in seconds)",
      {
        operator: OPERATOR_EOA,
        ttlSeconds: grantTtl.toString(),
        untilEqualsBlockTimestampPlusTtl: true,
      },
      {
        operator: grant.operator,
        ttlSeconds: (grant.untilTimestamp - grant.blockTimestamp).toString(),
        untilEqualsBlockTimestampPlusTtl: grant.untilTimestamp === grant.blockTimestamp + Number(grantTtl),
      },
    ),
  );

  await fundAndImpersonate(activeTestClient, OPERATOR_EOA);
  const operatorWallet = walletFor(fork.url, OPERATOR_EOA);
  const operatorPutFile = await putTextFile(
    context,
    operatorWallet,
    container,
    OPERATOR_LIVE_PATH,
    "p0-04: live operator can putFile inside the TTL\n",
  );
  checks.push(
    check(
      "AUTH-07",
      "a delegated operator can putFile while its TTL is live",
      { status: "success", size: operatorPutFile.size, matched: true },
      { status: operatorPutFile.tx.status, size: operatorPutFile.size, matched: operatorPutFile.matched },
    ),
  );

  await fundAndImpersonate(activeTestClient, RANDOM_EOA_B);
  const randomWalletB = walletFor(fork.url, RANDOM_EOA_B);
  const randomBFile = makeArtifactFile("p0-04/random-b.txt", new TextEncoder().encode("still nope\n"), "text/plain");
  const randomAfterOperator = await expectRevert({
    case: "random funded EOA putFile while an unrelated operator is live",
    forkUrl: fork.url,
    client: publicClient,
    config,
    wallet: randomWalletB,
    to: registry,
    container,
    functionName: "putFile",
    argumentsSummary: { path: randomBFile.path, contentType: randomBFile.contentType, dataBytes: randomBFile.size },
    data: putFileCallData(container, randomBFile.path, randomBFile.contentType, randomBFile.sha256, bytesToHex(randomBFile.bytes)),
    signer: RANDOM_EOA_B,
    gas: 1_000_000n,
    snapshotPaths: [OWNER_FILE_PATH, OPERATOR_LIVE_PATH, randomBFile.path],
  });
  checks.push(
    check(
      "AUTH-08",
      "setting one operator does not authorize any other address",
      { reverted: true, transactionStatus: "reverted", stateUnchanged: true },
      {
        reverted: randomAfterOperator.ethCall.reverted,
        transactionStatus: randomAfterOperator.transaction.receiptStatus,
        stateUnchanged: randomAfterOperator.stateUnchanged,
      },
    ),
  );

  // --- explicit revocation (setOperator with ttl 0) -------------------------
  const revocation = await grantOperator(context, ownerWallet, container, 0n);
  const revokedAt = await advanceTime(context, 2);
  const revokedAttemptFile = makeArtifactFile(
    "p0-04/operator-revoked.txt",
    new TextEncoder().encode("revoked operator must not write\n"),
    "text/plain",
  );
  const operatorAfterRevocation = await expectRevert({
    case: "operator writes after setOperator(container, op, 0) revoked it",
    forkUrl: fork.url,
    client: publicClient,
    config,
    wallet: operatorWallet,
    to: registry,
    container,
    functionName: "putFile",
    argumentsSummary: { path: revokedAttemptFile.path, dataBytes: revokedAttemptFile.size },
    data: putFileCallData(
      container,
      revokedAttemptFile.path,
      revokedAttemptFile.contentType,
      revokedAttemptFile.sha256,
      bytesToHex(revokedAttemptFile.bytes),
    ),
    signer: OPERATOR_EOA,
    gas: 1_000_000n,
    snapshotPaths: [OWNER_FILE_PATH, OPERATOR_LIVE_PATH, revokedAttemptFile.path],
  });
  checks.push(
    check(
      "AUTH-09",
      "a revoked operator is rejected (revocation set until <= current block timestamp)",
      { revoked: true, currentTimestampAfterUntil: true, reverted: true, transactionStatus: "reverted", stateUnchanged: true },
      {
        revoked: revocation.untilTimestamp <= revokedAt.timestamp,
        currentTimestampAfterUntil: revokedAt.timestamp > revocation.untilTimestamp,
        reverted: operatorAfterRevocation.ethCall.reverted,
        transactionStatus: operatorAfterRevocation.transaction.receiptStatus,
        stateUnchanged: operatorAfterRevocation.stateUnchanged,
      },
    ),
  );

  // --- TTL expiry -----------------------------------------------------------
  const regrant = await grantOperator(context, ownerWallet, container, grantTtl);
  const currentTimestamp = Number((await context.client.getBlock()).timestamp);
  const expiryJumpSeconds = Math.max(2, regrant.untilTimestamp - currentTimestamp + 2);
  const expiredAt = await advanceTime(context, expiryJumpSeconds);
  const expiredAttemptFile = makeArtifactFile(
    "p0-04/operator-expired.txt",
    new TextEncoder().encode("expired operator must not write\n"),
    "text/plain",
  );
  const operatorAfterExpiry = await expectRevert({
    case: "operator writes after its TTL expired (evm_increaseTime past until)",
    forkUrl: fork.url,
    client: publicClient,
    config,
    wallet: operatorWallet,
    to: registry,
    container,
    functionName: "putFile",
    argumentsSummary: { path: expiredAttemptFile.path, dataBytes: expiredAttemptFile.size },
    data: putFileCallData(
      container,
      expiredAttemptFile.path,
      expiredAttemptFile.contentType,
      expiredAttemptFile.sha256,
      bytesToHex(expiredAttemptFile.bytes),
    ),
    signer: OPERATOR_EOA,
    gas: 1_000_000n,
    snapshotPaths: [OWNER_FILE_PATH, OPERATOR_LIVE_PATH, expiredAttemptFile.path],
  });
  checks.push(
    check(
      "AUTH-10",
      "after the operator TTL expires the operator is rejected and writes nothing",
      { expired: true, reverted: true, transactionStatus: "reverted", stateUnchanged: true },
      {
        expired: expiredAt.timestamp > regrant.untilTimestamp,
        reverted: operatorAfterExpiry.ethCall.reverted,
        transactionStatus: operatorAfterExpiry.transaction.receiptStatus,
        stateUnchanged: operatorAfterExpiry.stateUnchanged,
      },
    ),
  );

  const ownerAfterExpiry = await putTextFile(
    context,
    ownerWallet,
    container,
    OWNER_AFTER_EXPIRY_PATH,
    "p0-04: holder write authority does not depend on operator TTL\n",
  );
  checks.push(
    check(
      "AUTH-11",
      "the circuit holder can still write after the operator TTL expired",
      { status: "success", matched: true },
      { status: ownerAfterExpiry.tx.status, matched: ownerAfterExpiry.matched },
    ),
  );

  // --- final invariants -----------------------------------------------------
  const pathCount = await publicClient.readContract({
    address: registry,
    abi: siteRegistryAbi,
    functionName: "pathCount",
    args: [container],
  });
  const paths = await publicClient.readContract({
    address: registry,
    abi: siteRegistryAbi,
    functionName: "paths",
    args: [container],
  });
  const expectedPathCount = 3;
  const rejectedPathsAbsent = [randomFile.path, randomBFile.path, revokedAttemptFile.path, expiredAttemptFile.path].every(
    (path) => !paths.includes(path),
  );
  checks.push(
    check(
      "AUTH-12",
      "only the holder/operator writes are stored; every rejected path is absent",
      { pathCount: expectedPathCount, rejectedPathsAbsent: true },
      { pathCount: Number(pathCount), rejectedPathsAbsent },
    ),
  );

  const selectors = [
    randomRejection.ethCall.selector,
    randomAfterOperator.ethCall.selector,
    operatorAfterRevocation.ethCall.selector,
    operatorAfterExpiry.ethCall.selector,
  ];
  const uniqueSelectors = [...new Set(selectors.filter((value): value is Hex => value !== null))];
  const sharedSelector = uniqueSelectors.length === 1 ? (uniqueSelectors[0] ?? null) : null;
  const knownErrorName =
    sharedSelector === null ? null : randomRejection.ethCall.knownErrorName;

  const evidence: AuthorizationEvidence = {
    kind: "tapeci.fork.authorization.v1",
    generatedBy: options.generatedBy,
    generatedAt: new Date().toISOString(),
    fork: forkMetadata(fork),
    chain: {
      chainId: fork.chainId,
      factory: config.factory,
      opener: config.opener,
      siteRegistry: registry,
      processorIndex: opened.fixture.processorIndex,
      processor: opened.fixture.processor,
    },
    fixture: {
      openerEoa: OPENER_EOA,
      fundingWei: IMPERSONATED_FUNDING_WEI.toString(),
      tokensScanned: opened.tokensScanned,
      tokenId: opened.fixture.tokenId.toString(),
      wasOpenedAtForkBlock: opened.fixture.opened,
      ownerAtForkBlock: opened.fixture.owner,
      container,
      openFeeWei: opened.openFeeWei,
    },
    create: {
      openTx: opened.openTx,
      accountOf: opened.container,
      isOpened: opened.isOpened,
      ownerOf: opened.ownerOf,
      containerOwner: opened.containerOwner,
      containerToken: opened.containerToken,
      containerCodeSize: opened.containerCodeSize,
      registryIsOpenedContainer: opened.registryIsOpenedContainer,
    },
    operator: {
      address: OPERATOR_EOA,
      grantTtlSeconds: grantTtl.toString(),
      grantUntilTimestamp: grant.untilTimestamp,
      grantedAtBlockTimestamp: grant.blockTimestamp,
      observedTtlSeconds: grant.untilTimestamp - grant.blockTimestamp,
      grantTx: grant.tx,
      revocationTtlSeconds: "0",
      revocationUntilTimestamp: revocation.untilTimestamp,
      revocationTx: revocation.tx,
      regrantTtlSeconds: grantTtl.toString(),
      regrantUntilTimestamp: regrant.untilTimestamp,
      regrantTx: regrant.tx,
    },
    writes: {
      ownerPutFile,
      operatorPutFileDuringTtl: operatorPutFile,
      ownerPutFileAfterOperatorExpiry: ownerAfterExpiry,
    },
    rejections: {
      randomEoaBeforeOperator: randomRejection,
      randomEoaAfterOperatorSet: randomAfterOperator,
      operatorAfterRevocation,
      operatorAfterTtlExpiry: operatorAfterExpiry,
    },
    authorizationModel: {
      sharedRevertSelector: sharedSelector,
      knownErrorName,
      note:
        "Write authorization is enforced by the deployed SiteRegistry (onlyEditor): the current circuit holder and a non-expired operator set via setOperator may write. Every rejected attempt was captured twice: eth_call revert bytes + a broadcast transaction mined with status 'reverted', and the registry snapshot was unchanged. The custom error is not part of the transcribed read ABI; the selector is recorded verbatim and 0x30cd7471 is listed by 4byte.directory as NotOwner().",
      finalPathCount: Number(pathCount),
      expectedPathCount,
      finalPaths: [...paths],
    },
    checks,
    result: summarize(checks),
  };
  return evidence;
}

function renderSummary(evidence: AuthorizationEvidence): string {
  const lines = [
    `P0-04 authorization: ${evidence.result.pass ? "PASS" : "FAIL"} (${evidence.result.checks} checks)`,
    `fork block: ${evidence.fork.forkBlockNumber} (${evidence.fork.sourceUrl})`,
    `processor 0: ${evidence.chain.processor}`,
    `token #${evidence.fixture.tokenId} -> container ${evidence.fixture.container} (owner ${evidence.fixture.ownerAtForkBlock})`,
    `open tx: ${evidence.create.openTx.txHash}`,
    `write auth custom error: ${evidence.authorizationModel.sharedRevertSelector ?? "n/a"} ${evidence.authorizationModel.knownErrorName ?? ""}`,
  ];
  for (const item of evidence.checks) {
    lines.push(`  ${item.pass ? "PASS" : "FAIL"} ${item.id}: ${item.description}`);
  }
  if (!evidence.result.pass) lines.push(`failures: ${evidence.result.failures.join(", ")}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const fork = await startAnvilFork();
  let evidence: AuthorizationEvidence | null = null;
  try {
    evidence = await runAuthorizationScenario(fork, {
      generatedBy: "scripts/fork/authorization.ts",
    });
    const path = writeEvidence(AUTHORIZATION_EVIDENCE_FILE, evidence);
    console.log(renderSummary(evidence));
    console.log(`evidence written to ${path}`);
  } finally {
    await fork.stop();
  }
  if (evidence === null || !evidence.result.pass) process.exitCode = 1;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error("P0-04 fork authorization FAILED:", error);
    process.exitCode = 1;
  });
}
