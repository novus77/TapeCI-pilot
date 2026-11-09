import type { ChainConfig } from "@tapeci/config";
import { TapeCiError } from "@tapeci/shared";
import { factoryAbi, openerAbi } from "./abis.js";
import type { ReadClient } from "./clients.js";
import {
  checkAllImplementations,
  readImplementationSlot,
  assertChainId,
  type ImplementationObservation,
} from "./implementation.js";
import { checkSelectorsInBytecode, READ_SIGNATURES, WRITE_SIGNATURES, type SelectorPresence } from "./selectors.js";
import { readChunkMax } from "./registry.js";
import { readFees, type ChainFees } from "./fees.js";

export interface ContractProbe {
  readonly address: string;
  readonly codeSize: number;
}

export interface ChainProbe {
  readonly observedAt: string;
  readonly chainId: number;
  /** Chain head when the probe ran; may be above `probeBlock`. */
  readonly latestBlock: number;
  /** The block every chain read in this probe was bound to (`null` = latest per call). */
  readonly probeBlock: number | null;
  readonly fees: ChainFees;
  readonly implementations: readonly ImplementationObservation[];
  readonly contracts: {
    readonly factory: ContractProbe & { readonly cpuCount: number; readonly isSealed: boolean };
    readonly opener: ContractProbe & { readonly openFeeWei: bigint };
    readonly siteRegistry: ContractProbe & {
      readonly implementation: string;
      readonly implementationCodeSize: number;
      readonly chunkMax: number | null;
    };
    readonly domainBinding: ContractProbe & {
      readonly implementation: string;
      readonly implementationCodeSize: number;
      readonly monthlyFeeWei: bigint;
    };
  };
  readonly selectors: {
    readonly siteRegistry: readonly SelectorPresence[];
    readonly opener: readonly SelectorPresence[];
    readonly factoryImpl: readonly SelectorPresence[];
  };
  readonly notes: readonly string[];
}

async function codeSizeOf(client: ReadClient, address: `0x${string}`, blockNumber?: bigint): Promise<number> {
  const code = await client.getCode({
    address,
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  return code ? (code.length - 2) / 2 : 0;
}

/**
 * P0-02/P0-03 evidence collector: chainId, implementation slots, contract bytecode,
 * live fees/limits and which ABI selectors are present in each implementation.
 */
export async function probeChain(
  client: ReadClient,
  config: ChainConfig,
  options: { blockNumber?: bigint } = {},
): Promise<ChainProbe> {
  const { blockNumber } = options;
  const readOptions = blockNumber === undefined ? {} : { blockNumber };

  await assertChainId(client, config.chainId);
  const [head, fees, implementations] = await Promise.all([
    client.getBlockNumber(),
    readFees(client, config, blockNumber),
    checkAllImplementations(client, config, blockNumber),
  ]);

  const registryEntry = config.allowlist.find((entry) => entry.role === "siteRegistry");
  const bindingEntry = config.allowlist.find((entry) => entry.role === "domainBinding");
  if (!registryEntry || !bindingEntry) throw new TapeCiError("INTERNAL", "allowlist incomplete");
  const registryImpl = implementations.find((entry) => entry.role === "siteRegistry")?.implementation;
  const bindingImpl = implementations.find((entry) => entry.role === "domainBinding")?.implementation;
  if (!registryImpl || !bindingImpl) throw new TapeCiError("INTERNAL", "implementation not readable");

  const [registryCode, bindingImplCode, openerCode, cpuCount, isSealed, chunkMax] = await Promise.all([
    client.getCode({ address: registryImpl, ...readOptions }),
    client.getCode({ address: bindingImpl, ...readOptions }),
    client.getCode({ address: config.opener, ...readOptions }),
    client.readContract({
      address: config.factory,
      abi: factoryAbi,
      functionName: "cpuCount",
      ...readOptions,
    }),
    client.readContract({
      address: config.factory,
      abi: factoryAbi,
      functionName: "isSealed",
      ...readOptions,
    }),
    readChunkMax(client, config.registries[0] as `0x${string}`, blockNumber),
  ]);

  const factoryEntry = config.allowlist.find((entry) => entry.role === "factory");
  if (!factoryEntry) throw new TapeCiError("INTERNAL", "factory allowlist missing");
  const factoryImpl = implementations.find((entry) => entry.role === "factory")?.implementation;
  if (!factoryImpl) throw new TapeCiError("INTERNAL", "factory implementation unreadable");
  const factoryImplCode = await client.getCode({ address: factoryImpl, ...readOptions });

  const notes: string[] = [];
  if (chunkMax === null) notes.push("SiteRegistry.CHUNK_MAX() reverted; chunk size must come from SPEC/limits.");
  if (chunkMax !== null && chunkMax !== 24_000) notes.push(`CHUNK_MAX()=${chunkMax} differs from SPEC 24,000.`);
  if (!isSealed) notes.push("factory.isSealed() is false: protocol contracts are still upgradeable (TapeOut X Layer is test-phase).");

  return {
    observedAt: new Date().toISOString(),
    chainId: await client.getChainId(),
    latestBlock: Number(head),
    probeBlock: blockNumber === undefined ? null : Number(blockNumber),
    fees,
    implementations,
    contracts: {
      factory: {
        address: config.factory,
        codeSize: await codeSizeOf(client, config.factory, blockNumber),
        cpuCount: Number(cpuCount),
        isSealed,
      },
      opener: {
        address: config.opener,
        codeSize: await codeSizeOf(client, config.opener, blockNumber),
        openFeeWei: fees.openerOpenFeeWei,
      },
      siteRegistry: {
        address: config.registries[0] as `0x${string}`,
        // Proxy code size (the implementation size is reported separately) so this
        // field means the same thing for factory / binding / registry.
        codeSize: await codeSizeOf(client, config.registries[0] as `0x${string}`, blockNumber),
        implementation: registryImpl,
        implementationCodeSize: registryCode ? (registryCode.length - 2) / 2 : 0,
        chunkMax,
      },
      domainBinding: {
        address: config.binding,
        codeSize: await codeSizeOf(client, config.binding, blockNumber),
        implementation: bindingImpl,
        implementationCodeSize: bindingImplCode ? (bindingImplCode.length - 2) / 2 : 0,
        monthlyFeeWei: fees.monthlyFeeWei,
      },
    },
    selectors: {
      siteRegistry: checkSelectorsInBytecode(
        (registryCode ?? "0x") as `0x${string}`,
        { ...READ_SIGNATURES, ...WRITE_SIGNATURES },
      ),
      opener: checkSelectorsInBytecode((openerCode ?? "0x") as `0x${string}`, {
        accountOf: READ_SIGNATURES.accountOf,
        isOpened: READ_SIGNATURES.isOpened,
        isDeployed: READ_SIGNATURES.isDeployed,
        open: READ_SIGNATURES.open,
        fee: "FEE()",
      }),
      factoryImpl: checkSelectorsInBytecode((factoryImplCode ?? "0x") as `0x${string}`, {
        cpuCount: READ_SIGNATURES.cpuCount,
        cpuAt: READ_SIGNATURES.cpuAt,
        cpus: READ_SIGNATURES.cpus,
        isCPU: READ_SIGNATURES.isCPU,
      }),
    },
    notes,
  };
}

/** JSON-safe (bigint → decimal string) representation for evidence files. */
export function probeToJson(probe: ChainProbe): unknown {
  const replacer = (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") return value.toString();
    return value;
  };
  return JSON.parse(JSON.stringify(probe, replacer)) as unknown;
}

/** Read-only helper used by the probe CLI to pin a concrete block for evidence. */
export async function resolveProbeBlock(client: ReadClient): Promise<bigint> {
  return client.getBlockNumber();
}

export { readImplementationSlot, openerAbi };
