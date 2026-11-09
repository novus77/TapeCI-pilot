#!/usr/bin/env tsx
/**
 * Activate (bind) a TapeOut on-chain name to a container.
 *
 *   pnpm bind:domain -- --container 0x… --name 10.2.4.tape
 *   pnpm bind:domain -- --container 0x… --name 10.2.4.tape --months 1
 *   pnpm bind:domain -- --container 0x… --name 10.2.4.tape --send
 *
 * Dry-run by default: reads `monthlyFee()`, `isLive`, `isContainerLive`,
 * `containerPaidUntil`, estimates gas for the exact call and prints
 * `{to, data, value}` so the holder can send it from any wallet. It never signs.
 *
 * `--send` loads `TAPECI_OPERATOR_PRIVATE_KEY` from `.tapeci/operator.env`,
 * checks on chain that the key's address is the container's owner (bind is
 * holder-only), simulates with `eth_call`, sends, and waits for the receipt.
 * It refuses when the key cannot be the holder (or the container has no owner).
 *
 * `--api URL` is the base URL of the TapeCI API (with a future
 * `POST /v1/containers/:address/bind`); it is echoed in the output but the chain
 * is always read directly, so a dry run never depends on the API being up.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BaseError,
  createWalletClient,
  encodeFunctionData,
  formatGwei,
  getAddress,
  http,
  isAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DOMAIN_BINDING } from "@tapeci/config";
import { bindingAbi, containerAbi, createReadClient, xLayerChain } from "@tapeci/chain";
import {
  bindDecision,
  formatOkb,
  planBind,
  validateMonths,
  validateOnChainName,
  type BindDecision,
} from "@tapeci/deployer";

const USAGE =
  "usage: pnpm bind:domain -- --container 0x… --name <name> [--months 1] [--api URL] [--send] [--rpc URL]";

const DEFAULT_API = process.env.TAPECI_PUBLIC_API_URL ?? "http://127.0.0.1:8787";
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

interface CliArgs {
  readonly container: Address;
  readonly name: string;
  readonly months: number;
  readonly api: string;
  readonly send: boolean;
  readonly rpc: string | undefined;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(1);
}

function parseArgs(argv: readonly string[]): CliArgs {
  const containerArg = arg("--container");
  const nameArg = arg("--name");
  if (containerArg === undefined) fail(`--container is required\n${USAGE}`);
  if (nameArg === undefined) fail(`--name is required\n${USAGE}`);
  if (!isAddress(containerArg)) fail(`--container is not a valid address: ${containerArg}`);
  const name = nameArg.trim();
  const nameCheck = validateOnChainName(name);
  if (!nameCheck.ok) fail(`invalid --name: ${nameCheck.reason}`);
  const monthsArg = arg("--months") ?? "1";
  const months = Number(monthsArg);
  const monthsCheck = validateMonths(months);
  if (!monthsCheck.ok) fail(`invalid --months: ${monthsCheck.reason}`);
  const api = arg("--api") ?? DEFAULT_API;
  if (!/^https?:\/\//u.test(api)) fail(`--api must be an http(s) URL, got ${api}`);
  const rpc = arg("--rpc");
  if (argv.includes("--send") && rpc !== undefined) {
    fail("--rpc may not be combined with --send: the send path uses the canonical X Layer RPC");
  }
  return { container: getAddress(containerArg), name, months, api, send: argv.includes("--send"), rpc };
}

/** Reads `KEY=value` lines; quoted values are JSON-decoded. Never prints values. */
async function loadEnvFile(path: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value) as string;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function shortError(error: unknown): string {
  return error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
}

const args = parseArgs(process.argv.slice(2));
const rpc = args.rpc ?? xLayerChain.rpcUrls.default.http[0] ?? "https://rpc.xlayer.tech";
const client = createReadClient(rpc);

// --------------------------------------------------------------------------
// 1. Activation state and fee, read live.
// --------------------------------------------------------------------------
const nameHash = keccak256(toHex(args.name));
const [monthlyFeeWei, isLive, isContainerLive, containerPaidUntilRaw, namePaidUntilRaw, ownerRaw, gasPriceWei, blockNumber] =
  await Promise.all([
    client.readContract({ address: DOMAIN_BINDING, abi: bindingAbi, functionName: "monthlyFee" }),
    client.readContract({
      address: DOMAIN_BINDING,
      abi: bindingAbi,
      functionName: "isLive",
      args: [args.name, args.container],
    }),
    client.readContract({
      address: DOMAIN_BINDING,
      abi: bindingAbi,
      functionName: "isContainerLive",
      args: [args.container],
    }),
    client.readContract({
      address: DOMAIN_BINDING,
      abi: bindingAbi,
      functionName: "containerPaidUntil",
      args: [args.container],
    }),
    client.readContract({
      address: DOMAIN_BINDING,
      abi: bindingAbi,
      functionName: "paidUntil",
      args: [nameHash, args.container],
    }),
    client.readContract({ address: args.container, abi: containerAbi, functionName: "owner" }),
    client.getGasPrice(),
    client.getBlockNumber({ cacheTime: 0 }),
  ]);

const owner = getAddress(ownerRaw);
const containerPaidUntil = Number(containerPaidUntilRaw);
const namePaidUntil = Number(namePaidUntilRaw);
// DomainBinding keeps two windows: per-name `paidUntil` and per-container
// `containerPaidUntil`. Activation is whichever is later, otherwise a container
// that already paid for another name looks unactivated and gets charged twice.
const effectivePaidUntil = Math.max(containerPaidUntil, namePaidUntil);
const nowSeconds = Math.floor(Date.now() / 1000);
const decision: BindDecision = bindDecision({
  isLive,
  isContainerLive,
  paidUntil: effectivePaidUntil,
  nowSeconds,
});

// --------------------------------------------------------------------------
// 2. Build the exact call, then estimate gas with that value.
// --------------------------------------------------------------------------
const data: Hex = encodeFunctionData({
  abi: bindingAbi,
  functionName: "bind",
  args: [args.name, args.container, BigInt(args.months)],
});
const valueWei = planBind({ name: args.name, months: args.months, monthlyFeeWei, gasPriceWei, estimatedGas: 0n }).valueWei;

let estimatedGas = 0n;
let gasEstimateError: string | null = null;
try {
  estimatedGas = await client.estimateGas({ account: owner, to: DOMAIN_BINDING, data, value: valueWei });
} catch (error) {
  // A dry run stays useful when the estimate reverts (wrong holder, name taken,
  // bad value): report the revert rather than fabricate a number.
  gasEstimateError = shortError(error);
}

const plan = planBind({ name: args.name, months: args.months, monthlyFeeWei, gasPriceWei, estimatedGas });
const base = {
  ok: true,
  mode: args.send ? "send" : "dry-run",
  chainId: 196,
  blockNumber: blockNumber.toString(),
  api: args.api,
  binding: DOMAIN_BINDING,
  name: args.name,
  container: args.container,
  owner,
  sendableAs: owner,
  months: args.months,
  monthlyFeeWei: monthlyFeeWei.toString(),
  monthlyFee: formatOkb(monthlyFeeWei),
  isLive,
  isContainerLive,
  containerPaidUntil,
  containerPaidUntilIso: containerPaidUntil === 0 ? null : new Date(containerPaidUntil * 1000).toISOString(),
  namePaidUntil,
  namePaidUntilIso: namePaidUntil === 0 ? null : new Date(namePaidUntil * 1000).toISOString(),
  effectivePaidUntil,
  nowSeconds,
  decision,
  estimateFrom: owner,
  gasPriceWei: gasPriceWei.toString(),
  gasPriceGwei: formatGwei(gasPriceWei),
  estimatedGas: gasEstimateError === null ? estimatedGas.toString() : null,
  estimatedGasError: gasEstimateError,
  valueWei: plan.valueWei.toString(),
  valueOkb: formatOkb(plan.valueWei),
  estimatedCostWei: plan.estimatedCostWei.toString(),
  estimatedCostOkb: formatOkb(plan.estimatedCostWei),
  call: { to: DOMAIN_BINDING, data, value: plan.valueWei.toString() },
} as const;

if (!args.send) {
  console.error(
    decision === "ALREADY_LIVE"
      ? "note: already live for this container; --send would be a no-op."
      : decision === "RENEW"
        ? "note: an expired record exists for this container; --send renews it."
        : "dry run: nothing was signed or sent. Send call{to,data,value} from the owner wallet, or re-run with --send.",
  );
  console.log(JSON.stringify({ ...base, sent: false }, null, 2));
  process.exit(0);
}

// --------------------------------------------------------------------------
// 3. --send: holder-only pre-check, simulate, send, wait, re-read.
// --------------------------------------------------------------------------
if (!(await loadEnvFile(join(process.cwd(), ".tapeci/operator.env")))) {
  fail("--send requires .tapeci/operator.env (TAPECI_OPERATOR_PRIVATE_KEY)");
}
const privateKey = process.env.TAPECI_OPERATOR_PRIVATE_KEY;
if (privateKey === undefined || !/^0x[0-9a-fA-F]{64}$/u.test(privateKey)) {
  fail("TAPECI_OPERATOR_PRIVATE_KEY is missing or malformed in .tapeci/operator.env");
}
const account = privateKeyToAccount(privateKey as Hex);
const keyAddress = getAddress(account.address);

// bind is holder-only: the signer must be the container's effective owner, read
// fresh on chain (never from an env var or a cached deployment file).
if (owner === ZERO_ADDRESS) {
  fail(`container ${args.container} has no owner on chain; bind is holder-only`);
}
if (keyAddress.toLowerCase() !== owner.toLowerCase()) {
  fail(
    `refusing to send: the operator key address (${keyAddress}) is not the container owner (${owner}); ` +
      "bind is holder-only — send call{to,data,value} from the owner wallet instead.",
  );
}

if (decision === "ALREADY_LIVE") {
  console.log(JSON.stringify({ ...base, sent: false, result: "ALREADY_LIVE", signer: keyAddress }, null, 2));
  process.exit(0);
}
if (gasEstimateError !== null) {
  fail(`simulation failed before sending: ${gasEstimateError}`);
}
try {
  // Simulate with the exact value: a `bind` that would revert never hits the network.
  await client.call({ account: keyAddress, to: DOMAIN_BINDING, data, value: plan.valueWei });
} catch (error) {
  fail(`simulation reverted: ${shortError(error)}`);
}

const walletClient: WalletClient = createWalletClient({
  chain: xLayerChain,
  transport: http(rpc, { retryCount: 2, timeout: 60_000 }),
  account,
});
const txHash = await walletClient.sendTransaction({
  account,
  chain: xLayerChain,
  to: DOMAIN_BINDING,
  data,
  value: plan.valueWei,
  gas: estimatedGas,
});
const receipt = await client.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== "success") {
  fail(`transaction ${txHash} reverted (block ${receipt.blockNumber.toString()})`);
}

// A receipt is not activation: re-read both activation paths after the write.
const [isLiveAfter, isContainerLiveAfter, containerPaidUntilAfter] = await Promise.all([
  client.readContract({
    address: DOMAIN_BINDING,
    abi: bindingAbi,
    functionName: "isLive",
    args: [args.name, args.container],
  }),
  client.readContract({
    address: DOMAIN_BINDING,
    abi: bindingAbi,
    functionName: "isContainerLive",
    args: [args.container],
  }),
  client.readContract({
    address: DOMAIN_BINDING,
    abi: bindingAbi,
    functionName: "containerPaidUntil",
    args: [args.container],
  }),
]);
const boundLog = receipt.logs.find((log) => log.address.toLowerCase() === DOMAIN_BINDING.toLowerCase());

console.log(
  JSON.stringify(
    {
      ...base,
      sent: true,
      signer: keyAddress,
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPriceWei: receipt.effectiveGasPrice.toString(),
      actualCostWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      actualCostOkb: formatOkb(receipt.gasUsed * receipt.effectiveGasPrice),
      isLiveAfter,
      isContainerLiveAfter,
      containerPaidUntilAfter: Number(containerPaidUntilAfter),
      boundLog: boundLog === undefined ? null : { topics: boundLog.topics, data: boundLog.data },
    },
    null,
    2,
  ),
);
