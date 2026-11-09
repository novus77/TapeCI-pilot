import { writeFile as writeFileFs } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPublicClient, getAddress, http, type Hex } from "viem";
import { XLAYER_MAINNET, oneEndpointPerOperator } from "@tapeci/config";
import {
  bindingAbi,
  checkImplementation,
  inspectContainer,
  xLayerChain,
} from "@tapeci/chain";
import { TapeCiError, toErrorBody } from "@tapeci/shared";
import { requireRealIntegrationOptIn, errorMessage } from "./common.js";
import { stableEvidenceJson } from "./evidence.js";
import {
  evaluateGatewayEvidence,
  type GatewayObservation,
} from "./gateway.js";
import {
  collectGatewayNetworkObservation,
  collectTransactionObservation,
  type TransactionReader,
} from "./readers.js";
import {
  evaluatePreflightEvidence,
  type PreflightObservation,
} from "./preflight.js";
import {
  evaluateTransactionEvidence,
  type TransactionExpectation,
} from "./transaction.js";

export interface RealIntegrationIo {
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
  readonly writeFile: (path: string, value: string) => Promise<void>;
}

interface BaseArgs {
  readonly out: string | null;
  readonly help: boolean;
  readonly writeActionsPerformed: false;
}

export interface PreflightArgs extends BaseArgs {
  readonly command: "preflight";
  readonly container: string;
  readonly owner: string;
  readonly signer: string;
  readonly budgetCapWei: bigint;
}

export interface TransactionArgs extends BaseArgs {
  readonly command: "transaction";
  readonly hash: Hex;
  readonly from: string;
  readonly to: string;
  readonly valueWei: bigint;
  readonly maxFeeWei: bigint;
  readonly minConfirmations: number;
  readonly balanceBeforeBlock: bigint;
}

export interface GatewayArgs extends BaseArgs {
  readonly command: "gateway";
  readonly domain: string;
  readonly container: string;
  readonly url: string;
  readonly expectedContentSha256: Hex;
}

export type RealIntegrationArgs = PreflightArgs | TransactionArgs | GatewayArgs;

interface OperatorRead<T> {
  readonly value: T | null;
  readonly error: string | null;
}

const FORBIDDEN_FLAGS = new Set(["--send", "--sign", "--transfer", "--write-dns"]);

function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || token === "--") continue;
    if (!token.startsWith("--")) {
      throw new TapeCiError("INVALID_CONFIG", `unexpected positional argument: ${token}`);
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    const name = equals >= 0 ? body.slice(0, equals) : body;
    const flag = `--${name}`;
    if (FORBIDDEN_FLAGS.has(flag)) {
      throw new TapeCiError(
        "INVALID_CONFIG",
        `${flag} is unavailable: this harness is read-only`,
        { details: { writeActionsPerformed: false } },
      );
    }
    if (flags.has(flag)) {
      throw new TapeCiError("INVALID_CONFIG", `duplicate flag ${flag}`);
    }
    const inline = equals >= 0 ? body.slice(equals + 1) : undefined;
    const value = inline ?? argv[index + 1];
    if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
      throw new TapeCiError("INVALID_CONFIG", `missing value for ${flag}`);
    }
    if (inline === undefined) index += 1;
    flags.set(flag, value);
  }
  return flags;
}

function required(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(`--${name}`);
  if (value === undefined) {
    throw new TapeCiError("INVALID_CONFIG", `--${name} is required`);
  }
  return value;
}

function decimal(value: string, field: string, allowZero = false): bigint {
  if (!/^[0-9]+$/u.test(value)) {
    throw new TapeCiError("INVALID_CONFIG", `${field} must be a decimal integer`);
  }
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) {
    throw new TapeCiError("INVALID_CONFIG", `${field} must be greater than zero`);
  }
  return parsed;
}

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TapeCiError("INVALID_CONFIG", `${field} must be a positive integer`);
  }
  return parsed;
}

function address(value: string, field: string): string {
  try {
    return getAddress(value);
  } catch {
    throw new TapeCiError("INVALID_CONFIG", `${field} must be a 20-byte hex address`);
  }
}

function hash(value: string, field: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new TapeCiError("INVALID_CONFIG", `${field} must be a 32-byte hex value`);
  }
  return value.toLowerCase() as Hex;
}

function httpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TapeCiError("INVALID_CONFIG", "url must be absolute");
  }
  if (url.protocol !== "https:") {
    throw new TapeCiError("INVALID_CONFIG", "url must use HTTPS");
  }
  return value;
}

export function parseRealIntegrationArgs(argv: readonly string[]): RealIntegrationArgs {
  const command = argv[0];
  if (command !== "preflight" && command !== "transaction" && command !== "gateway") {
    throw new TapeCiError(
      "INVALID_CONFIG",
      "command must be preflight, transaction, or gateway",
    );
  }
  const flags = parseFlags(argv.slice(1));
  const common = {
    out: flags.get("--out") ?? null,
    help: flags.has("--help"),
    writeActionsPerformed: false as const,
  };
  if (command === "preflight") {
    const signer = address(required(flags, "signer"), "signer");
    return {
      command,
      ...common,
      container: address(required(flags, "container"), "container"),
      owner: address(required(flags, "owner"), "owner"),
      signer,
      budgetCapWei: decimal(required(flags, "budget-cap-wei"), "budget-cap-wei"),
    };
  }
  if (command === "transaction") {
    return {
      command,
      ...common,
      hash: hash(required(flags, "hash"), "hash"),
      from: address(required(flags, "from"), "from"),
      to: address(required(flags, "to"), "to"),
      valueWei: decimal(flags.get("--value-wei") ?? "0", "value-wei", true),
      maxFeeWei: decimal(required(flags, "max-fee-wei"), "max-fee-wei"),
      minConfirmations: positiveInteger(
        flags.get("--min-confirmations") ?? "2",
        "min-confirmations",
      ),
      balanceBeforeBlock: decimal(
        required(flags, "balance-before-block"),
        "balance-before-block",
      ),
    };
  }
  return {
    command,
    ...common,
    domain: required(flags, "domain"),
    container: address(required(flags, "container"), "container"),
    url: httpsUrl(required(flags, "url")),
    expectedContentSha256: hash(
      required(flags, "expected-content-sha256"),
      "expected-content-sha256",
    ),
  };
}

function rpcReaders(): TransactionReader[] {
  return oneEndpointPerOperator(XLAYER_MAINNET.rpcs).map((endpoint) => ({
    operator: endpoint.operator,
    url: endpoint.url,
    // Read every method independently. Public dRPC rejects oversized JSON-RPC
    // batches, while correctness here matters more than request count.
    client: createPublicClient({
      chain: xLayerChain,
      transport: http(endpoint.url, { retryCount: 2, timeout: 20_000 }),
    }),
  }));
}

/**
 * Read one pinned fact from every operator independently. viem's default batch
 * transport is disabled here because public RPCs enforce different batch limits
 * and one oversized batch would otherwise discard every fact for that operator.
 */
async function readOnOperators<T>(
  readers: readonly TransactionReader[],
  read: (reader: TransactionReader) => Promise<T>,
): Promise<OperatorRead<T>[]> {
  return Promise.all(
    readers.map(async (reader) => {
      try {
        return { value: await read(reader), error: null };
      } catch (error) {
        return { value: null, error: errorMessage(error) };
      }
    }),
  );
}

async function preflightEvidence(args: PreflightArgs) {
  const readers = rpcReaders();
  const heads = await Promise.all(
    readers.map(async (reader) => ({
      reader,
      head: await reader.client.getBlockNumber({ cacheTime: 0 }),
    })),
  );
  const sorted = heads.map((entry) => entry.head).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const secondHighest = sorted[1];
  if (secondHighest === undefined) {
    throw new TapeCiError("RPC_DISAGREEMENT", "two RPC heads are required");
  }
  const pinnedBlock = secondHighest - BigInt(XLAYER_MAINNET.pin.offset);
  if (pinnedBlock <= 0n) throw new TapeCiError("RPC_DISAGREEMENT", "pin is not positive");

  const observations = await Promise.all(
    heads.map(async ({ reader, head }): Promise<PreflightObservation> => {
      const [chainId, block, inspection, signerBalanceWei, gasPriceWei] = await Promise.all([
        readOnOperators([reader], ({ client }) => client.getChainId()).then(([result]) => result),
        readOnOperators([reader], ({ client }) =>
          client.getBlock({ blockNumber: pinnedBlock }),
        ).then(([result]) => result),
        readOnOperators([reader], ({ client }) =>
          inspectContainer(client, XLAYER_MAINNET, args.container as Hex, pinnedBlock),
        ).then(([result]) => result),
        readOnOperators([reader], ({ client }) =>
          client.getBalance({ address: args.signer as Hex, blockNumber: pinnedBlock }),
        ).then(([result]) => result),
        readOnOperators([reader], ({ client }) => client.getGasPrice()).then(([result]) => result),
      ]);
      const errors = [
        chainId?.error,
        block?.error,
        inspection?.error,
        signerBalanceWei?.error,
        gasPriceWei?.error,
      ].filter((error): error is string => error !== null && error !== undefined);
      const observedInspection = inspection?.value ?? null;
      return {
        operator: reader.operator,
        rpcHost: new URL(reader.url).hostname,
        chainId: chainId?.value ?? -1,
        head,
        pinnedBlock,
        blockHash: block?.value?.hash ?? `0x${"00".repeat(32)}`,
        gasPriceWei: gasPriceWei?.value ?? 0n,
        signerBalanceWei: signerBalanceWei?.value ?? 0n,
        container: {
          address: observedInspection?.container ?? args.container,
          tokenChainId: observedInspection?.tokenChainId ?? -1n,
          derivedMatches: observedInspection?.derivedMatches ?? false,
          isProcessor: observedInspection?.isProcessor ?? false,
          owner: observedInspection?.owner ?? null,
          // `null` on a failed read; a preflight that cannot read must not look "not opened".
          opened: observedInspection?.opened ?? null,
          readStatus: observedInspection?.readStatus ?? "unavailable",
        },
        error: errors.length === 0 ? null : errors.join("; "),
      };
    }),
  );
  return evaluatePreflightEvidence(observations, {
    chainId: XLAYER_MAINNET.chainId,
    container: args.container,
    owner: args.owner,
    signer: args.signer,
    budgetCapWei: args.budgetCapWei,
  });
}

async function transactionEvidence(args: TransactionArgs) {
  const observations = await Promise.all(
    rpcReaders().map((reader) =>
      collectTransactionObservation(reader, {
        chainId: XLAYER_MAINNET.chainId,
        hash: args.hash,
        from: args.from,
        to: args.to,
        valueWei: args.valueWei,
        balanceBeforeBlock: args.balanceBeforeBlock,
      }),
    ),
  );
  return evaluateTransactionEvidence(observations, {
    chainId: XLAYER_MAINNET.chainId,
    hash: args.hash,
    from: args.from as Hex,
    to: args.to as Hex,
    maxFeeWei: args.maxFeeWei,
    minConfirmations: args.minConfirmations,
  } satisfies TransactionExpectation);
}

async function chainGatewayObservations(
  readers: readonly TransactionReader[],
  args: GatewayArgs,
): Promise<GatewayObservation["chain"]> {
  const heads = await Promise.all(
    readers.map(async (reader) => ({
      reader,
      head: await reader.client.getBlockNumber({ cacheTime: 0 }),
    })),
  );
  const sorted = heads.map((entry) => entry.head).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const secondHighest = sorted[1];
  if (secondHighest === undefined) {
    throw new TapeCiError("RPC_DISAGREEMENT", "two RPC heads are required");
  }
  const pinnedBlock = secondHighest - BigInt(XLAYER_MAINNET.pin.offset);
  return Promise.all(
    heads.map(async ({ reader }): Promise<GatewayObservation["chain"][number]> => {
      const [chainId, block, implementation, isLive, isContainerLive, paidUntilUnix] =
        await Promise.all([
          readOnOperators([reader], ({ client }) => client.getChainId()).then(([result]) => result),
          readOnOperators([reader], ({ client }) =>
            client.getBlock({ blockNumber: pinnedBlock }),
          ).then(([result]) => result),
          readOnOperators([reader], ({ client }) =>
            checkImplementation(
              client,
              XLAYER_MAINNET.allowlist.find((entry) => entry.role === "domainBinding")!,
              pinnedBlock,
            ),
          ).then(([result]) => result),
          readOnOperators([reader], ({ client }) =>
            client.readContract({
              address: XLAYER_MAINNET.binding,
              abi: bindingAbi,
              functionName: "isLive",
              args: [args.domain, args.container as Hex],
              blockNumber: pinnedBlock,
            }),
          ).then(([result]) => result),
          readOnOperators([reader], ({ client }) =>
            client.readContract({
              address: XLAYER_MAINNET.binding,
              abi: bindingAbi,
              functionName: "isContainerLive",
              args: [args.container as Hex],
              blockNumber: pinnedBlock,
            }),
          ).then(([result]) => result),
          readOnOperators([reader], ({ client }) =>
            client.readContract({
              address: XLAYER_MAINNET.binding,
              abi: bindingAbi,
              functionName: "containerPaidUntil",
              args: [args.container as Hex],
              blockNumber: pinnedBlock,
            }),
          ).then(([result]) => result),
        ]);
      const errors = [
        chainId?.error,
        block?.error,
        implementation?.error,
        isLive?.error,
        isContainerLive?.error,
        paidUntilUnix?.error,
      ].filter((error): error is string => error !== null && error !== undefined);
      if (implementation?.value !== null && implementation?.value !== undefined) {
        if (!implementation.value.allowlisted) errors.push("DomainBinding implementation not allowlisted");
      }
      return {
        operator: reader.operator,
        rpcHost: new URL(reader.url).hostname,
        chainId: chainId?.value ?? -1,
        pinnedBlock,
        blockHash: block?.value?.hash ?? `0x${"00".repeat(32)}`,
        isLive: isLive?.value ?? false,
        isContainerLive: isContainerLive?.value ?? false,
        paidUntilUnix: BigInt(paidUntilUnix?.value ?? 0n),
        error: errors.length === 0 ? null : errors.join("; "),
      };
    }),
  );
}

async function gatewayEvidence(args: GatewayArgs) {
  const readers = rpcReaders();
  const [chain, network] = await Promise.all([
    chainGatewayObservations(readers, args),
    collectGatewayNetworkObservation(args.url),
  ]);
  return evaluateGatewayEvidence(
    {
      chain,
      dns: network.dns,
      tls: network.tls,
      http: network.http,
    },
    {
      chainId: XLAYER_MAINNET.chainId,
      domain: args.domain,
      container: args.container,
      url: args.url,
      expectedContentSha256: args.expectedContentSha256,
      now: new Date(),
    },
  );
}

function usage(): string {
  return [
    "TapeCI real integration evidence (READ ONLY)",
    "",
    "Set TAPECI_REAL_INTEGRATION=1 before any network access.",
    "",
    "  preflight --container 0x... --owner 0x... --signer 0x... --budget-cap-wei N [--out file]",
    "  transaction --hash 0x... --from 0x... --to 0x... --max-fee-wei N",
    "              --balance-before-block N [--value-wei N] [--min-confirmations N] [--out file]",
    "  gateway --domain 10.2.4.tape --container 0x... --url https://...",
    "          --expected-content-sha256 0x... [--out file]",
    "",
    "This command never accepts signing keys and has no send, transfer, or DNS-write path.",
  ].join("\n");
}

const defaultIo: RealIntegrationIo = {
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
  writeFile: async (path, value) => writeFileFs(path, value, "utf8"),
};

export async function runRealIntegrationCommand(
  argv: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly io?: RealIntegrationIo;
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? defaultIo;
  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      io.writeStdout(`${usage()}\n`);
      return 0;
    }
    requireRealIntegrationOptIn(env);
    const args = parseRealIntegrationArgs(argv);
    const evidence =
      args.command === "preflight"
        ? await preflightEvidence(args)
        : args.command === "transaction"
          ? await transactionEvidence(args)
          : await gatewayEvidence(args);
    const json = `${stableEvidenceJson(evidence)}\n`;
    io.writeStdout(json);
    if (args.out !== null) await io.writeFile(args.out, json);
    return evidence.status === "VERIFIED" || evidence.status === "READY" ? 0 : 1;
  } catch (error) {
    io.writeStderr(`${JSON.stringify(toErrorBody(error), null, 2)}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runRealIntegrationCommand(process.argv.slice(2));
}
