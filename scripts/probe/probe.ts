/**
 * TapeCI P0-01/P0-02/P0-03 evidence collector — READ ONLY.
 *
 * Pins one X Layer block, then:
 *  1. runs `probeChain()` (packages/chain) against the primary OKX endpoint;
 *  2. re-reads every asserted fact from a second independent RPC operator (dRPC)
 *     and from the remaining configured endpoints, at the same pinned block;
 *  3. collects ERC-1967 implementation slots, proxy/implementation bytecode
 *     (size + keccak256), live read-call return values, and `eth_call`
 *     simulations of the candidate write ABI from the container holder and from
 *     a non-editor address;
 *  4. writes machine-readable evidence to `docs/evidence/chain-probe.json`.
 *
 * This script never calls `eth_sendTransaction`/`eth_sendRawTransaction` and
 * never touches a private key: the only write-path checks are `eth_call`
 * simulations executed against a fixed historical state (nothing is persisted).
 *
 * Usage:
 *   corepack pnpm probe                  # pin (min head per operator) - 2
 *   corepack pnpm probe -- --block 123   # pin an explicit block
 *   corepack pnpm probe -- --block 123 --allow-stale --out /tmp/probe.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  toFunctionSelector,
  type Hex,
} from "viem";
import {
  IMPL_SLOT,
  OBSERVED_XLAYER_SITE,
  TAPEKIT_SOURCE,
  XLAYER_MAINNET,
  oneEndpointPerOperator,
  resolveRpcEndpoints,
} from "@tapeci/config";
import {
  ALL_SIGNATURES,
  READ_SIGNATURES,
  SELECTORS,
  TAPEKIT_KNOWN_SELECTORS,
  WRITE_SIGNATURES,
  bindingAbi,
  checkAllImplementations,
  checkSelectorsInBytecode,
  containerAbi,
  createReadClient,
  factoryAbi,
  keccakHex,
  openerAbi,
  probeChain,
  probeToJson,
  processorAbi,
  readFileBytesAt,
  readImplementationSlot,
  siteRegistryAbi,
  type ReadClient,
} from "@tapeci/chain";
import { bytesToHex, sha256Hex, type Hex as SharedHex } from "@tapeci/shared";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUT = resolve(REPO_ROOT, "docs/evidence/chain-probe.json");

/** Deterministic address that holds no X Layer role; used as `msg.sender` for negative write tests. */
const NON_EDITOR = "0x000000000000000000000000000000000000bEEF" as const;
const PROBE_PATH = "probe/p0-03-abi.txt";
const LIVE_PATH = OBSERVED_XLAYER_SITE.path;

const toBlockTag = (blockNumber: bigint): Hex => `0x${blockNumber.toString(16)}`;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/\s+/g, " ").slice(0, 500);
  return String(error).slice(0, 500);
}

interface RawCall {
  readonly ok: boolean;
  readonly raw: Hex | null;
  readonly revertData: Hex | null;
  readonly error: string | null;
}

/**
 * `eth_call` against a fixed block. `from` is optional; the revert payload is
 * forwarded verbatim so custom-error selectors can be compared with recomputed
 * keccak256 signatures.
 */
async function ethCall(
  client: ReadClient,
  to: SharedHex,
  data: SharedHex,
  blockNumber: bigint,
  from?: SharedHex,
): Promise<RawCall> {
  const call = from === undefined ? { to, data } : { from, to, data };
  try {
    const result: unknown = await client.request({
      method: "eth_call",
      params: [call, toBlockTag(blockNumber)],
    });
    return {
      ok: true,
      raw: typeof result === "string" ? (result as SharedHex) : null,
      revertData: null,
      error: null,
    };
  } catch (error) {
    const record = error as { data?: unknown };
    const revertData =
      typeof record.data === "string" && /^0x[0-9a-fA-F]*$/.test(record.data)
        ? (record.data as SharedHex)
        : null;
    return { ok: false, raw: null, revertData, error: errorMessage(error) };
  }
}

interface CodeObservation {
  readonly codeSizeBytes: number;
  readonly keccak256: SharedHex | null;
}

async function readCode(
  client: ReadClient,
  address: SharedHex,
  blockNumber: bigint,
): Promise<CodeObservation> {
  const code = await client.getCode({ address, blockNumber });
  if (code === undefined || code === "0x") return { codeSizeBytes: 0, keccak256: null };
  return { codeSizeBytes: (code.length - 2) / 2, keccak256: keccak256(code) };
}

/* -------------------------------------------------------------------------- */
/* Pinned block resolution                                                     */
/* -------------------------------------------------------------------------- */

interface EndpointHead {
  readonly url: string;
  readonly operator: string;
  readonly head: bigint | null;
  readonly error: string | null;
}

async function readHead(client: ReadClient): Promise<bigint> {
  return client.getBlockNumber();
}

function assertDistinctOperators(
  endpoints: readonly { readonly operator: string; readonly url: string }[],
): string[] {
  const operators = [...new Set(endpoints.map((endpoint) => endpoint.operator))];
  if (operators.length < 2) {
    throw new Error(
      `need at least two independent RPC operators, configured: ${operators.join(", ") || "none"}`,
    );
  }
  return operators;
}

/** One head per configured endpoint; a failing endpoint is recorded, not fatal on its own. */
async function readAllHeads(
  endpoints: readonly { readonly url: string; readonly operator: string }[],
  clients: ReadonlyMap<string, ReadClient>,
): Promise<EndpointHead[]> {
  const results = await Promise.all(
    endpoints.map(async (endpoint) => {
      const client = clients.get(endpoint.url);
      if (client === undefined) {
        return { url: endpoint.url, operator: endpoint.operator, head: null, error: "no client" };
      }
      try {
        return {
          url: endpoint.url,
          operator: endpoint.operator,
          head: await readHead(client),
          error: null,
        };
      } catch (error) {
        return {
          url: endpoint.url,
          operator: endpoint.operator,
          head: null,
          error: errorMessage(error),
        };
      }
    }),
  );
  return results;
}

interface PinDecision {
  readonly pinnedBlock: bigint;
  readonly mode: "explicit" | "latest";
  /** Lowest head per required operator; a block above this is not readable everywhere. */
  readonly operatorBases: ReadonlyMap<string, bigint>;
  readonly highestHead: bigint;
  readonly lagBlocks: bigint;
  readonly stale: boolean;
}

function resolvePin(
  heads: readonly EndpointHead[],
  operators: readonly string[],
  explicitBlock: bigint | null,
  allowStale: boolean,
): PinDecision {
  const perOperator = new Map<string, bigint[]>();
  for (const operator of operators) perOperator.set(operator, []);
  for (const head of heads) {
    if (head.head === null) continue;
    perOperator.get(head.operator)?.push(head.head);
  }
  const operatorBases = new Map<string, bigint>();
  for (const operator of operators) {
    const values = perOperator.get(operator) ?? [];
    if (values.length === 0) {
      throw new Error(
        `no RPC endpoint answered for operator "${operator}"; cannot pin a cross-operator block`,
      );
    }
    operatorBases.set(operator, values.reduce((min, head) => (head < min ? head : min)));
  }
  const highestHead = heads.reduce(
    (max, head) => (head.head !== null && head.head > max ? head.head : max),
    0n,
  );
  const commonHead = [...operatorBases.values()].reduce((min, head) => (head < min ? head : min));
  const offset = BigInt(XLAYER_MAINNET.pin.offset);
  let pinnedBlock: bigint;
  if (explicitBlock === null) {
    pinnedBlock = commonHead - offset;
    if (pinnedBlock <= 0n) throw new Error(`head ${commonHead} is too low to apply pin offset ${offset}`);
  } else {
    pinnedBlock = explicitBlock;
    if (pinnedBlock > commonHead) {
      throw new Error(
        `requested block ${pinnedBlock} is above the lowest operator head ${commonHead}; not readable from every operator`,
      );
    }
    if (pinnedBlock <= 0n) throw new Error("requested block must be positive");
  }
  const lagBlocks = highestHead - pinnedBlock;
  const maxLag = BigInt(XLAYER_MAINNET.pin.maxLagBlocks);
  const stale = lagBlocks > maxLag;
  if (stale && !allowStale) {
    throw new Error(
      `pinned block ${pinnedBlock} lags the highest head ${highestHead} by ${lagBlocks} blocks > ${maxLag}; pass --allow-stale to record it anyway`,
    );
  }
  return {
    pinnedBlock,
    mode: explicitBlock === null ? "latest" : "explicit",
    operatorBases,
    highestHead,
    lagBlocks,
    stale,
  };
}

/* -------------------------------------------------------------------------- */
/* Selector evidence                                                           */
/* -------------------------------------------------------------------------- */

const SITE_REGISTRY_READ_SIGNATURES = {
  fileInfo: READ_SIGNATURES.fileInfo,
  read: READ_SIGNATURES.read,
  readRange: READ_SIGNATURES.readRange,
  pathCount: READ_SIGNATURES.pathCount,
  pathsRange: READ_SIGNATURES.pathsRange,
  paths: READ_SIGNATURES.paths,
  fallbackPath: READ_SIGNATURES.fallbackPath,
  isOpenedContainer: READ_SIGNATURES.isOpenedContainer,
  chunkMax: READ_SIGNATURES.chunkMax,
} as const;

const FACTORY_SIGNATURES = {
  cpuCount: READ_SIGNATURES.cpuCount,
  cpuAt: READ_SIGNATURES.cpuAt,
  cpus: READ_SIGNATURES.cpus,
  isCPU: READ_SIGNATURES.isCPU,
  isSealed: "isSealed()",
} as const;

const OPENER_SIGNATURES = {
  accountOf: READ_SIGNATURES.accountOf,
  isOpened: READ_SIGNATURES.isOpened,
  isDeployed: READ_SIGNATURES.isDeployed,
  open: READ_SIGNATURES.open,
  fee: "FEE()",
} as const;

const BINDING_SIGNATURES = {
  isLive: READ_SIGNATURES.isLive,
  isContainerLive: READ_SIGNATURES.isContainerLive,
  paidUntil: READ_SIGNATURES.paidUntil,
  containerPaidUntil: READ_SIGNATURES.containerPaidUntil,
  monthlyFee: READ_SIGNATURES.monthlyFee,
} as const;

/**
 * Custom errors observed in `eth_call` reverts, matched by recomputing their
 * selectors with viem. The names come from the ABI shape inferred from live
 * behaviour (see docs/abi-validation.md); this is evidence, not a published ABI.
 */
const KNOWN_ERROR_SIGNATURES = [
  "NotOwner()",
  "BadIndex()",
  "NoSuchFile()",
  "TooLarge()",
] as const;

const KNOWN_ERRORS: ReadonlyMap<Hex, string> = new Map(
  KNOWN_ERROR_SIGNATURES.map((signature) => [toFunctionSelector(signature), signature]),
);

function decodeRevert(revertData: Hex | null): { signature: string; selector: Hex } | null {
  if (revertData === null || revertData === "0x") return null;
  const selector = revertData.slice(0, 10).toLowerCase() as Hex;
  const signature = KNOWN_ERRORS.get(selector);
  return signature === undefined ? null : { signature, selector };
}

function recomputedSelectorTable(): {
  readonly tapekitHardcoded: readonly {
    readonly name: string;
    readonly signature: string;
    readonly hardcoded: string;
    readonly recomputed: string;
    readonly matches: boolean;
  }[];
  readonly allSignatures: readonly {
    readonly name: string;
    readonly signature: string;
    readonly selector: string;
    readonly tapekitHardcoded: string | null;
  }[];
} {
  const tapekitHardcoded = Object.entries(TAPEKIT_KNOWN_SELECTORS).map(([name, hardcoded]) => {
    const signature = ALL_SIGNATURES[name as keyof typeof ALL_SIGNATURES];
    if (signature === undefined) throw new Error(`signature missing for TapeKit selector ${name}`);
    const recomputed = toFunctionSelector(signature);
    return { name, signature, hardcoded, recomputed, matches: recomputed === hardcoded };
  });
  const allSignatures = Object.entries(ALL_SIGNATURES).map(([name, signature]) => ({
    name,
    signature,
    selector: SELECTORS[name as keyof typeof SELECTORS],
    tapekitHardcoded: TAPEKIT_KNOWN_SELECTORS[name] ?? null,
  }));
  return { tapekitHardcoded, allSignatures };
}

/* -------------------------------------------------------------------------- */
/* Live read calls                                                             */
/* -------------------------------------------------------------------------- */

interface RawRead {
  readonly name: string;
  readonly to: SharedHex;
  readonly calldata: SharedHex;
  readonly selector: string;
  readonly ok: boolean;
  readonly raw: SharedHex | null;
  readonly revertData: SharedHex | null;
  readonly error: string | null;
}

async function rawRead(
  client: ReadClient,
  name: string,
  to: SharedHex,
  data: SharedHex,
  blockNumber: bigint,
): Promise<RawRead> {
  const call = await ethCall(client, to, data, blockNumber);
  return {
    name,
    to,
    calldata: data,
    selector: data.slice(0, 10),
    ...call,
  };
}

/* -------------------------------------------------------------------------- */
/* Cross-operator facts                                                        */
/* -------------------------------------------------------------------------- */

interface FactSpec {
  readonly id: string;
  readonly description: string;
  readonly read: (client: ReadClient) => Promise<string>;
}

interface FactObservation {
  readonly url: string;
  readonly operator: string;
  readonly value: string | null;
  readonly error: string | null;
}

interface FactResult {
  readonly id: string;
  readonly description: string;
  readonly observations: readonly FactObservation[];
  readonly operatorValues: readonly {
    readonly operator: string;
    readonly values: readonly string[];
  }[];
  readonly distinctValues: readonly string[];
  readonly status: "AGREE" | "DISAGREE" | "INCOMPLETE";
}

function buildFactSpecs(
  pinnedBlock: bigint,
  container: SharedHex,
  registry: SharedHex,
  processor: SharedHex,
  fileInfoCalldata: SharedHex,
  tokenCalldata: SharedHex,
  liveName: string,
): FactSpec[] {
  return [
    {
      id: "pinnedBlockHash",
      description: "block hash of the pinned block",
      read: async (client) => (await client.getBlock({ blockNumber: pinnedBlock })).hash,
    },
    {
      id: "chainId",
      description: "eth_chainId",
      read: async (client) => String(await client.getChainId()),
    },
    {
      id: "implementation.factory",
      description: `ERC-1967 slot ${IMPL_SLOT} on the factory proxy`,
      read: async (client) =>
        (await readImplementationSlot(client, XLAYER_MAINNET.factory, pinnedBlock)).toLowerCase(),
    },
    {
      id: "implementation.siteRegistry",
      description: `ERC-1967 slot ${IMPL_SLOT} on the SiteRegistry proxy`,
      read: async (client) =>
        (await readImplementationSlot(client, registry, pinnedBlock)).toLowerCase(),
    },
    {
      id: "implementation.domainBinding",
      description: `ERC-1967 slot ${IMPL_SLOT} on the DomainBinding proxy`,
      read: async (client) =>
        (await readImplementationSlot(client, XLAYER_MAINNET.binding, pinnedBlock)).toLowerCase(),
    },
    {
      id: "codeKeccak.factoryImplementation",
      description: "keccak256(bytecode) of the factory implementation",
      read: async (client) => {
        const entry = XLAYER_MAINNET.allowlist.find((item) => item.role === "factory");
        if (entry === undefined) throw new Error("factory allowlist entry missing");
        const impl = await readImplementationSlot(client, entry.proxy, pinnedBlock);
        const code = await readCode(client, impl, pinnedBlock);
        return code.keccak256 ?? "0x";
      },
    },
    {
      id: "codeKeccak.siteRegistryImplementation",
      description: "keccak256(bytecode) of the SiteRegistry implementation",
      read: async (client) => {
        const impl = await readImplementationSlot(client, registry, pinnedBlock);
        const code = await readCode(client, impl, pinnedBlock);
        return code.keccak256 ?? "0x";
      },
    },
    {
      id: "codeKeccak.domainBindingImplementation",
      description: "keccak256(bytecode) of the DomainBinding implementation",
      read: async (client) => {
        const impl = await readImplementationSlot(client, XLAYER_MAINNET.binding, pinnedBlock);
        const code = await readCode(client, impl, pinnedBlock);
        return code.keccak256 ?? "0x";
      },
    },
    {
      id: "codeKeccak.opener",
      description: "keccak256(bytecode) of the (non-proxy) Opener",
      read: async (client) => {
        const code = await readCode(client, XLAYER_MAINNET.opener, pinnedBlock);
        return code.keccak256 ?? "0x";
      },
    },
    {
      id: "factory.cpuCount",
      description: "factory.cpuCount()",
      read: async (client) =>
        String(
          await client.readContract({
            address: XLAYER_MAINNET.factory,
            abi: factoryAbi,
            functionName: "cpuCount",
            blockNumber: pinnedBlock,
          }),
        ),
    },
    {
      id: "factory.isSealed",
      description: "factory.isSealed()",
      read: async (client) =>
        String(
          await client.readContract({
            address: XLAYER_MAINNET.factory,
            abi: factoryAbi,
            functionName: "isSealed",
            blockNumber: pinnedBlock,
          }),
        ),
    },
    {
      id: "factory.cpuAt0",
      description: "factory.cpuAt(0)",
      read: async (client) =>
        getAddress(
          await client.readContract({
            address: XLAYER_MAINNET.factory,
            abi: factoryAbi,
            functionName: "cpuAt",
            args: [0n],
            blockNumber: pinnedBlock,
          }),
        ).toLowerCase(),
    },
    {
      id: "opener.FEE",
      description: "opener.FEE()",
      read: async (client) =>
        String(
          await client.readContract({
            address: XLAYER_MAINNET.opener,
            abi: openerAbi,
            functionName: "FEE",
            blockNumber: pinnedBlock,
          }),
        ),
    },
    {
      id: "opener.accountOf(0,2)",
      description: "opener.accountOf(processor, 2)",
      read: async (client) =>
        getAddress(
          await client.readContract({
            address: XLAYER_MAINNET.opener,
            abi: openerAbi,
            functionName: "accountOf",
            args: [processor, 2n],
            blockNumber: pinnedBlock,
          }),
        ).toLowerCase(),
    },
    {
      id: "opener.isOpened(0,2)",
      description: "opener.isOpened(processor, 2)",
      read: async (client) =>
        String(
          await client.readContract({
            address: XLAYER_MAINNET.opener,
            abi: openerAbi,
            functionName: "isOpened",
            args: [processor, 2n],
            blockNumber: pinnedBlock,
          }),
        ),
    },
    {
      id: "binding.monthlyFee",
      description: "DomainBinding.monthlyFee()",
      read: async (client) =>
        String(
          await client.readContract({
            address: XLAYER_MAINNET.binding,
            abi: bindingAbi,
            functionName: "monthlyFee",
            blockNumber: pinnedBlock,
          }),
        ),
    },
    {
      id: "binding.isContainerLive",
      description: `DomainBinding.isContainerLive(${container})`,
      read: async (client) =>
        String(
          await client.readContract({
            address: XLAYER_MAINNET.binding,
            abi: bindingAbi,
            functionName: "isContainerLive",
            args: [container],
            blockNumber: pinnedBlock,
          }),
        ),
    },
    {
      id: "binding.containerPaidUntil",
      description: `DomainBinding.containerPaidUntil(${container})`,
      read: async (client) =>
        String(
          await client.readContract({
            address: XLAYER_MAINNET.binding,
            abi: bindingAbi,
            functionName: "containerPaidUntil",
            args: [container],
            blockNumber: pinnedBlock,
          }),
        ),
    },
    {
      id: "binding.isLive(name,container)",
      description: `DomainBinding.isLive("${liveName}", ${container})`,
      read: async (client) =>
        String(
          await client.readContract({
            address: XLAYER_MAINNET.binding,
            abi: bindingAbi,
            functionName: "isLive",
            args: [liveName, container],
            blockNumber: pinnedBlock,
          }),
        ),
    },
    {
      id: "registry.fileInfoRaw",
      description: `raw eth_call return of fileInfo(${container}, "${LIVE_PATH}")`,
      read: async (client) => {
        const call = await ethCall(client, registry, fileInfoCalldata, pinnedBlock);
        if (!call.ok || call.raw === null) throw new Error(call.error ?? "fileInfo eth_call failed");
        return call.raw;
      },
    },
    {
      id: "registry.pathCount",
      description: `SiteRegistry.pathCount(${container})`,
      read: async (client) =>
        String(
          await client.readContract({
            address: registry,
            abi: siteRegistryAbi,
            functionName: "pathCount",
            args: [container],
            blockNumber: pinnedBlock,
          }),
        ),
    },
    {
      id: "registry.fallbackPath",
      description: `SiteRegistry.fallbackPath(${container})`,
      read: async (client) =>
        await client.readContract({
          address: registry,
          abi: siteRegistryAbi,
          functionName: "fallbackPath",
          args: [container],
          blockNumber: pinnedBlock,
        }),
    },
    {
      id: "registry.isOpenedContainer",
      description: `SiteRegistry.isOpenedContainer(${container})`,
      read: async (client) =>
        String(
          await client.readContract({
            address: registry,
            abi: siteRegistryAbi,
            functionName: "isOpenedContainer",
            args: [container],
            blockNumber: pinnedBlock,
          }),
        ),
    },
    {
      id: "registry.fileBytesSha256",
      description: `SHA-256 of read(${container}, "${LIVE_PATH}") bytes`,
      read: async (client) => {
        const file = await readFileBytesAt(client, registry, container, LIVE_PATH, {
          blockNumber: pinnedBlock,
        });
        return file.actualSha256;
      },
    },
    {
      id: "container.tokenRaw",
      description: `raw eth_call return of container.token()`,
      read: async (client) => {
        const call = await ethCall(client, container, tokenCalldata, pinnedBlock);
        if (!call.ok || call.raw === null) throw new Error(call.error ?? "token eth_call failed");
        return call.raw;
      },
    },
    {
      id: "container.owner",
      description: `container.owner()`,
      read: async (client) =>
        getAddress(
          await client.readContract({
            address: container,
            abi: containerAbi,
            functionName: "owner",
            blockNumber: pinnedBlock,
          }),
        ).toLowerCase(),
    },
    {
      id: "processor.ownerOf2",
      description: `processor.ownerOf(2)`,
      read: async (client) =>
        getAddress(
          await client.readContract({
            address: processor,
            abi: processorAbi,
            functionName: "ownerOf",
            args: [2n],
            blockNumber: pinnedBlock,
          }),
        ).toLowerCase(),
    },
  ];
}

async function collectFacts(
  client: ReadClient,
  specs: readonly FactSpec[],
): Promise<ReadonlyMap<string, { value: string | null; error: string | null }>> {
  const results = new Map<string, { value: string | null; error: string | null }>();
  const GROUP = 3; // stay below dRPC's batch limit of 3
  for (let index = 0; index < specs.length; index += GROUP) {
    const group = specs.slice(index, index + GROUP);
    await Promise.all(
      group.map(async (spec) => {
        try {
          results.set(spec.id, { value: await spec.read(client), error: null });
        } catch (error) {
          results.set(spec.id, { value: null, error: errorMessage(error) });
        }
      }),
    );
  }
  return results;
}

function summariseFacts(
  specs: readonly FactSpec[],
  operators: readonly string[],
  perEndpoint: readonly { readonly url: string; readonly operator: string; readonly facts: ReadonlyMap<string, { value: string | null; error: string | null }> }[],
): {
  readonly facts: readonly FactResult[];
  readonly status: "AGREED" | "DISAGREE" | "INCOMPLETE";
} {
  const facts = specs.map((spec): FactResult => {
    const observations: FactObservation[] = perEndpoint.map((endpoint) => {
      const fact = endpoint.facts.get(spec.id);
      return {
        url: endpoint.url,
        operator: endpoint.operator,
        value: fact?.value ?? null,
        error: fact?.error ?? "not read",
      };
    });
    const operatorValues = operators.map((operator) => ({
      operator,
      values: [
        ...new Set(
          observations
            .filter(
              (observation) =>
                observation.operator === operator && observation.value !== null,
            )
            .map((observation) => observation.value as string),
        ),
      ],
    }));
    const distinctValues = [...new Set(observations.flatMap((o) => (o.value === null ? [] : [o.value])))];
    const hasDisagreement =
      operatorValues.some((entry) => entry.values.length > 1) ||
      operatorValues.filter((entry) => entry.values.length > 0).length > 1 &&
        new Set(operatorValues.flatMap((entry) => entry.values)).size > 1;
    const missingOperator = operatorValues.some((entry) => entry.values.length === 0);
    const status: FactResult["status"] = hasDisagreement
      ? "DISAGREE"
      : missingOperator
        ? "INCOMPLETE"
        : "AGREE";
    return { id: spec.id, description: spec.description, observations, operatorValues, distinctValues, status };
  });
  const status = facts.some((fact) => fact.status === "DISAGREE")
    ? "DISAGREE"
    : facts.some((fact) => fact.status === "INCOMPLETE")
      ? "INCOMPLETE"
      : "AGREED";
  return { facts, status };
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

interface CliOptions {
  readonly block: bigint | null;
  readonly allowStale: boolean;
  readonly out: string;
}

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      block: { type: "string" },
      "allow-stale": { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help === true) {
    console.log(`TapeCI chain probe (read-only)

Options:
  --block <number>   pin an explicit block instead of (lowest operator head - ${XLAYER_MAINNET.pin.offset})
  --allow-stale      allow a pinned block older than ${XLAYER_MAINNET.pin.maxLagBlocks} blocks
  --out <path>       evidence output path (default docs/evidence/chain-probe.json)
`);
    process.exit(0);
  }
  let block: bigint | null = null;
  if (values.block !== undefined) {
    if (!/^[0-9]+$/.test(values.block)) throw new Error(`--block must be a decimal block number, got "${values.block}"`);
    block = BigInt(values.block);
  }
  return {
    block,
    allowStale: values["allow-stale"] === true,
    out: values.out === undefined ? DEFAULT_OUT : resolve(process.cwd(), values.out),
  };
}

async function main(): Promise<void> {
  const options = parseCli();
  const endpoints = resolveRpcEndpoints();
  const perOperator = oneEndpointPerOperator(endpoints);
  const operators = assertDistinctOperators(perOperator);
  const primaryEndpoint = perOperator[0];
  if (primaryEndpoint === undefined) throw new Error("no primary RPC endpoint configured");
  const clients = new Map<string, ReadClient>(
    endpoints.map((endpoint) => [endpoint.url, createReadClient(endpoint.url)]),
  );
  const primaryClient = clients.get(primaryEndpoint.url);
  if (primaryClient === undefined) throw new Error("primary RPC client missing");

  const heads = await readAllHeads(endpoints, clients);
  const pin = resolvePin(heads, operators, options.block, options.allowStale);

  console.log(`pinned block ${pin.pinnedBlock} (mode=${pin.mode}, lag=${pin.lagBlocks}, stale=${pin.stale})`);
  console.log(
    `endpoints: ${endpoints.map((endpoint) => `${endpoint.operator}:${new URL(endpoint.url).host}`).join(", ")}`,
  );

  // ---- 1. package probe against the primary endpoint ------------------------
  const probe = await probeChain(primaryClient, XLAYER_MAINNET, { blockNumber: pin.pinnedBlock });
  const pinnedHeader = await primaryClient.getBlock({ blockNumber: pin.pinnedBlock });

  // ---- 2. implementation + bytecode observations ----------------------------
  const implementations = await checkAllImplementations(primaryClient, XLAYER_MAINNET, pin.pinnedBlock);
  const implementationByRole = new Map(implementations.map((entry) => [entry.role, entry]));
  const factoryImplementation = implementationByRole.get("factory")?.implementation ?? null;
  const registryImplementation = implementationByRole.get("siteRegistry")?.implementation ?? null;
  const bindingImplementation = implementationByRole.get("domainBinding")?.implementation ?? null;
  if (factoryImplementation === null || registryImplementation === null || bindingImplementation === null) {
    throw new Error("could not read all three ERC-1967 implementation slots");
  }

  const registryProxy = XLAYER_MAINNET.registries[0];
  if (registryProxy === undefined) throw new Error("no SiteRegistry proxy configured");
  const processor = getAddress(
    await primaryClient.readContract({
      address: XLAYER_MAINNET.factory,
      abi: factoryAbi,
      functionName: "cpuAt",
      args: [0n],
      blockNumber: pin.pinnedBlock,
    }),
  );
  const container = getAddress(OBSERVED_XLAYER_SITE.container);

  const codeAddresses: { role: string; address: SharedHex; kind: "proxy" | "implementation" | "contract" }[] = [
    { role: "factory", address: XLAYER_MAINNET.factory, kind: "proxy" },
    { role: "factoryImplementation", address: factoryImplementation, kind: "implementation" },
    { role: "opener", address: XLAYER_MAINNET.opener, kind: "contract" },
    { role: "siteRegistry", address: registryProxy, kind: "proxy" },
    { role: "siteRegistryImplementation", address: registryImplementation, kind: "implementation" },
    { role: "domainBinding", address: XLAYER_MAINNET.binding, kind: "proxy" },
    { role: "domainBindingImplementation", address: bindingImplementation, kind: "implementation" },
    { role: "container", address: container, kind: "contract" },
    { role: "processor", address: processor, kind: "contract" },
  ];
  const codeSizes = await Promise.all(
    codeAddresses.map(async (entry) => ({
      role: entry.role,
      address: entry.address,
      kind: entry.kind,
      ...(await readCode(primaryClient, entry.address, pin.pinnedBlock)),
    })),
  );

  const codeByRole = new Map(codeSizes.map((entry) => [entry.role, entry]));
  // Presence checks need the bytes themselves; re-read the four relevant contracts once.
  const selectorCodes = new Map<string, Hex>(
    await Promise.all(
      ["siteRegistryImplementation", "factoryImplementation", "domainBindingImplementation", "opener"].map(
        async (role) => {
          const entry = codeByRole.get(role);
          if (entry === undefined) throw new Error(`no bytecode observation for ${role}`);
          const code = await primaryClient.getCode({ address: entry.address, blockNumber: pin.pinnedBlock });
          return [role, (code ?? "0x") as Hex] as const;
        },
      ),
    ),
  );

  const selectorTable = recomputedSelectorTable();
  const selectors = {
    recomputed: selectorTable.allSignatures,
    tapekitHardcodedMatches: selectorTable.tapekitHardcoded,
    presence: {
      siteRegistryImplementation: checkSelectorsInBytecode(
        selectorCodes.get("siteRegistryImplementation") ?? "0x",
        { ...SITE_REGISTRY_READ_SIGNATURES, ...WRITE_SIGNATURES },
      ),
      factoryImplementation: checkSelectorsInBytecode(
        selectorCodes.get("factoryImplementation") ?? "0x",
        FACTORY_SIGNATURES,
      ),
      opener: checkSelectorsInBytecode(selectorCodes.get("opener") ?? "0x", OPENER_SIGNATURES),
      domainBindingImplementation: checkSelectorsInBytecode(
        selectorCodes.get("domainBindingImplementation") ?? "0x",
        BINDING_SIGNATURES,
      ),
    },
  };

  // ---- 3. live read calls (raw + decoded) ----------------------------------
  const fileInfoCalldata = encodeFunctionData({
    abi: siteRegistryAbi,
    functionName: "fileInfo",
    args: [container, LIVE_PATH],
  });
  const tokenCalldata = encodeFunctionData({ abi: containerAbi, functionName: "token" });

  const fileInfoCall = await rawRead(primaryClient, "fileInfo", registryProxy, fileInfoCalldata, pin.pinnedBlock);
  if (!fileInfoCall.ok || fileInfoCall.raw === null) {
    throw new Error(`fileInfo eth_call failed at block ${pin.pinnedBlock}: ${fileInfoCall.error ?? "no data"}`);
  }
  const fileInfoDecoded = decodeFunctionResult({
    abi: siteRegistryAbi,
    functionName: "fileInfo",
    data: fileInfoCall.raw,
  });
  const [fileSize, fileContentType, fileSha256, fileUpdatedAt, fileChunkCount] = fileInfoDecoded;

  const tokenCall = await rawRead(primaryClient, "token", container, tokenCalldata, pin.pinnedBlock);
  if (!tokenCall.ok || tokenCall.raw === null) {
    throw new Error(`container.token eth_call failed at block ${pin.pinnedBlock}: ${tokenCall.error ?? "no data"}`);
  }
  const tokenDecoded = decodeFunctionResult({ abi: containerAbi, functionName: "token", data: tokenCall.raw });
  const [tokenChainId, tokenProcessor, tokenId] = tokenDecoded;

  const file = await readFileBytesAt(primaryClient, registryProxy, container, LIVE_PATH, {
    blockNumber: pin.pinnedBlock,
  });
  const readRangePrefixCalldata = encodeFunctionData({
    abi: siteRegistryAbi,
    functionName: "readRange",
    args: [container, LIVE_PATH, 0n, 16n],
  });
  const readRangePrefixCall = await rawRead(
    primaryClient,
    "readRange(0,16)",
    registryProxy,
    readRangePrefixCalldata,
    pin.pinnedBlock,
  );
  const readRangePrefixDecoded =
    readRangePrefixCall.raw === null
      ? null
      : decodeFunctionResult({
          abi: siteRegistryAbi,
          functionName: "readRange",
          data: readRangePrefixCall.raw,
        });
  const readRangeEndCalldata = encodeFunctionData({
    abi: siteRegistryAbi,
    functionName: "readRange",
    args: [container, LIVE_PATH, BigInt(file.bytes.length), 16n],
  });
  const readRangeEndCall = await rawRead(
    primaryClient,
    "readRange(size,16)",
    registryProxy,
    readRangeEndCalldata,
    pin.pinnedBlock,
  );
  const readRangeEndDecoded =
    readRangeEndCall.raw === null
      ? null
      : decodeFunctionResult({
          abi: siteRegistryAbi,
          functionName: "readRange",
          data: readRangeEndCall.raw,
        });

  const readCalls = {
    factory: {
      cpuCount: await primaryClient.readContract({
        address: XLAYER_MAINNET.factory,
        abi: factoryAbi,
        functionName: "cpuCount",
        blockNumber: pin.pinnedBlock,
      }),
      cpuAt0: processor,
      isCPU0: await primaryClient.readContract({
        address: XLAYER_MAINNET.factory,
        abi: factoryAbi,
        functionName: "isCPU",
        args: [processor],
        blockNumber: pin.pinnedBlock,
      }),
      isSealed: await primaryClient.readContract({
        address: XLAYER_MAINNET.factory,
        abi: factoryAbi,
        functionName: "isSealed",
        blockNumber: pin.pinnedBlock,
      }),
      deployFee: await primaryClient.readContract({
        address: XLAYER_MAINNET.factory,
        abi: factoryAbi,
        functionName: "deployFee",
        blockNumber: pin.pinnedBlock,
      }),
      protocolFee: await primaryClient.readContract({
        address: XLAYER_MAINNET.factory,
        abi: factoryAbi,
        functionName: "protocolFee",
        blockNumber: pin.pinnedBlock,
      }),
      owner: await primaryClient.readContract({
        address: XLAYER_MAINNET.factory,
        abi: factoryAbi,
        functionName: "owner",
        blockNumber: pin.pinnedBlock,
      }),
    },
    opener: {
      fee: await primaryClient.readContract({
        address: XLAYER_MAINNET.opener,
        abi: openerAbi,
        functionName: "FEE",
        blockNumber: pin.pinnedBlock,
      }),
      accountOfProcessor2: await primaryClient.readContract({
        address: XLAYER_MAINNET.opener,
        abi: openerAbi,
        functionName: "accountOf",
        args: [processor, 2n],
        blockNumber: pin.pinnedBlock,
      }),
      isOpenedProcessor2: await primaryClient.readContract({
        address: XLAYER_MAINNET.opener,
        abi: openerAbi,
        functionName: "isOpened",
        args: [processor, 2n],
        blockNumber: pin.pinnedBlock,
      }),
      isDeployedProcessor2: await primaryClient.readContract({
        address: XLAYER_MAINNET.opener,
        abi: openerAbi,
        functionName: "isDeployed",
        args: [processor, 2n],
        blockNumber: pin.pinnedBlock,
      }),
    },
    container: {
      tokenRaw: tokenCall.raw,
      tokenCalldata: tokenCall.calldata,
      tokenDecoded: { chainId: tokenChainId, processor: getAddress(tokenProcessor), tokenId },
      owner: await primaryClient.readContract({
        address: container,
        abi: containerAbi,
        functionName: "owner",
        blockNumber: pin.pinnedBlock,
      }),
    },
    processor: {
      ownerOf2: await primaryClient.readContract({
        address: processor,
        abi: processorAbi,
        functionName: "ownerOf",
        args: [2n],
        blockNumber: pin.pinnedBlock,
      }),
      name: await primaryClient.readContract({
        address: processor,
        abi: processorAbi,
        functionName: "name",
        blockNumber: pin.pinnedBlock,
      }),
      symbol: await primaryClient.readContract({
        address: processor,
        abi: processorAbi,
        functionName: "symbol",
        blockNumber: pin.pinnedBlock,
      }),
      nextId: await primaryClient.readContract({
        address: processor,
        abi: processorAbi,
        functionName: "nextId",
        blockNumber: pin.pinnedBlock,
      }),
    },
    siteRegistry: {
      fileInfoCalldata: fileInfoCall.calldata,
      fileInfoRaw: fileInfoCall.raw,
      fileInfoDecoded: {
        size: fileSize,
        contentType: fileContentType,
        sha256: fileSha256,
        updatedAt: fileUpdatedAt,
        chunkCount: fileChunkCount,
      },
      pathCount: await primaryClient.readContract({
        address: registryProxy,
        abi: siteRegistryAbi,
        functionName: "pathCount",
        args: [container],
        blockNumber: pin.pinnedBlock,
      }),
      paths: await primaryClient.readContract({
        address: registryProxy,
        abi: siteRegistryAbi,
        functionName: "paths",
        args: [container],
        blockNumber: pin.pinnedBlock,
      }),
      fallbackPath: await primaryClient.readContract({
        address: registryProxy,
        abi: siteRegistryAbi,
        functionName: "fallbackPath",
        args: [container],
        blockNumber: pin.pinnedBlock,
      }),
      isOpenedContainer: await primaryClient.readContract({
        address: registryProxy,
        abi: siteRegistryAbi,
        functionName: "isOpenedContainer",
        args: [container],
        blockNumber: pin.pinnedBlock,
      }),
      chunkMax: await primaryClient.readContract({
        address: registryProxy,
        abi: siteRegistryAbi,
        functionName: "CHUNK_MAX",
        blockNumber: pin.pinnedBlock,
      }),
      readRange0_16: {
        calldata: readRangePrefixCall.calldata,
        raw: readRangePrefixCall.raw,
        bytesHex: readRangePrefixDecoded === null ? null : readRangePrefixDecoded,
      },
      readRangeAtSize: {
        calldata: readRangeEndCall.calldata,
        raw: readRangeEndCall.raw,
        bytesHex: readRangeEndDecoded === null ? null : readRangeEndDecoded,
      },
      read: {
        bytesLength: file.bytes.length,
        first16Hex: bytesToHex(file.bytes.slice(0, 16)),
        last16Hex: bytesToHex(file.bytes.slice(Math.max(0, file.bytes.length - 16))),
        declaredSha256: file.info.sha256,
        computedSha256: file.actualSha256,
        sha256Matches: file.actualSha256.toLowerCase() === file.info.sha256.toLowerCase(),
      },
    },
    domainBinding: {
      monthlyFee: await primaryClient.readContract({
        address: XLAYER_MAINNET.binding,
        abi: bindingAbi,
        functionName: "monthlyFee",
        blockNumber: pin.pinnedBlock,
      }),
      isContainerLive: await primaryClient.readContract({
        address: XLAYER_MAINNET.binding,
        abi: bindingAbi,
        functionName: "isContainerLive",
        args: [container],
        blockNumber: pin.pinnedBlock,
      }),
      containerPaidUntil: await primaryClient.readContract({
        address: XLAYER_MAINNET.binding,
        abi: bindingAbi,
        functionName: "containerPaidUntil",
        args: [container],
        blockNumber: pin.pinnedBlock,
      }),
      isLiveName: await primaryClient.readContract({
        address: XLAYER_MAINNET.binding,
        abi: bindingAbi,
        functionName: "isLive",
        args: [OBSERVED_XLAYER_SITE.name, container],
        blockNumber: pin.pinnedBlock,
      }),
      paidUntilName: await primaryClient.readContract({
        address: XLAYER_MAINNET.binding,
        abi: bindingAbi,
        functionName: "paidUntil",
        args: [keccakHex(OBSERVED_XLAYER_SITE.name), container],
        blockNumber: pin.pinnedBlock,
      }),
    },
  };

  // ---- 4. write-ABI eth_call simulations (never broadcast) -----------------
  const holder = getAddress(readCalls.processor.ownerOf2);
  if (isAddressEqual(holder, NON_EDITOR)) throw new Error("holder equals the non-editor probe address");
  const containerOwner = getAddress(readCalls.container.owner);
  const oneByteFile = new Uint8Array([0]);
  const oneByteSha = sha256Hex(oneByteFile);
  const zeroChunk = "0x00" as const;
  const chunkMax = Number(readCalls.siteRegistry.chunkMax);
  const chunkCount = Number(readCalls.siteRegistry.fileInfoDecoded.chunkCount);

  interface Simulation {
    readonly name: string;
    readonly from: "holder" | "non-editor";
    readonly fromAddress: SharedHex;
    readonly calldata: SharedHex;
    readonly expectation: string;
    readonly note: string;
  }

  const simulations: Simulation[] = [
    {
      name: "putFile",
      from: "non-editor",
      fromAddress: NON_EDITOR,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "putFile",
        args: [container, PROBE_PATH, "text/plain", oneByteSha, zeroChunk],
      }),
      expectation: "reject: onlyEditor",
      note: "non-holder must be rejected before any write logic runs",
    },
    {
      name: "appendChunk",
      from: "non-editor",
      fromAddress: NON_EDITOR,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "appendChunk",
        args: [container, LIVE_PATH, BigInt(chunkCount), zeroChunk],
      }),
      expectation: "reject: onlyEditor",
      note: "non-holder must be rejected",
    },
    {
      name: "removeFile",
      from: "non-editor",
      fromAddress: NON_EDITOR,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "removeFile",
        args: [container, PROBE_PATH],
      }),
      expectation: "reject: onlyEditor",
      note: "non-holder must be rejected",
    },
    {
      name: "setFallback",
      from: "non-editor",
      fromAddress: NON_EDITOR,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "setFallback",
        args: [container, LIVE_PATH],
      }),
      expectation: "reject: onlyEditor",
      note: "non-holder must be rejected",
    },
    {
      name: "setOperator",
      from: "non-editor",
      fromAddress: NON_EDITOR,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "setOperator",
        args: [container, NON_EDITOR, 3600n],
      }),
      expectation: "reject: onlyEditor",
      note: "non-holder must be rejected",
    },
    {
      name: "putFile",
      from: "holder",
      fromAddress: holder,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "putFile",
        args: [container, PROBE_PATH, "text/plain", oneByteSha, zeroChunk],
      }),
      expectation: "accept",
      note: `chunk 0 of a 1-byte file on an unused probe path (${PROBE_PATH})`,
    },
    {
      name: "putFile",
      from: "holder",
      fromAddress: holder,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "putFile",
        args: [
          container,
          PROBE_PATH,
          "text/plain",
          sha256Hex(new Uint8Array(chunkMax)),
          `0x${"00".repeat(chunkMax)}`,
        ],
      }),
      expectation: "accept",
      note: `exactly CHUNK_MAX=${chunkMax} bytes is accepted`,
    },
    {
      name: "putFile",
      from: "holder",
      fromAddress: holder,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "putFile",
        args: [
          container,
          PROBE_PATH,
          "text/plain",
          sha256Hex(new Uint8Array(chunkMax + 1)),
          `0x${"00".repeat(chunkMax + 1)}`,
        ],
      }),
      expectation: "reject: TooLarge",
      note: `CHUNK_MAX+1=${chunkMax + 1} bytes must be rejected`,
    },
    {
      name: "appendChunk",
      from: "holder",
      fromAddress: holder,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "appendChunk",
        args: [container, LIVE_PATH, BigInt(chunkCount), zeroChunk],
      }),
      expectation: "accept",
      note: `expectIndex=${chunkCount} equals the on-chain chunkCount (correct next chunk)`,
    },
    {
      name: "appendChunk",
      from: "holder",
      fromAddress: holder,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "appendChunk",
        args: [container, LIVE_PATH, BigInt(Math.max(0, chunkCount - 1)), zeroChunk],
      }),
      expectation: "reject: BadIndex",
      note: "a duplicate/stale expectIndex must be rejected (append idempotency guard)",
    },
    {
      name: "appendChunk",
      from: "holder",
      fromAddress: holder,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "appendChunk",
        args: [container, PROBE_PATH, 0n, zeroChunk],
      }),
      expectation: "reject: NoSuchFile",
      note: "appendChunk on a path with no chunk 0 must be rejected",
    },
    {
      name: "appendChunk",
      from: "holder",
      fromAddress: holder,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "appendChunk",
        args: [container, LIVE_PATH, BigInt(chunkCount), `0x${"00".repeat(chunkMax + 1)}`],
      }),
      expectation: "reject: TooLarge",
      note: `CHUNK_MAX+1=${chunkMax + 1} bytes must be rejected`,
    },
    {
      name: "removeFile",
      from: "holder",
      fromAddress: holder,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "removeFile",
        args: [container, PROBE_PATH],
      }),
      expectation: "reject: NoSuchFile",
      note: "removing a path that does not exist must be rejected",
    },
    {
      name: "setFallback",
      from: "holder",
      fromAddress: holder,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "setFallback",
        args: [container, LIVE_PATH],
      }),
      expectation: "accept",
      note: "holder can set the fallback path",
    },
    {
      name: "setOperator",
      from: "holder",
      fromAddress: holder,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "setOperator",
        args: [container, NON_EDITOR, 3600n],
      }),
      expectation: "accept",
      note: "holder can authorize a timed operator",
    },
    {
      name: "putFile",
      from: "holder",
      fromAddress: holder,
      calldata: encodeFunctionData({
        abi: siteRegistryAbi,
        functionName: "putFile",
        args: [container, "../escape.txt", "text/plain", oneByteSha, zeroChunk],
      }),
      expectation: "accept",
      note: "on-chain code does NOT normalize or reject `..` in paths: canonicalization is a client duty",
    },
    {
      name: "unknown-selector-baseline",
      from: "non-editor",
      fromAddress: NON_EDITOR,
      calldata: "0xdeadbeef" as SharedHex,
      expectation: "reject: empty fallback",
      note: "baseline: an unknown selector reverts without data, which distinguishes a recognized selector",
    },
  ];

  const simulationResults = await Promise.all(
    simulations.map(async (simulation) => {
      const call = await ethCall(
        primaryClient,
        registryProxy,
        simulation.calldata,
        pin.pinnedBlock,
        simulation.fromAddress,
      );
      return {
        name: simulation.name,
        from: simulation.from,
        fromAddress: simulation.fromAddress,
        selector: simulation.calldata.slice(0, 10),
        expectation: simulation.expectation,
        ok: call.ok,
        raw: call.raw,
        revertData: call.revertData,
        decodedRevert: decodeRevert(call.revertData),
        error: call.error,
        note: simulation.note,
      };
    }),
  );

  const gasEstimateTargets = {
    putFile: simulations[5],
    appendChunk: simulations[8],
    setFallback: simulations[13],
    setOperator: simulations[14],
  } as const;
  const gasEstimates: { name: string; fromAddress: SharedHex; gas: string | null; error: string | null }[] = [];
  for (const [name, simulation] of Object.entries(gasEstimateTargets)) {
    if (simulation === undefined) throw new Error(`missing write simulation for gas estimate ${name}`);
    try {
      const gas = await primaryClient.estimateGas({
        account: simulation.fromAddress,
        to: registryProxy,
        data: simulation.calldata,
        blockNumber: pin.pinnedBlock,
      });
      gasEstimates.push({ name, fromAddress: simulation.fromAddress, gas: gas.toString(), error: null });
    } catch (error) {
      gasEstimates.push({ name, fromAddress: simulation.fromAddress, gas: null, error: errorMessage(error) });
    }
  }

  // ---- 5. cross-operator facts at the same pinned block --------------------
  const facts = buildFactSpecs(
    pin.pinnedBlock,
    container,
    registryProxy,
    processor,
    fileInfoCalldata,
    tokenCalldata,
    OBSERVED_XLAYER_SITE.name,
  );
  const perEndpointFacts = await Promise.all(
    endpoints.map(async (endpoint) => {
      const client = clients.get(endpoint.url);
      if (client === undefined) throw new Error(`no client for ${endpoint.url}`);
      const collected = await collectFacts(client, facts);
      return { url: endpoint.url, operator: endpoint.operator, facts: collected };
    }),
  );
  const factSummary = summariseFacts(facts, operators, perEndpointFacts);

  const endpointStatus = endpoints.map((endpoint) => {
    const index = endpoint.url;
    const observations = factSummary.facts.flatMap((fact) =>
      fact.observations.filter((observation) => observation.url === index),
    );
    const failed = observations.filter((observation) => observation.value === null);
    return {
      url: endpoint.url,
      operator: endpoint.operator,
      head: heads.find((head) => head.url === endpoint.url)?.head?.toString() ?? null,
      headError: heads.find((head) => head.url === endpoint.url)?.error ?? null,
      factsRead: observations.length - failed.length,
      factsFailed: failed.length,
      errors: [...new Set(failed.map((observation) => observation.error ?? "unknown error"))].slice(0, 5),
    };
  });

  // ---- 6. assemble + write evidence ---------------------------------------
  const evidence = {
    schemaVersion: "tapeci.chain-probe.v1",
    generatedBy: "scripts/probe/probe.ts (read-only; no transactions broadcast)",
    task: "P0-02 chain/implementation probe + P0-03 ABI selector validation support data",
    observedAt: probe.observedAt,
    tapekitSource: TAPEKIT_SOURCE,
    network: {
      chainId: XLAYER_MAINNET.chainId,
      name: XLAYER_MAINNET.name,
      nativeCurrency: XLAYER_MAINNET.nativeCurrency,
      area: XLAYER_MAINNET.area,
      factory: XLAYER_MAINNET.factory,
      opener: XLAYER_MAINNET.opener,
      siteRegistry: registryProxy,
      domainBinding: XLAYER_MAINNET.binding,
      implementationSlot: IMPL_SLOT,
      observedSiteName: OBSERVED_XLAYER_SITE.name,
      observedContainer: container,
      observedPath: LIVE_PATH,
    },
    pin: {
      mode: pin.mode,
      pinnedBlock: pin.pinnedBlock.toString(),
      pinnedBlockHash: pinnedHeader.hash,
      pinnedBlockParentHash: pinnedHeader.parentHash,
      pinnedBlockTimestamp: pinnedHeader.timestamp.toString(),
      pinnedBlockIso: new Date(Number(pinnedHeader.timestamp) * 1000).toISOString(),
      highestObservedHead: pin.highestHead.toString(),
      lagBlocks: pin.lagBlocks.toString(),
      maxLagBlocks: XLAYER_MAINNET.pin.maxLagBlocks,
      stale: pin.stale,
      pinOffset: XLAYER_MAINNET.pin.offset,
      operatorBases: Object.fromEntries([...pin.operatorBases].map(([operator, head]) => [operator, head.toString()])),
      endpointHeads: heads.map((head) => ({
        url: head.url,
        operator: head.operator,
        head: head.head === null ? null : head.head.toString(),
        error: head.error,
      })),
    },
    chainProbe: probeToJson(probe),
    implementations: implementations.map((entry) => ({
      role: entry.role,
      proxy: entry.proxy,
      slot: entry.slot,
      implementation: entry.implementation,
      allowlisted: entry.allowlisted,
      expected: entry.expected,
      proxyCodeSizeBytes: entry.codeSize,
    })),
    code: codeSizes,
    selectors,
    readCalls,
    liveSite: {
      container,
      path: LIVE_PATH,
      fileInfo: readCalls.siteRegistry.fileInfoDecoded,
      readSha256: readCalls.siteRegistry.read.computedSha256,
      declaredSha256: readCalls.siteRegistry.read.declaredSha256,
      sha256Matches: readCalls.siteRegistry.read.sha256Matches,
      capturedObservedSite: {
        size: OBSERVED_XLAYER_SITE.size,
        sha256: OBSERVED_XLAYER_SITE.sha256,
        chunkCount: OBSERVED_XLAYER_SITE.chunkCount,
      },
      matchesCapturedObservation:
        file.actualSha256.toLowerCase() === OBSERVED_XLAYER_SITE.sha256.toLowerCase() &&
        file.bytes.length === OBSERVED_XLAYER_SITE.size,
    },
    writeSimulations: {
      method:
        "eth_call against the pinned block from the current container holder and from a non-editor address; no transaction is signed or broadcast",
      containerHolder: holder,
      containerOwner,
      chunkMax,
      chunkCount,
      knownRevertSignatures: [...KNOWN_ERRORS.values()],
      results: simulationResults,
      gasEstimates,
    },
    crossCheck: {
      pinnedBlock: pin.pinnedBlock.toString(),
      requiredOperators: operators,
      status: factSummary.status,
      endpoints: endpointStatus,
      facts: factSummary.facts,
    },
    limitations: [
      "Reads are a consistent snapshot at one pinned block, not a finality guarantee: X Layer's sequencer publishes `latest` before `safe`/`finalized`, so a reorg above the pin is still possible.",
      "chainProbe.fees.gasPriceWei comes from eth_gasPrice, which is not pinned to the block; the other fee values are eth_call results at the pinned block.",
      "Selector presence is a byte-substring search of PUSH4 constants: it is necessary but not sufficient evidence of dispatch. Live eth_call return values and revert payloads provide the semantic evidence.",
      "Revert-error names (NotOwner, BadIndex, NoSuchFile, TooLarge) were recovered by recomputing keccak256 over candidate signatures and matching the observed 4-byte values; no published X Layer ABI was available for these custom errors.",
      "On-chain SiteRegistry does not enforce SHA-256/size consistency and does not canonicalize `..` in paths: those checks are the client's responsibility (TapeCI verifier).",
      "The implementation allowlist is TapeKit's published pin, not an independent audit; a compromised allowlist would be accepted.",
      "thirdweb (196.rpc.thirdweb.com) is counted as operator `okx` by TapeKit config; it is a cross-check of the OKX operator, never a second independent vote.",
      "Public RPC endpoints are rate-limited and may fail transiently; failures are recorded per fact so a missing endpoint cannot silently shrink the quorum.",
    ],
    unverified: [
      "Actual state mutation, gas consumption and transaction receipts for putFile/appendChunk/removeFile/setFallback/setOperator: requires P0-04/P0-05 Anvil-fork transactions and, for mainnet, P0-07 explicit authorization.",
      "Transaction-level ABI compatibility (event ordering, storage layout, upgrade storage gaps) is not observable through eth_call.",
      "Whether every current X Layer SiteRegistry implementation path (upgrade/revert branches) matches SPEC v0.2: the write ABI is not in the normative SPEC, which is BNB-first.",
      "Long-term stability of the pinned block evidence: the JSON records one snapshot and must be re-run after any implementation upgrade.",
    ],
  };

  const outPath = options.out;
  await mkdir(dirname(outPath), { recursive: true });
  const json = JSON.stringify(
    evidence,
    (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
  await writeFile(outPath, `${json}\n`, "utf8");

  // ---- 7. console summary --------------------------------------------------
  const missingSiteRegistrySelectors = selectors.presence.siteRegistryImplementation
    .filter((row) => !row.present)
    .map((row) => row.name);
  const missingWriteSelectors = selectors.presence.siteRegistryImplementation
    .filter((row) => !row.present && row.name in WRITE_SIGNATURES)
    .map((row) => row.name);
  console.log(`chainId=${probe.chainId} cpuCount=${readCalls.factory.cpuCount} isSealed=${readCalls.factory.isSealed}`);
  console.log(
    `implementations: ${implementations
      .map((entry) => `${entry.role}=${entry.implementation} allowlisted=${entry.allowlisted}`)
      .join(" | ")}`,
  );
  console.log(
    `fees: gasPriceWei=${probe.fees.gasPriceWei} openFeeWei=${readCalls.opener.fee} monthlyFeeWei=${readCalls.domainBinding.monthlyFee} deployFeeWei=${readCalls.factory.deployFee}`,
  );
  console.log(`CHUNK_MAX=${readCalls.siteRegistry.chunkMax}`);
  console.log(
    `siteRegistry selectors missing (of ${selectors.presence.siteRegistryImplementation.length}): ${
      missingSiteRegistrySelectors.length === 0 ? "none" : missingSiteRegistrySelectors.join(", ")
    }; missing writes: ${missingWriteSelectors.length === 0 ? "none" : missingWriteSelectors.join(", ")}`,
  );
  console.log(
    `fileInfo ${LIVE_PATH}: size=${readCalls.siteRegistry.fileInfoDecoded.size} type=${readCalls.siteRegistry.fileInfoDecoded.contentType} chunkCount=${readCalls.siteRegistry.fileInfoDecoded.chunkCount}`,
  );
  console.log(
    `read(${LIVE_PATH}) ${file.bytes.length} bytes sha256=${file.actualSha256} matchesDeclared=${readCalls.siteRegistry.read.sha256Matches}`,
  );
  console.log(
    `write simulations: ${simulationResults.filter((entry) => entry.ok).length} accepted, ${
      simulationResults.filter((entry) => !entry.ok).length
    } reverted (eth_call only)`,
  );
  console.log(`cross-operator: ${factSummary.status} over operators ${operators.join(" + ")}`);
  if (factSummary.status !== "AGREED") {
    for (const fact of factSummary.facts.filter((entry) => entry.status !== "AGREE")) {
      console.log(`  ${fact.status} ${fact.id} -> ${fact.distinctValues.join(" | ") || "no value"}`);
    }
  }
  console.log(`evidence written to ${outPath}`);
  if (factSummary.status !== "AGREED") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`probe failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
