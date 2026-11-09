/**
 * Shared building blocks for the P0-04 / P0-05 fork evidence runs.
 *
 * Everything here talks to a local Anvil fork only. Addresses of mutable state
 * (token owner, container) are always re-read at the pinned fork block, never
 * hard-coded from research notes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  createForkClients,
  createImpersonatedWalletClient,
  containerAbi,
  factoryAbi,
  openerAbi,
  processorAbi,
  siteRegistryAbi,
  type ReadClient,
} from "@tapeci/chain";
import { XLAYER_MAINNET, type ChainConfig } from "@tapeci/config";
import {
  TapeCiError,
  bytesToHex,
  canonicalizeArtifactPath,
  sha256Hex,
  type ArtifactFile,
} from "@tapeci/shared";
import { JsonRpcError, rpcRequest, type AnvilFork } from "./anvil.js";

export type ForkClients = ReturnType<typeof createForkClients>;
export type ForkWallet = WalletClient;
export type ForkTestClient = ForkClients["testClient"];

export const ONE_OKB = 10n ** 18n;
export const IMPERSONATED_FUNDING_WEI = 100n * ONE_OKB;
export const DEFAULT_CONTENT_TYPE = "application/octet-stream";
export const EVIDENCE_DIR = fileURLToPath(new URL("../../docs/evidence/", import.meta.url));

/** Raised when the pinned fork block no longer contains the expected fixture shape. */
export class ForkFixtureUnavailableError extends Error {
  readonly details: Readonly<Record<string, unknown>>;
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "ForkFixtureUnavailableError";
    this.details = details;
  }
}

/** Deterministic pseudo-random payload (mulberry32) so evidence runs are reproducible. */
export function seededBytes(length: number, seed: number): Uint8Array {
  let state = (seed >>> 0) === 0 ? 0x9e3779b9 : seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = Math.floor(next() * 256);
  }
  return out;
}

/** Build a deployer-ready `ArtifactFile` with raw SHA-256 and canonical path. */
export function makeArtifactFile(
  path: string,
  bytes: Uint8Array,
  contentType: string = DEFAULT_CONTENT_TYPE,
): ArtifactFile {
  return {
    path: canonicalizeArtifactPath(path),
    sourceRelativePath: path,
    contentType,
    size: bytes.length,
    sha256: sha256Hex(bytes),
    bytes,
  };
}

export function artifactFromText(path: string, text: string, contentType = "text/plain"): ArtifactFile {
  return makeArtifactFile(path, new TextEncoder().encode(text), contentType);
}

export async function fundAndImpersonate(
  testClient: ForkTestClient,
  address: Hex,
  value: bigint = IMPERSONATED_FUNDING_WEI,
): Promise<void> {
  await testClient.setBalance({ address, value });
  await testClient.impersonateAccount({ address });
}

/**
 * `packages/deployer` types its client argument as the bare viem `PublicClient`
 * (account: undefined), which under `exactOptionalPropertyTypes` rejects the
 * fork client type produced by `packages/chain`. The runtime client is the same;
 * this cast keeps the P0-05 script strictly typed. See the P0-04/P0-05 report.
 */
export function deployerPublicClient(client: ReadClient): PublicClient {
  return client as unknown as PublicClient;
}

export function walletFor(forkUrl: string, address: Hex): ForkWallet {
  // `createImpersonatedWalletClient` returns a fully-typed viem client; the
  // default `WalletClient` instantiation is what packages/deployer accepts.
  return createImpersonatedWalletClient(forkUrl, address) as unknown as WalletClient;
}

export function clientsFor(fork: AnvilFork): ForkClients {
  return createForkClients(fork.url);
}

/** Full success receipt record for the evidence JSON. */
export interface TxRecord {
  readonly txHash: Hex;
  readonly status: string;
  readonly blockNumber: number;
  readonly gasUsed: string;
}

export async function waitForSuccessTx(
  client: ReadClient,
  txHash: Hex,
): Promise<TxRecord> {
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new TapeCiError("INTERNAL", `transaction ${txHash} reverted (status ${receipt.status})`, {
      details: { txHash },
    });
  }
  return {
    txHash,
    status: receipt.status,
    blockNumber: Number(receipt.blockNumber),
    gasUsed: receipt.gasUsed.toString(),
  };
}

/** Known custom-error selectors observed on the X Layer implementation (documented in evidence). */
export const KNOWN_ERROR_SELECTORS: Readonly<Record<string, string>> = {
  "0x30cd7471": "NotOwner()",
};

export interface EthCallOutcome {
  readonly reverted: boolean;
  readonly rawData: Hex | null;
  readonly selector: Hex | null;
  readonly knownErrorName: string | null;
  readonly rpcCode: number | null;
  readonly message: string | null;
}

function asHexString(value: unknown): Hex | null {
  if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0) {
    return value as Hex;
  }
  return null;
}

/** Execute `eth_call` directly against the fork node and preserve revert bytes. */
export async function captureEthCall(
  forkUrl: string,
  from: Hex,
  to: Hex,
  data: Hex,
): Promise<EthCallOutcome> {
  try {
    const result = await rpcRequest(forkUrl, "eth_call", [{ from, to, data }, "latest"]);
    const returned = asHexString(result);
    return {
      reverted: false,
      rawData: returned,
      selector: null,
      knownErrorName: null,
      rpcCode: null,
      message: null,
    };
  } catch (error) {
    if (!(error instanceof JsonRpcError)) throw error;
    const rawData = asHexString(error.data);
    const selector = rawData !== null && rawData.length >= 10 ? (rawData.slice(0, 10) as Hex) : null;
    return {
      reverted: true,
      rawData,
      selector,
      knownErrorName: selector === null ? null : (KNOWN_ERROR_SELECTORS[selector] ?? null),
      rpcCode: error.code,
      message: error.message,
    };
  }
}

export interface StateSnapshot {
  readonly blockNumber: number;
  readonly pathCount: number;
  readonly files: Readonly<Record<string, { readonly exists: boolean; readonly size: number; readonly chunkCount: number }>>;
}

/** Snapshot pathCount + a fixed set of paths, used to prove a rejected write changed nothing. */
export async function snapshotState(
  client: ReadClient,
  config: ChainConfig,
  container: Hex,
  paths: readonly string[],
  blockNumber?: bigint,
): Promise<StateSnapshot> {
  const registry = registryOf(config);
  const readOptions = blockNumber === undefined ? {} : { blockNumber };
  const pathCount = await client.readContract({
    address: registry,
    abi: siteRegistryAbi,
    functionName: "pathCount",
    args: [getAddress(container)],
    ...readOptions,
  });
  const files: Record<string, { exists: boolean; size: number; chunkCount: number }> = {};
  for (const path of paths) {
    const raw = (await client.readContract({
      address: registry,
      abi: siteRegistryAbi,
      functionName: "fileInfo",
      args: [getAddress(container), path],
      ...readOptions,
    })) as unknown as readonly [number, string, Hex, number, bigint];
    files[path] = {
      exists: raw[4] > 0n,
      size: Number(raw[0]),
      chunkCount: Number(raw[4]),
    };
  }
  return { blockNumber: Number(blockNumber ?? (await client.getBlockNumber())), pathCount: Number(pathCount), files };
}

export interface RejectionRecord {
  readonly case: string;
  readonly functionName: string;
  readonly signer: Hex;
  readonly to: Hex;
  readonly argumentsSummary: Readonly<Record<string, unknown>>;
  readonly calldataBytes: number;
  readonly ethCall: EthCallOutcome;
  readonly transaction: {
    readonly accepted: boolean;
    readonly txHash: Hex | null;
    readonly receiptStatus: string | null;
    readonly blockNumber: number | null;
    readonly gasUsed: string | null;
    readonly sendError: string | null;
  };
  readonly stateBefore: StateSnapshot;
  readonly stateAfter: StateSnapshot;
  readonly stateUnchanged: boolean;
}

export interface ExpectRevertOptions {
  readonly case: string;
  readonly forkUrl: string;
  readonly client: ReadClient;
  readonly config: ChainConfig;
  readonly wallet: ForkWallet;
  readonly to: Hex;
  /** Container whose pathCount/fileInfo values are snapshotted before and after. */
  readonly container: Hex;
  readonly functionName: string;
  readonly argumentsSummary: Readonly<Record<string, unknown>>;
  readonly data: Hex;
  readonly signer: Hex;
  readonly gas?: bigint;
  readonly snapshotPaths: readonly string[];
}

/**
 * Prove a write is rejected: first capture the revert bytes with `eth_call`, then
 * broadcast the same calldata in a transaction with an explicit gas limit and
 * record the reverted receipt, then re-snapshot the registry to prove no bytes
 * changed. The registry itself is the authority here (PRD §7.2).
 */
export async function expectRevert(options: ExpectRevertOptions): Promise<RejectionRecord> {
  const { client, config, wallet, to, container, data, signer, forkUrl } = options;
  const stateBefore = await snapshotState(client, config, container, options.snapshotPaths);
  const ethCall = await captureEthCall(forkUrl, signer, to, data);
  if (!ethCall.reverted) {
    throw new TapeCiError("INTERNAL", `expected ${options.case} to revert but eth_call succeeded`, {
      details: { case: options.case, returned: ethCall.rawData },
    });
  }
  let txHash: Hex | null = null;
  let receiptStatus: string | null = null;
  let blockNumber: number | null = null;
  let gasUsed: string | null = null;
  let sendError: string | null = null;
  try {
    txHash = await wallet.sendTransaction({
      to,
      data,
      gas: options.gas ?? 1_000_000n,
      chain: wallet.chain,
      account: wallet.account ?? null,
    });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    receiptStatus = receipt.status;
    blockNumber = Number(receipt.blockNumber);
    gasUsed = receipt.gasUsed.toString();
    if (receipt.status === "success") {
      throw new TapeCiError("INTERNAL", `expected ${options.case} to revert but the transaction succeeded`, {
        details: { case: options.case, txHash },
      });
    }
  } catch (error) {
    if (error instanceof TapeCiError) throw error;
    sendError = error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
  }
  const stateAfter = await snapshotState(client, config, container, options.snapshotPaths);
  const stateKey = (snapshot: StateSnapshot): string =>
    JSON.stringify({ pathCount: snapshot.pathCount, files: snapshot.files });
  const stateUnchanged = stateKey(stateBefore) === stateKey(stateAfter);
  if (!stateUnchanged) {
    throw new TapeCiError("INTERNAL", `rejected write changed registry state for ${options.case}`, {
      details: { case: options.case, stateBefore, stateAfter },
    });
  }
  return {
    case: options.case,
    functionName: options.functionName,
    signer,
    to,
    argumentsSummary: options.argumentsSummary,
    calldataBytes: (data.length - 2) / 2,
    ethCall,
    transaction: { accepted: txHash !== null, txHash, receiptStatus, blockNumber, gasUsed, sendError },
    stateBefore,
    stateAfter,
    stateUnchanged,
  };
}

export function registryOf(config: ChainConfig): Hex {
  const registry = config.registries[0];
  if (!registry) throw new TapeCiError("INTERNAL", "no SiteRegistry configured");
  return registry;
}

/** Parse `(path, expectIndex)` from a raw `appendChunk` calldata blob (fork evidence only). */
export function decodeAppendChunkCalldata(data: Hex): { path: string; expectIndex: number } {
  const decoded = decodeFunctionData({ abi: siteRegistryAbi, data });
  if (decoded.functionName !== "appendChunk") {
    throw new TapeCiError("INTERNAL", `expected appendChunk calldata, got ${decoded.functionName}`);
  }
  const args = decoded.args as readonly [Hex, string, bigint, Hex] | undefined;
  if (!args) throw new TapeCiError("INTERNAL", "appendChunk calldata missing args");
  return { path: args[1], expectIndex: Number(args[2]) };
}

export async function decodeFunctionDataFromTx(
  client: ReadClient,
  txHash: Hex,
): Promise<{ functionName: string; args: readonly unknown[] }> {
  const tx = await client.getTransaction({ hash: txHash });
  const decoded = decodeFunctionData({ abi: siteRegistryAbi, data: tx.input });
  return { functionName: decoded.functionName, args: decoded.args ?? [] };
}

export interface FixtureCircuit {
  readonly processorIndex: number;
  readonly processor: Hex;
  readonly tokenId: bigint;
  readonly owner: Hex;
  readonly opened: boolean;
  readonly container: Hex;
}

export interface FixtureScan {
  readonly fixture: FixtureCircuit;
  readonly tokensScanned: number;
}

/**
 * Scan processor `processorIndex` for the first token that exists (ownerOf does
 * not revert) but is not opened yet. Mutable owners are read at the pinned block.
 */
export async function findUnopenedToken(
  client: ReadClient,
  config: ChainConfig,
  options: { processorIndex?: number; maxTokenId?: bigint; blockNumber?: bigint } = {},
): Promise<FixtureScan> {
  const processorIndex = options.processorIndex ?? 0;
  const maxTokenId = options.maxTokenId ?? 60n;
  const readOptions = options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber };
  const processor = await client.readContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: "cpuAt",
    args: [BigInt(processorIndex)],
    ...readOptions,
  });
  let tokensScanned = 0;
  for (let tokenId = 1n; tokenId <= maxTokenId; tokenId += 1n) {
    tokensScanned += 1;
    let owner: Hex;
    try {
      owner = await client.readContract({
        address: processor,
        abi: processorAbi,
        functionName: "ownerOf",
        args: [tokenId],
        ...readOptions,
      });
    } catch {
      continue; // token does not exist on this processor
    }
    const [opened, container] = await Promise.all([
      client.readContract({
        address: config.opener,
        abi: openerAbi,
        functionName: "isOpened",
        args: [processor, tokenId],
        ...readOptions,
      }),
      client.readContract({
        address: config.opener,
        abi: openerAbi,
        functionName: "accountOf",
        args: [processor, tokenId],
        ...readOptions,
      }),
    ]);
    if (!opened) {
      return {
        fixture: {
          processorIndex,
          processor: getAddress(processor),
          tokenId,
          owner: getAddress(owner),
          opened: false,
          container: getAddress(container),
        },
        tokensScanned,
      };
    }
  }
  throw new ForkFixtureUnavailableError(
    `no unopened token found on processor ${processorIndex} in 1..${maxTokenId} at fork block ${options.blockNumber?.toString() ?? "latest"}`,
    { processorIndex, maxTokenId: maxTokenId.toString() },
  );
}

export interface OpenedContainer {
  readonly fixture: FixtureCircuit;
  readonly tokensScanned: number;
  readonly container: Hex;
  readonly owner: Hex;
  readonly opener: Hex;
  readonly openFeeWei: string;
  readonly openTx: TxRecord;
  readonly isOpened: boolean;
  readonly ownerOf: Hex;
  readonly containerOwner: Hex;
  readonly containerToken: { readonly chainId: number; readonly processor: Hex; readonly tokenId: string };
  readonly containerCodeSize: number;
  readonly registryIsOpenedContainer: boolean;
}

export interface OpenContainerOptions {
  readonly fork: AnvilFork;
  readonly client: ReadClient;
  readonly testClient: ForkTestClient;
  readonly config?: ChainConfig;
  readonly opener: Hex;
  readonly maxTokenId?: bigint;
}

/**
 * Open a brand-new container on the fork:
 * `opener.open(circuits, tokenId)` from a funded impersonated EOA, payable with
 * the live `FEE()`, then verify accountOf/isOpened/ownerOf/token().
 */
export async function openNewContainer(options: OpenContainerOptions): Promise<OpenedContainer> {
  const config = options.config ?? XLAYER_MAINNET;
  const blockNumber = options.fork.forkBlockNumber;
  const scan = await findUnopenedToken(options.client, config, {
    blockNumber,
    ...(options.maxTokenId === undefined ? {} : { maxTokenId: options.maxTokenId }),
  });
  const openFeeWei = await options.client.readContract({
    address: config.opener,
    abi: openerAbi,
    functionName: "FEE",
    blockNumber,
  });
  await fundAndImpersonate(options.testClient, options.opener);
  const wallet = walletFor(options.fork.url, options.opener);
  const openTxHash = await wallet.writeContract({
    address: config.opener,
    abi: openerAbi,
    functionName: "open",
    args: [scan.fixture.processor, scan.fixture.tokenId],
    value: openFeeWei,
    chain: wallet.chain,
    account: wallet.account ?? null,
  });
  const openTx = await waitForSuccessTx(options.client, openTxHash);
  const readOptions = { blockNumber: BigInt(openTx.blockNumber) };
  const [container, isOpened, ownerOf] = await Promise.all([
    options.client.readContract({
      address: config.opener,
      abi: openerAbi,
      functionName: "accountOf",
      args: [scan.fixture.processor, scan.fixture.tokenId],
      ...readOptions,
    }),
    options.client.readContract({
      address: config.opener,
      abi: openerAbi,
      functionName: "isOpened",
      args: [scan.fixture.processor, scan.fixture.tokenId],
      ...readOptions,
    }),
    options.client.readContract({
      address: scan.fixture.processor,
      abi: processorAbi,
      functionName: "ownerOf",
      args: [scan.fixture.tokenId],
      ...readOptions,
    }),
  ]);
  const containerAddress = getAddress(container);
  const [containerOwner, tokenTuple, code, registryIsOpenedContainer] = await Promise.all([
    options.client.readContract({
      address: containerAddress,
      abi: containerAbi,
      functionName: "owner",
      ...readOptions,
    }),
    options.client.readContract({
      address: containerAddress,
      abi: containerAbi,
      functionName: "token",
      ...readOptions,
    }),
    options.client.getCode({ address: containerAddress, ...readOptions }),
    options.client.readContract({
      address: config.registries[0] as Hex,
      abi: siteRegistryAbi,
      functionName: "isOpenedContainer",
      args: [containerAddress],
      ...readOptions,
    }),
  ]);
  return {
    fixture: scan.fixture,
    tokensScanned: scan.tokensScanned,
    container: containerAddress,
    owner: getAddress(ownerOf),
    opener: options.opener,
    openFeeWei: openFeeWei.toString(),
    openTx,
    isOpened,
    ownerOf: getAddress(ownerOf),
    containerOwner: getAddress(containerOwner),
    containerToken: {
      chainId: Number(tokenTuple[0]),
      processor: getAddress(tokenTuple[1]),
      tokenId: tokenTuple[2].toString(),
    },
    containerCodeSize: code ? (code.length - 2) / 2 : 0,
    registryIsOpenedContainer,
  };
}

export interface CheckRecord {
  readonly id: string;
  readonly description: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly pass: boolean;
}

export function check(
  id: string,
  description: string,
  expected: unknown,
  actual: unknown,
): CheckRecord {
  return {
    id,
    description,
    expected,
    actual,
    pass: JSON.stringify(expected) === JSON.stringify(actual),
  };
}

export interface ResultSummary {
  readonly pass: boolean;
  readonly checks: number;
  readonly failures: readonly string[];
}

export function summarize(checks: readonly CheckRecord[]): ResultSummary {
  const failures = checks.filter((item) => !item.pass).map((item) => item.id);
  return { pass: failures.length === 0, checks: checks.length, failures };
}

/** Write an evidence document under docs/evidence/ and return the absolute path. */
/**
 * Write an evidence artefact.
 *
 * `TAPECI_EVIDENCE_DIR` redirects it. That matters for more than tidiness (P7-11): the
 * committed files under `docs/evidence/` are meant to anchor a past measurement, and a
 * test run that rewrites them silently turns a record into a mutable output — the next
 * reader cannot tell what was observed then from what ran just now. The fork suites set
 * this to a temp directory, so running them no longer dirties the tracked evidence.
 */
export function writeEvidence(fileName: string, value: unknown): string {
  const dir = process.env.TAPECI_EVIDENCE_DIR ?? EVIDENCE_DIR;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

/** Convert a byte count into a short human string; used in logs only. */
export function describeBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Build putFile calldata without any client (used for revert capture). */
export function putFileCallData(
  container: Hex,
  path: string,
  contentType: string,
  sha256: Hex,
  data: Hex,
): Hex {
  return encodeFunctionData({
    abi: siteRegistryAbi,
    functionName: "putFile",
    args: [container, path, contentType, sha256, data],
  });
}

/** Build appendChunk calldata without any client (used for revert capture). */
export function appendChunkCallData(
  container: Hex,
  path: string,
  expectIndex: bigint,
  data: Hex,
): Hex {
  return encodeFunctionData({
    abi: siteRegistryAbi,
    functionName: "appendChunk",
    args: [container, path, expectIndex, data],
  });
}

export { bytesToHex };
