/**
 * P1-11 — the three-outcome chain read, proven against a real Anvil fork.
 *
 * P1-B's `inspectContainer` split (`verified` / `not_found` / `unavailable`) was
 * only ever exercised against a fake `ReadClient`; `isDeployed` was verified from
 * `docs/abi-validation.md` alone. This suite removes both caveats by reading the
 * real X Layer contracts through a local Anvil fork pinned to one block:
 *
 * 1. a genuinely opened container → `verified`, `opened: true`;
 * 2. a deployed-but-unopened container → `verified`, literal `opened: false`
 *    (fixture note below);
 * 3. an existing circuit whose container was never deployed → `not_found`
 *    (the chain answered "nothing here"), `opened: null`, never `false`;
 * 4. a real transport failure and a real node error → `unavailable` with
 *    `opened: null` and the failing stage recorded;
 * 5. `isDeployed`/`isOpened` selectors compared with the live contract, not docs.
 *
 * Fixture note for case 2: on X Layer today the opener only deploys a container
 * as part of `open`, and no close/undeploy path exists, so "deployed but not
 * opened" does not occur naturally. `findDeployedUnopenedState` (a scan of every
 * token on processor 0) found none at this pin. To exercise the real contract's
 * `opened: false` answer anyway, the suite copies the real 173-byte container
 * runtime (same proxy + token footer, `tokenId` word rewritten) to the real
 * counterfactual address with `anvil_setCode`. The `isOpened`/`isDeployed` reads
 * that `inspectContainer` performs are still real calls to the deployed opener;
 * no `ReadClient` is faked anywhere in this file.
 *
 * Requires Anvil on `PATH`:
 *   PATH="$HOME/.foundry/bin:$PATH" node .corepack/v1/pnpm/9.15.4/bin/pnpm.cjs \
 *     exec vitest run tests/fork/container-read.test.ts
 *
 * If the fork cannot start, the hook throws and the suite fails — it never
 * reports a skip as a pass (SPEC §15.1 / test-p0 R3–R4).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { XLAYER_MAINNET, type ChainConfig } from "@tapeci/config";
import {
  assertContainerVerified,
  ContainerReadUnavailableError,
  containerAbi,
  createForkClients,
  createReadClient,
  factoryAbi,
  inspectContainer,
  openerAbi,
  processorAbi,
  type ReadClient,
} from "@tapeci/chain";
import { InMemoryResourceIndex } from "../../apps/api/src/resource-index.js";
import { inspectResource } from "../../apps/api/src/resources.js";
import { startAnvilFork, type AnvilFork } from "../../scripts/fork/anvil.js";

const MAX_TOKEN_SCAN = 80n;
/** Far ahead of any fork head: a real node error, not a fabricated one. */
const FUTURE_BLOCK_OFFSET = 1_000_000n;
/** Nothing listens on port 1; this is a real connection refusal, not a stub. */
const DEAD_ENDPOINT = "http://127.0.0.1:1";
const EOA = getAddress("0x000000000000000000000000000000000000dEaD");

interface TokenFacts {
  readonly tokenId: bigint;
  readonly owner: Address;
  readonly container: Address;
  readonly opened: boolean;
  readonly codeBytes: number;
}

interface ForkContext {
  readonly fork: AnvilFork;
  readonly client: ReadClient;
  readonly config: ChainConfig;
  readonly pin: bigint;
  readonly processor: Address;
  readonly openedToken: TokenFacts;
  /** Two unopened circuits: the first stays natural, the second is used for the planted fixture. */
  readonly unopenedTokens: readonly [TokenFacts, TokenFacts];
}

let context: ForkContext | null = null;

describe("P1-11 fork: inspectContainer against real X Layer contracts", () => {
  beforeAll(async () => {
    const fork = await startAnvilFork();
    const client = createReadClient(fork.url);
    const pin = fork.forkBlockNumber;

    const vocabulary = await readChainVocabulary(client, XLAYER_MAINNET, pin);
    const scan = await scanProcessorTokens(client, XLAYER_MAINNET, vocabulary.processor, pin);

    context = {
      fork,
      client,
      config: XLAYER_MAINNET,
      pin,
      processor: vocabulary.processor,
      openedToken: scan.opened,
      unopenedTokens: scan.unopened,
    };
  }, 180_000);

  afterAll(async () => {
    if (context) await context.fork.stop();
  });

  it("runs against a real Anvil fork of X Layer 196 pinned to one block", () => {
    const ctx = requireContext();
    expect(ctx.fork.chainId).toBe(196);
    expect(ctx.fork.forkBlockNumber).toBe(ctx.fork.requestedForkBlock);
    expect(ctx.fork.forkBlockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ctx.fork.sourceUrl).toMatch(/^https?:\/\//);
    expect(ctx.fork.anvilVersion).toMatch(/anvil/i);
    expect(ctx.pin).toBe(ctx.fork.forkBlockNumber);
    // Evidence line for .superpowers/sdd/provisioning/test-p2.md (P1-11).
    console.log(
      `P1-11 fork evidence: chainId=${ctx.fork.chainId} block=${ctx.fork.forkBlockNumber} ` +
        `hash=${ctx.fork.forkBlockHash} source=${ctx.fork.sourceUrl} ` +
        `anvil="${ctx.fork.anvilVersion}" processor=${ctx.processor} ` +
        `openedToken=${ctx.openedToken.tokenId} unopenedTokens=${ctx.unopenedTokens.map((token) => token.tokenId).join(",")}`,
    );
  });

  it("verifies a genuinely opened container from real contract reads", async () => {
    const ctx = requireContext();
    const inspection = await inspectContainer(ctx.client, ctx.config, ctx.openedToken.container, ctx.pin);

    if (inspection.readStatus !== "verified") {
      throw new Error(
        `expected the opened container to verify, got ${inspection.readStatus} at stage ${inspection.failure?.stage ?? "?"}: ${inspection.failure?.message ?? inspection.reason ?? ""}`,
      );
    }
    expect(inspection.opened).toBe(true);
    expect(inspection.deployed).toBe(true);
    expect(inspection.owner).toBe(ctx.openedToken.owner);
    expect(inspection.container).toBe(ctx.openedToken.container);
    expect(inspection.tokenId).toBe(ctx.openedToken.tokenId);
    expect(inspection.processor).toBe(ctx.processor);
    expect(inspection.derivedMatches).toBe(true);
    expect(inspection.observedBlock).toBe(ctx.pin);

    const [chainId, tokenContract, tokenId] = await ctx.client.readContract({
      address: ctx.openedToken.container,
      abi: containerAbi,
      functionName: "token",
      blockNumber: ctx.pin,
    });
    expect(chainId).toBe(196n);
    expect(tokenContract).toBe(ctx.processor);
    expect(tokenId).toBe(ctx.openedToken.tokenId);
  });

  it("compares isDeployed/isOpened with the live opener instead of docs/abi-validation.md", async () => {
    const ctx = requireContext();
    const [openedDeployed, openedOpened, unopenedDeployed, unopenedOpened] = await Promise.all([
      readIsDeployed(ctx.client, ctx.config, ctx.processor, ctx.openedToken.tokenId, ctx.pin),
      readIsOpened(ctx.client, ctx.config, ctx.processor, ctx.openedToken.tokenId, ctx.pin),
      readIsDeployed(ctx.client, ctx.config, ctx.processor, ctx.unopenedTokens[0].tokenId, ctx.pin),
      readIsOpened(ctx.client, ctx.config, ctx.processor, ctx.unopenedTokens[0].tokenId, ctx.pin),
    ]);
    expect(openedDeployed).toBe(true);
    expect(openedOpened).toBe(true);
    expect(unopenedDeployed).toBe(false);
    expect(unopenedOpened).toBe(false);

    // The same real answers reach the container reader and the discovery service.
    const opened = requireVerified(
      await inspectContainer(ctx.client, ctx.config, ctx.openedToken.container, ctx.pin),
    );
    expect(opened.deployed).toBe(openedDeployed);
    expect(opened.opened).toBe(openedOpened);

    const resource = await inspectResource(
      { client: ctx.client, config: ctx.config, index: new InMemoryResourceIndex() },
      {
        processor: ctx.processor,
        tokenId: ctx.unopenedTokens[0].tokenId,
        blockNumber: ctx.pin,
      },
    );
    expect(resource.deployed).toBe(unopenedDeployed);
    expect(resource.opened).toBe(unopenedOpened);
  }, 240_000);

  it("keeps a real false as false when a container exists but is not opened", async () => {
    const ctx = requireContext();
    const target = ctx.unopenedTokens[1];
    // Copy the real container runtime and rewrite only the 32-byte tokenId footer.
    const realCode = await ctx.client.getCode({
      address: ctx.openedToken.container,
      blockNumber: ctx.pin,
    });
    if (realCode === undefined || realCode === "0x") {
      throw new Error("the opened container has no runtime code to copy");
    }
    const plantedCode = `${realCode.slice(0, -64)}${tokenIdWord(target.tokenId)}` as Hex;
    const { testClient } = createForkClients(ctx.fork.url);
    await testClient.setCode({ address: target.container, bytecode: plantedCode });

    expect(await readIsDeployed(ctx.client, ctx.config, ctx.processor, target.tokenId, ctx.pin)).toBe(true);
    expect(await readIsOpened(ctx.client, ctx.config, ctx.processor, target.tokenId, ctx.pin)).toBe(false);

    const inspection = await inspectContainer(ctx.client, ctx.config, target.container, ctx.pin);
    const verified = requireVerified(inspection);
    expect(verified.opened).toBe(false);
    expect(verified.opened).not.toBeNull();
    expect(verified.deployed).toBe(true);
    expect(verified.owner).toBe(target.owner);
    expect(verified.tokenId).toBe(target.tokenId);
    expect(verified.observedBlock).toBe(ctx.pin);
  }, 120_000);

  it("reports an undeployed container as explicit not_found with null facts, never false", async () => {
    const ctx = requireContext();
    const target = ctx.unopenedTokens[0];
    expect(target.codeBytes).toBe(0);

    // The real chain does answer `false` for this circuit's isOpened ...
    expect(await readIsOpened(ctx.client, ctx.config, ctx.processor, target.tokenId, ctx.pin)).toBe(false);

    // ... but the container address itself holds no code, so the truthful
    // container-level outcome is "nothing here" with unknown booleans.
    const inspection = await inspectContainer(ctx.client, ctx.config, target.container, ctx.pin);
    expect(inspection.readStatus).toBe("not_found");
    if (inspection.readStatus !== "not_found") throw new Error("unreachable");
    expect(inspection.reason).toBe("not_tapeout_container");
    expect(inspection.observedBlock).toBe(ctx.pin);
    expect(inspection.opened).toBeNull();
    expect(inspection.deployed).toBeNull();
    expect(inspection.owner).toBeNull();
    expect(inspection.opened).not.toBe(false);
  });

  it("derives a real false for an existing unopened circuit through inspectResource", async () => {
    const ctx = requireContext();
    const target = ctx.unopenedTokens[0];
    const resource = await inspectResource(
      { client: ctx.client, config: ctx.config, index: new InMemoryResourceIndex() },
      { processor: ctx.processor, tokenId: target.tokenId, blockNumber: ctx.pin },
    );
    expect(resource.readStatus).toBe("verified");
    expect(resource.opened).toBe(false);
    expect(resource.opened).not.toBeNull();
    expect(resource.deployed).toBe(false);
    // The §5 DTO normalizes addresses to lowercase; the chain layer keeps checksums.
    expect(resource.owner?.toLowerCase()).toBe(target.owner.toLowerCase());
    expect(resource.container?.toLowerCase()).toBe(target.container.toLowerCase());
    expect(resource.observedBlock).toBe(ctx.pin.toString(10));
    expect(resource.resource.tokenId).toBe(target.tokenId.toString(10));
  }, 240_000);

  it("turns a real transport failure into unavailable with opened=null, never false", async () => {
    const ctx = requireContext();
    const deadClient = createReadClient(DEAD_ENDPOINT);
    const inspection = await inspectContainer(deadClient, ctx.config, ctx.openedToken.container);
    expect(inspection.readStatus).toBe("unavailable");
    if (inspection.readStatus !== "unavailable") throw new Error("unreachable");
    expect(inspection.failure.stage).toBe("block");
    expect(inspection.failure.message.length).toBeGreaterThan(0);
    expect(inspection.observedBlock).toBeNull();
    expect(inspection.opened).toBeNull();
    expect(inspection.deployed).toBeNull();
    expect(inspection.owner).toBeNull();
    expect(inspection.opened).not.toBe(false);

    // The resolver-facing helper must say "retry this read", not "not opened".
    let thrown: unknown = null;
    try {
      assertContainerVerified(inspection);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContainerReadUnavailableError);
    const readError = thrown as ContainerReadUnavailableError;
    expect(readError.code).toBe("CONTAINER_READ_UNAVAILABLE");
    expect(readError.retryable).toBe(true);
    expect(readError.stage).toBe("block");
  }, 60_000);

  it("keeps a real node error at a future block unavailable, with opened still null", async () => {
    const ctx = requireContext();
    const futureBlock = ctx.pin + FUTURE_BLOCK_OFFSET;
    const inspection = await inspectContainer(ctx.client, ctx.config, ctx.openedToken.container, futureBlock);
    expect(inspection.readStatus).toBe("unavailable");
    if (inspection.readStatus !== "unavailable") throw new Error("unreachable");
    expect(inspection.failure.stage).toBe("token");
    expect(inspection.failure.message.length).toBeGreaterThan(0);
    expect(inspection.observedBlock).toBe(futureBlock);
    expect(inspection.opened).toBeNull();
    expect(inspection.deployed).toBeNull();
    expect(inspection.opened).not.toBe(false);
  }, 60_000);

  it("classifies a non-contract address as not_found, distinct from unavailable", async () => {
    const ctx = requireContext();
    const inspection = await inspectContainer(ctx.client, ctx.config, EOA, ctx.pin);
    expect(inspection.readStatus).toBe("not_found");
    if (inspection.readStatus !== "not_found") throw new Error("unreachable");
    expect(inspection.reason).toBe("not_tapeout_container");
    expect(inspection.observedBlock).toBe(ctx.pin);
    expect(inspection.opened).toBeNull();
    expect(inspection.deployed).toBeNull();
  });
});

function requireContext(): ForkContext {
  if (context === null) {
    throw new Error("the fork context was not initialized (see the beforeAll error above)");
  }
  return context;
}

function requireVerified(
  inspection: Awaited<ReturnType<typeof inspectContainer>>,
): Extract<Awaited<ReturnType<typeof inspectContainer>>, { readStatus: "verified" }> {
  if (inspection.readStatus !== "verified") {
    throw new Error(
      `expected verified, got ${inspection.readStatus}: ${inspection.failure?.message ?? inspection.reason ?? ""}`,
    );
  }
  return inspection;
}

async function readChainVocabulary(
  client: ReadClient,
  config: ChainConfig,
  pin: bigint,
): Promise<{ readonly processor: Address }> {
  const count = await client.readContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: "cpuCount",
    blockNumber: pin,
  });
  if (count < 1n) throw new Error(`factory ${config.factory} lists no processors at block ${pin}`);
  const processor = await client.readContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: "cpuAt",
    args: [0n],
    blockNumber: pin,
  });
  return { processor: getAddress(processor) };
}

/**
 * Find one genuinely opened container (real code + `isOpened: true`) and two
 * existing-but-unopened circuits (owner exists, container has no code). The scan
 * is bounded and re-reads every mutable value at the pinned block.
 */
async function scanProcessorTokens(
  client: ReadClient,
  config: ChainConfig,
  processor: Address,
  pin: bigint,
): Promise<{ readonly opened: TokenFacts; readonly unopened: readonly [TokenFacts, TokenFacts] }> {
  const unopened: TokenFacts[] = [];
  let opened: TokenFacts | null = null;
  for (let tokenId = 1n; tokenId <= MAX_TOKEN_SCAN; tokenId += 1n) {
    const facts = await readTokenFacts(client, config, processor, tokenId, pin);
    if (facts === null) continue;
    if (opened === null && facts.opened && facts.codeBytes > 0) opened = facts;
    if (!facts.opened && facts.codeBytes === 0 && unopened.length < 2) unopened.push(facts);
    if (opened !== null && unopened.length === 2) break;
  }
  if (opened === null) {
    throw new Error(
      `no opened container found on processor ${processor} in 1..${MAX_TOKEN_SCAN} at block ${pin}`,
    );
  }
  return { opened, unopened: requireTwoUnopened(unopened, processor, pin) };
}

function requireTwoUnopened(
  unopened: readonly TokenFacts[],
  processor: Address,
  pin: bigint,
): readonly [TokenFacts, TokenFacts] {
  const [first, second] = unopened;
  if (first === undefined || second === undefined) {
    throw new Error(
      `fewer than two unopened circuits found on processor ${processor} at block ${pin}; ` +
        "the deployed-but-unopened fixture needs two (one natural, one planted)",
    );
  }
  return [first, second];
}

async function readTokenFacts(
  client: ReadClient,
  config: ChainConfig,
  processor: Address,
  tokenId: bigint,
  pin: bigint,
): Promise<TokenFacts | null> {
  let owner: Address;
  try {
    owner = await client.readContract({
      address: processor,
      abi: processorAbi,
      functionName: "ownerOf",
      args: [tokenId],
      blockNumber: pin,
    });
  } catch {
    return null; // token does not exist on this processor
  }
  const [container, opened] = await Promise.all([
    client.readContract({
      address: config.opener,
      abi: openerAbi,
      functionName: "accountOf",
      args: [processor, tokenId],
      blockNumber: pin,
    }),
    client.readContract({
      address: config.opener,
      abi: openerAbi,
      functionName: "isOpened",
      args: [processor, tokenId],
      blockNumber: pin,
    }),
  ]);
  const code = await client.getCode({ address: container, blockNumber: pin });
  return {
    tokenId,
    owner: getAddress(owner),
    container: getAddress(container),
    opened,
    codeBytes: code === undefined ? 0 : (code.length - 2) / 2,
  };
}

async function readIsOpened(
  client: ReadClient,
  config: ChainConfig,
  processor: Address,
  tokenId: bigint,
  pin: bigint,
): Promise<boolean> {
  return client.readContract({
    address: config.opener,
    abi: openerAbi,
    functionName: "isOpened",
    args: [processor, tokenId],
    blockNumber: pin,
  });
}

async function readIsDeployed(
  client: ReadClient,
  config: ChainConfig,
  processor: Address,
  tokenId: bigint,
  pin: bigint,
): Promise<boolean> {
  return client.readContract({
    address: config.opener,
    abi: openerAbi,
    functionName: "isDeployed",
    args: [processor, tokenId],
    blockNumber: pin,
  });
}

/** 32-byte ABI word as bare hex (no `0x`), for splicing into the runtime code footer. */
function tokenIdWord(tokenId: bigint): string {
  return tokenId.toString(16).padStart(64, "0");
}
