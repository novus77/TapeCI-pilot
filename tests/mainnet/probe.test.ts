/**
 * P0-02 / P0-03 mainnet read-only checks.
 *
 * Every assertion below is an `eth_call`/state read pinned to ONE block and, where a
 * fact is asserted, re-read from a second independent RPC operator. Nothing here
 * signs or broadcasts a transaction; the write-path checks are `eth_call`
 * simulations whose state changes are discarded by the node.
 *
 * Run with: `corepack pnpm test:mainnet`
 */
import { beforeAll, describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, isAddressEqual, toFunctionSelector, type Hex } from "viem";
import { IMPL_SLOT, OBSERVED_XLAYER_SITE, XLAYER_MAINNET, oneEndpointPerOperator } from "@tapeci/config";
import {
  READ_SIGNATURES,
  WRITE_SIGNATURES,
  bytecodeContainsSelector,
  checkAllImplementations,
  checkImplementation,
  containerAbi,
  createReadClient,
  factoryAbi,
  openerAbi,
  readFileBytesAt,
  readFileInfo,
  readImplementationSlot,
  selectorOf,
  siteRegistryAbi,
  type ImplementationObservation,
  type ReadClient,
} from "@tapeci/chain";
import { sha256Hex, type Hex as SharedHex } from "@tapeci/shared";

interface CallOutcome {
  readonly ok: boolean;
  readonly revertData: SharedHex | null;
  readonly error: string | null;
}

async function ethCallAt(
  client: ReadClient,
  to: SharedHex,
  data: SharedHex,
  blockNumber: bigint,
  from?: SharedHex,
): Promise<CallOutcome> {
  const call = from === undefined ? { to, data } : { from, to, data };
  try {
    await client.request({ method: "eth_call", params: [call, `0x${blockNumber.toString(16)}`] });
    return { ok: true, revertData: null, error: null };
  } catch (error) {
    const record = error as { data?: unknown };
    const revertData =
      typeof record.data === "string" && /^0x[0-9a-fA-F]*$/.test(record.data)
        ? (record.data as SharedHex)
        : null;
    return {
      ok: false,
      revertData,
      error: error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 300) : String(error),
    };
  }
}

function requireCode(client: ReadClient, address: Hex, blockNumber: bigint, label: string): Promise<Hex> {
  return client.getCode({ address, blockNumber }).then((code) => {
    if (code === undefined || code === "0x") {
      throw new Error(`${label} has no bytecode at block ${blockNumber}`);
    }
    return code;
  });
}

interface ProbeContext {
  readonly pinnedBlock: bigint;
  readonly pinnedBlockHash: Hex;
  readonly okxOperator: string;
  readonly secondaryOperator: string;
  readonly okx: ReadClient;
  readonly secondary: ReadClient;
  readonly implementationsOkx: readonly ImplementationObservation[];
  readonly implementationsSecondary: readonly ImplementationObservation[];
  readonly processor: Hex;
  readonly container: Hex;
  readonly holder: Hex;
  readonly registryImplementationCode: Hex;
  readonly factoryImplementationCode: Hex;
  readonly openerCode: Hex;
  readonly bindingImplementationCode: Hex;
  readonly chunkMax: bigint;
  readonly fileInfoOkx: Awaited<ReturnType<typeof readFileInfo>>;
  readonly fileInfoSecondary: Awaited<ReturnType<typeof readFileInfo>>;
  readonly bytesOkx: Awaited<ReturnType<typeof readFileBytesAt>>;
  readonly bytesSecondary: Awaited<ReturnType<typeof readFileBytesAt>>;
}

let context: ProbeContext | undefined;

function ctx(): ProbeContext {
  if (context === undefined) throw new Error("mainnet probe context was not initialised");
  return context;
}

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
  bind: WRITE_SIGNATURES.bind,
  syncContainer: WRITE_SIGNATURES.syncContainer,
} as const;

const EXPECTED_CHUNK_MAX = 24_000;
const NON_EDITOR = getAddress("0x000000000000000000000000000000000000bEEF");
/** Custom error emitted by the live `onlyEditor` guard for all five write functions. */
const NOT_OWNER_SELECTOR = toFunctionSelector("NotOwner()");
/** Custom error emitted when a chunk exceeds CHUNK_MAX (24,000 bytes). */
const TOO_LARGE_SELECTOR = toFunctionSelector("TooLarge()");

beforeAll(async () => {
  const perOperator = oneEndpointPerOperator();
  const operatorNames = [...new Set(perOperator.map((endpoint) => endpoint.operator))];
  if (operatorNames.length < 2) {
    throw new Error(`need two independent RPC operators, configured: ${operatorNames.join(", ") || "none"}`);
  }
  const primary = perOperator[0];
  const secondaryEndpoint = perOperator.find((endpoint) => endpoint.operator !== primary?.operator);
  if (primary === undefined || secondaryEndpoint === undefined) {
    throw new Error("could not select a primary and a second-operator RPC endpoint");
  }
  const okx = createReadClient(primary.url);
  const secondary = createReadClient(secondaryEndpoint.url);

  // Pin: lowest head over both operators minus the configured offset, so every read
  // below is answerable by both operators at the same block.
  const [primaryHead, secondaryHead] = await Promise.all([okx.getBlockNumber(), secondary.getBlockNumber()]);
  const commonHead = primaryHead < secondaryHead ? primaryHead : secondaryHead;
  const pinnedBlock = commonHead - BigInt(XLAYER_MAINNET.pin.offset);
  if (pinnedBlock <= 0n) throw new Error(`head ${commonHead} is too low to pin`);
  const highestHead = primaryHead > secondaryHead ? primaryHead : secondaryHead;
  const lagBlocks = highestHead - pinnedBlock;
  if (lagBlocks > BigInt(XLAYER_MAINNET.pin.maxLagBlocks)) {
    throw new Error(
      `pin ${pinnedBlock} lags head ${highestHead} by ${lagBlocks} blocks > ${XLAYER_MAINNET.pin.maxLagBlocks}`,
    );
  }

  const [header, secondaryHeader] = await Promise.all([
    okx.getBlock({ blockNumber: pinnedBlock }),
    secondary.getBlock({ blockNumber: pinnedBlock }),
  ]);
  if (header.hash !== secondaryHeader.hash) {
    throw new Error(
      `operators disagree on the pinned block hash at ${pinnedBlock}: ${header.hash} vs ${secondaryHeader.hash}`,
    );
  }

  // chainId must be read before anything else is trusted.
  const [primaryChainId, secondaryChainId] = await Promise.all([okx.getChainId(), secondary.getChainId()]);
  if (primaryChainId !== XLAYER_MAINNET.chainId || secondaryChainId !== XLAYER_MAINNET.chainId) {
    throw new Error(`RPCs report chainId ${primaryChainId}/${secondaryChainId}, expected ${XLAYER_MAINNET.chainId}`);
  }

  const implementationsOkx = await checkAllImplementations(okx, XLAYER_MAINNET, pinnedBlock);
  // dRPC caps JSON-RPC batches at 3, so the second operator is read one proxy at a
  // time (each check is a 2-call batch) instead of relying on the client's batch size.
  const implementationsSecondary: ImplementationObservation[] = [];
  for (const entry of XLAYER_MAINNET.allowlist) {
    implementationsSecondary.push(await checkImplementation(secondary, entry, pinnedBlock));
  }

  const registryEntry = XLAYER_MAINNET.allowlist.find((entry) => entry.role === "siteRegistry");
  const factoryEntry = XLAYER_MAINNET.allowlist.find((entry) => entry.role === "factory");
  const bindingEntry = XLAYER_MAINNET.allowlist.find((entry) => entry.role === "domainBinding");
  if (registryEntry === undefined || factoryEntry === undefined || bindingEntry === undefined) {
    throw new Error("implementation allowlist is incomplete");
  }

  const registryImplementation = await readImplementationSlot(okx, registryEntry.proxy, pinnedBlock);
  const factoryImplementation = await readImplementationSlot(okx, factoryEntry.proxy, pinnedBlock);
  const bindingImplementation = await readImplementationSlot(okx, bindingEntry.proxy, pinnedBlock);

  const [registryImplementationCode, factoryImplementationCode, openerCode, bindingImplementationCode] =
    await Promise.all([
      requireCode(okx, registryImplementation, pinnedBlock, "SiteRegistry implementation"),
      requireCode(okx, factoryImplementation, pinnedBlock, "factory implementation"),
      requireCode(okx, XLAYER_MAINNET.opener, pinnedBlock, "opener"),
      requireCode(okx, bindingImplementation, pinnedBlock, "DomainBinding implementation"),
    ]);

  const processor = getAddress(
    await okx.readContract({
      address: XLAYER_MAINNET.factory,
      abi: factoryAbi,
      functionName: "cpuAt",
      args: [0n],
      blockNumber: pinnedBlock,
    }),
  );
  const container = getAddress(OBSERVED_XLAYER_SITE.container);
  const derivedContainer = getAddress(
    await okx.readContract({
      address: XLAYER_MAINNET.opener,
      abi: openerAbi,
      functionName: "accountOf",
      args: [processor, 2n],
      blockNumber: pinnedBlock,
    }),
  );
  if (!isAddressEqual(derivedContainer, container)) {
    throw new Error(
      `OBSERVED_XLAYER_SITE.container ${container} is not accountOf(processor,2)=${derivedContainer}; observation is stale`,
    );
  }
  const holder = getAddress(
    await okx.readContract({
      address: container,
      abi: containerAbi,
      functionName: "owner",
      blockNumber: pinnedBlock,
    }),
  );
  if (isAddressEqual(holder, NON_EDITOR)) {
    throw new Error("the non-editor probe address unexpectedly owns the container");
  }

  const chunkMax = await okx.readContract({
    address: registryEntry.proxy,
    abi: siteRegistryAbi,
    functionName: "CHUNK_MAX",
    blockNumber: pinnedBlock,
  });

  const [fileInfoOkx, fileInfoSecondary] = await Promise.all([
    readFileInfo(okx, registryEntry.proxy, container, OBSERVED_XLAYER_SITE.path, pinnedBlock),
    readFileInfo(secondary, registryEntry.proxy, container, OBSERVED_XLAYER_SITE.path, pinnedBlock),
  ]);
  const [bytesOkx, bytesSecondary] = await Promise.all([
    readFileBytesAt(okx, registryEntry.proxy, container, OBSERVED_XLAYER_SITE.path, { blockNumber: pinnedBlock }),
    readFileBytesAt(secondary, registryEntry.proxy, container, OBSERVED_XLAYER_SITE.path, {
      blockNumber: pinnedBlock,
    }),
  ]);

  context = {
    pinnedBlock,
    pinnedBlockHash: header.hash,
    okxOperator: primary.operator,
    secondaryOperator: secondaryEndpoint.operator,
    okx,
    secondary,
    implementationsOkx,
    implementationsSecondary,
    processor,
    container,
    holder,
    registryImplementationCode,
    factoryImplementationCode,
    openerCode,
    bindingImplementationCode,
    chunkMax,
    fileInfoOkx,
    fileInfoSecondary,
    bytesOkx,
    bytesSecondary,
  };
});

describe("P0-02: X Layer chain and implementation pin (read-only)", () => {
  it("both independent operators report chainId 196 at the same pinned block", async () => {
    const { okx, secondary, pinnedBlock, pinnedBlockHash } = ctx();
    const [primaryChainId, secondaryChainId] = await Promise.all([okx.getChainId(), secondary.getChainId()]);
    expect(primaryChainId, "primary operator chainId").toBe(196);
    expect(secondaryChainId, "second operator chainId").toBe(196);

    const [primaryBlock, secondaryBlock] = await Promise.all([
      okx.getBlock({ blockNumber: pinnedBlock }),
      secondary.getBlock({ blockNumber: pinnedBlock }),
    ]);
    expect(primaryBlock.hash, "primary operator pinned block hash").toBe(pinnedBlockHash);
    expect(secondaryBlock.hash, "second operator pinned block hash").toBe(pinnedBlockHash);
    expect(primaryBlock.number, "pinned block number").toBe(pinnedBlock);
  });

  it("all three proxies resolve to allowlisted implementations at the ERC-1967 slot", () => {
    const { implementationsOkx, implementationsSecondary } = ctx();
    expect(implementationsOkx).toHaveLength(3);
    for (const observation of implementationsOkx) {
      expect(observation.slot, `${observation.role} slot`).toBe(IMPL_SLOT);
      expect(observation.implementation, `${observation.role} implementation must be readable`).not.toBeNull();
      expect(observation.allowlisted, `${observation.role} implementation ${observation.implementation}`).toBe(true);
    }
    // One vote per operator: the second operator must see exactly the same implementations.
    const byRole = new Map(implementationsSecondary.map((entry) => [entry.role, entry.implementation?.toLowerCase()]));
    for (const observation of implementationsOkx) {
      expect(byRole.get(observation.role), `${observation.role} implementation must agree across operators`).toBe(
        observation.implementation?.toLowerCase(),
      );
    }
  });

  it("proxy bytecode is a small UUPS delegator and the implementation holds the logic", () => {
    const { implementationsOkx, registryImplementationCode, factoryImplementationCode, bindingImplementationCode } =
      ctx();
    for (const observation of implementationsOkx) {
      expect(observation.codeSize, `${observation.role} proxy bytecode size`).toBeGreaterThan(0);
      expect(observation.codeSize, `${observation.role} proxy bytecode size`).toBeLessThan(2_000);
    }
    expect(registryImplementationCode.length, "SiteRegistry implementation bytecode").toBeGreaterThan(20_000);
    expect(factoryImplementationCode.length, "factory implementation bytecode").toBeGreaterThan(10_000);
    expect(bindingImplementationCode.length, "DomainBinding implementation bytecode").toBeGreaterThan(10_000);
  });
});

describe("P0-03: ABI selectors and live return shapes (read-only)", () => {
  it("SiteRegistry read and write selectors are present in the implementation bytecode", () => {
    const { registryImplementationCode } = ctx();
    const signatures = {
      ...SITE_REGISTRY_READ_SIGNATURES,
      putFile: WRITE_SIGNATURES.putFile,
      appendChunk: WRITE_SIGNATURES.appendChunk,
      removeFile: WRITE_SIGNATURES.removeFile,
      setFallback: WRITE_SIGNATURES.setFallback,
      setOperator: WRITE_SIGNATURES.setOperator,
    };
    for (const [name, signature] of Object.entries(signatures)) {
      const selector = selectorOf(signature);
      expect(
        bytecodeContainsSelector(registryImplementationCode, selector),
        `${name} ${signature} (${selector}) missing from SiteRegistry implementation`,
      ).toBe(true);
    }
  });

  it("factory, opener and DomainBinding selectors are present in their bytecode", () => {
    const { factoryImplementationCode, openerCode, bindingImplementationCode } = ctx();
    for (const [name, signature] of Object.entries(FACTORY_SIGNATURES)) {
      expect(
        bytecodeContainsSelector(factoryImplementationCode, selectorOf(signature)),
        `factory ${name} selector missing`,
      ).toBe(true);
    }
    for (const [name, signature] of Object.entries(OPENER_SIGNATURES)) {
      expect(bytecodeContainsSelector(openerCode, selectorOf(signature)), `opener ${name} selector missing`).toBe(
        true,
      );
    }
    for (const [name, signature] of Object.entries(BINDING_SIGNATURES)) {
      expect(
        bytecodeContainsSelector(bindingImplementationCode, selectorOf(signature)),
        `DomainBinding ${name} selector missing`,
      ).toBe(true);
    }
  });

  it("live SiteRegistry.fileInfo decodes and matches the captured observation", () => {
    const { fileInfoOkx, fileInfoSecondary } = ctx();
    expect(fileInfoOkx.exists, "fileInfo.exists").toBe(true);
    expect(fileInfoOkx.size, "fileInfo.size").toBe(OBSERVED_XLAYER_SITE.size);
    expect(fileInfoOkx.chunkCount, "fileInfo.chunkCount").toBe(OBSERVED_XLAYER_SITE.chunkCount);
    expect(fileInfoOkx.contentType, "fileInfo.contentType").toBe("text/html; charset=utf-8");
    expect(fileInfoOkx.updatedAt, "fileInfo.updatedAt").toBeGreaterThan(0);
    expect(fileInfoOkx.sha256.toLowerCase(), "fileInfo.sha256").toBe(OBSERVED_XLAYER_SITE.sha256);
    // Second operator must see the same tuple at the same block.
    expect(fileInfoSecondary).toEqual(fileInfoOkx);
  });

  it("read() bytes hash to the declared SHA-256 on both operators", () => {
    const { bytesOkx, bytesSecondary, fileInfoOkx } = ctx();
    expect(bytesOkx.bytes.length, "primary read length").toBe(fileInfoOkx.size);
    expect(bytesSecondary.bytes.length, "second operator read length").toBe(fileInfoOkx.size);
    expect(bytesOkx.actualSha256.toLowerCase(), "primary operator recomputed SHA-256").toBe(
      fileInfoOkx.sha256.toLowerCase(),
    );
    expect(bytesSecondary.actualSha256.toLowerCase(), "second operator recomputed SHA-256").toBe(
      fileInfoOkx.sha256.toLowerCase(),
    );
    expect(sha256Hex(bytesOkx.bytes), "primary bytes vs declared hash").toBe(fileInfoOkx.sha256);
    expect(sha256Hex(bytesSecondary.bytes), "second operator bytes vs declared hash").toBe(fileInfoOkx.sha256);
    expect(bytesSecondary.actualSha256, "operators agree byte-for-byte").toBe(bytesOkx.actualSha256);
    expect(bytesSecondary.bytes, "operators agree on the raw bytes").toEqual(bytesOkx.bytes);
  });

  it("write calls from a non-editor revert with NotOwner(), distinguishing dispatch from an unknown selector", async () => {
    const { okx, pinnedBlock, container, holder, registryImplementationCode } = ctx();
    const registry = XLAYER_MAINNET.registries[0];
    if (registry === undefined) throw new Error("no SiteRegistry configured");

    const calldata: { readonly name: string; readonly data: Hex }[] = [
      {
        name: "putFile",
        data: encodeFunctionData({
          abi: siteRegistryAbi,
          functionName: "putFile",
          args: [container, "probe/p0-03-abi.txt", "text/plain", sha256Hex(new Uint8Array([0])), "0x00"],
        }),
      },
      {
        name: "appendChunk",
        data: encodeFunctionData({
          abi: siteRegistryAbi,
          functionName: "appendChunk",
          args: [container, OBSERVED_XLAYER_SITE.path, 0n, "0x00"],
        }),
      },
      {
        name: "removeFile",
        data: encodeFunctionData({
          abi: siteRegistryAbi,
          functionName: "removeFile",
          args: [container, "probe/p0-03-abi.txt"],
        }),
      },
      {
        name: "setFallback",
        data: encodeFunctionData({
          abi: siteRegistryAbi,
          functionName: "setFallback",
          args: [container, OBSERVED_XLAYER_SITE.path],
        }),
      },
      {
        name: "setOperator",
        data: encodeFunctionData({
          abi: siteRegistryAbi,
          functionName: "setOperator",
          args: [container, NON_EDITOR, 3600n],
        }),
      },
    ];

    for (const call of calldata) {
      expect(
        bytecodeContainsSelector(registryImplementationCode, call.data.slice(0, 10) as Hex),
        `${call.name} selector must be in the implementation bytecode`,
      ).toBe(true);
      const outcome = await ethCallAt(okx, registry, call.data, pinnedBlock, NON_EDITOR);
      expect(outcome.ok, `${call.name} from a non-editor must revert`).toBe(false);
      expect(outcome.revertData, `${call.name} revert payload must be the onlyEditor custom error`).toBe(
        NOT_OWNER_SELECTOR,
      );
    }

    // The same write calls are accepted when simulated from the current holder, so
    // the reverts above are authorization failures, not decoding failures.
    const putFile = calldata[0];
    if (putFile === undefined) throw new Error("putFile simulation missing");
    const holderOutcome = await ethCallAt(okx, registry, putFile.data, pinnedBlock, holder);
    expect(holderOutcome.ok, "putFile simulated from the current holder must be accepted").toBe(true);

    // Baseline: an unknown selector reverts without a meaningful custom-error payload,
    // so the 0x30cd7471 payload above is evidence of dispatch, not a generic revert.
    // Different nodes encode "no return data" as either absent data (null) or "0x".
    const unknown = await ethCallAt(okx, registry, "0xdeadbeef", pinnedBlock, NON_EDITOR);
    expect(unknown.ok, "unknown selector must revert").toBe(false);
    expect(unknown.revertData === null || unknown.revertData === "0x").toBe(true);
    expect(unknown.revertData, "unknown selector must not produce the onlyEditor error").not.toBe(
      NOT_OWNER_SELECTOR,
    );
  });

  it("CHUNK_MAX is enforced by the live implementation (CHUNK_MAX+1 reverts TooLarge)", async () => {
    const { okx, pinnedBlock, container, holder, chunkMax } = ctx();
    const registry = XLAYER_MAINNET.registries[0];
    if (registry === undefined) throw new Error("no SiteRegistry configured");
    expect(chunkMax, "CHUNK_MAX()").toBe(BigInt(EXPECTED_CHUNK_MAX));
    const oversizedBytes = Number(chunkMax) + 1;
    const data = encodeFunctionData({
      abi: siteRegistryAbi,
      functionName: "putFile",
      args: [
        container,
        "probe/p0-03-abi.txt",
        "text/plain",
        sha256Hex(new Uint8Array(oversizedBytes)),
        `0x${"00".repeat(oversizedBytes)}`,
      ],
    });
    const outcome = await ethCallAt(okx, registry, data, pinnedBlock, holder);
    expect(outcome.ok, "oversized putFile must revert").toBe(false);
    expect(outcome.revertData, "oversized putFile must revert with TooLarge()").toBe(TOO_LARGE_SELECTOR);
  });
});
