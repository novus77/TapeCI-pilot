/**
 * P0-04: container creation + SiteRegistry write-authorization matrix on an
 * Anvil fork of X Layer 196.
 *
 * The scenario itself is scripts/fork/authorization.ts (the same code the
 * standalone evidence script runs). These tests assert the on-chain evidence it
 * collected and then re-read the fork directly, so a scenario that only "looks"
 * successful cannot pass.
 */
import "./evidence-dir.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createForkClients, readFileBytesAt, readFileInfo, siteRegistryAbi } from "@tapeci/chain";
import { XLAYER_MAINNET } from "@tapeci/config";
import { sha256Hex, type Hex } from "@tapeci/shared";
import { startAnvilFork, type AnvilFork } from "../../scripts/fork/anvil.js";
import {
  AUTHORIZATION_EVIDENCE_FILE,
  runAuthorizationScenario,
  type AuthorizationEvidence,
} from "../../scripts/fork/authorization.js";
import { EVIDENCE_DIR, writeEvidence, type ForkClients } from "../../scripts/fork/support.js";

const EXPECTED_CHECK_IDS = [
  "AUTH-01",
  "AUTH-02",
  "AUTH-03",
  "AUTH-04",
  "AUTH-05",
  "AUTH-06",
  "AUTH-07",
  "AUTH-08",
  "AUTH-09",
  "AUTH-10",
  "AUTH-11",
  "AUTH-12",
] as const;

describe("P0-04 fork: container creation + write authorization", () => {
  let fork: AnvilFork | null = null;
  let clients: ForkClients | null = null;
  let evidence: AuthorizationEvidence | null = null;

  beforeAll(async () => {
    fork = await startAnvilFork();
    clients = createForkClients(fork.url);
    evidence = await runAuthorizationScenario(fork, {
      generatedBy: "tests/fork/authorization.test.ts",
      testClient: clients.testClient,
    });
    writeEvidence(AUTHORIZATION_EVIDENCE_FILE, evidence);
  });

  afterAll(async () => {
    if (fork) await fork.stop();
  });

  function requireEvidence(): AuthorizationEvidence {
    if (!evidence) {
      throw new Error(
        "P0-04 fork scenario did not produce evidence (see the beforeAll error above)",
      );
    }
    return evidence;
  }

  function requireClients(): ForkClients {
    if (!clients) throw new Error("fork clients are not initialized");
    return clients;
  }

  function requireFork(): AnvilFork {
    if (!fork) throw new Error("fork is not initialized");
    return fork;
  }

  it("runs against a local Anvil fork of X Layer 196 pinned to one fork block", () => {
    const activeFork = requireFork();
    const run = requireEvidence();
    expect(activeFork.chainId).toBe(196);
    expect(activeFork.forkBlockNumber).toBe(activeFork.requestedForkBlock);
    expect(run.fork.chainId).toBe(196);
    expect(run.fork.forkBlockNumber).toBe(Number(activeFork.forkBlockNumber));
    expect(run.fork.forkBlockHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(run.fork.sourceUrl).toMatch(/^https?:\/\//);
    expect(run.fork.anvilVersion).toMatch(/anvil/i);
  });

  it("opens the container through Opener.open from a funded impersonated EOA", () => {
    const run = requireEvidence();
    expect(run.create.openTx.status).toBe("success");
    expect(run.create.openTx.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(run.create.isOpened).toBe(true);
    expect(run.create.registryIsOpenedContainer).toBe(true);
    expect(run.create.containerCodeSize).toBeGreaterThan(0);
  });

  it("verifies identity: accountOf, ownerOf, container.token() == (196, processor, tokenId)", () => {
    const run = requireEvidence();
    expect(run.create.accountOf).toBe(run.fixture.container);
    expect(run.create.ownerOf).toBe(run.fixture.ownerAtForkBlock);
    expect(run.create.containerOwner).toBe(run.fixture.ownerAtForkBlock);
    expect(run.create.containerToken).toEqual({
      chainId: 196,
      processor: run.chain.processor,
      tokenId: run.fixture.tokenId,
    });
  });

  for (const checkId of EXPECTED_CHECK_IDS) {
    it(`${checkId}: scenario check passes`, () => {
      const run = requireEvidence();
      const recorded = run.checks.find((item) => item.id === checkId);
      expect(recorded, `missing check ${checkId}`).toBeDefined();
      expect(recorded?.pass, `${checkId}: ${recorded?.description ?? ""}`).toBe(true);
    });
  }

  it("records a real reverted transaction for every unauthorized write", () => {
    const run = requireEvidence();
    const rejections = [
      run.rejections.randomEoaBeforeOperator,
      run.rejections.randomEoaAfterOperatorSet,
      run.rejections.operatorAfterRevocation,
      run.rejections.operatorAfterTtlExpiry,
    ];
    for (const rejection of rejections) {
      expect(rejection.ethCall.reverted, rejection.case).toBe(true);
      expect(rejection.ethCall.selector, rejection.case).toMatch(/^0x[0-9a-f]{8}$/);
      expect(rejection.transaction.accepted, rejection.case).toBe(true);
      expect(rejection.transaction.txHash, rejection.case).toMatch(/^0x[0-9a-f]{64}$/);
      expect(rejection.transaction.receiptStatus, rejection.case).toBe("reverted");
      expect(rejection.stateUnchanged, rejection.case).toBe(true);
    }
    expect(run.authorizationModel.sharedRevertSelector).toMatch(/^0x[0-9a-f]{8}$/);
  });

  it("delegation is TTL-bounded in seconds and revocation is immediate", () => {
    const run = requireEvidence();
    expect(run.operator.observedTtlSeconds).toBe(120);
    expect(run.operator.grantUntilTimestamp).toBe(run.operator.grantedAtBlockTimestamp + 120);
    expect(run.operator.revocationUntilTimestamp).toBeLessThan(run.operator.grantUntilTimestamp);
    expect(run.rejections.operatorAfterRevocation.ethCall.reverted).toBe(true);
    expect(run.rejections.operatorAfterTtlExpiry.ethCall.reverted).toBe(true);
    expect(run.rejections.operatorAfterTtlExpiry.transaction.receiptStatus).toBe("reverted");
  });

  it("all recorded checks pass and the evidence JSON on disk matches the run", () => {
    const run = requireEvidence();
    expect(run.result.pass).toBe(true);
    expect(run.checks).toHaveLength(EXPECTED_CHECK_IDS.length);
    expect(run.result.failures).toEqual([]);
    const onDisk = JSON.parse(
      // Redirected for the same reason as the upload suite (P7-11): a run must not rewrite
      // the tracked record, so it reads back what it wrote.
      readFileSync(
        join(process.env["TAPECI_EVIDENCE_DIR"] ?? EVIDENCE_DIR, AUTHORIZATION_EVIDENCE_FILE),
        "utf8",
      ),
    ) as AuthorizationEvidence;
    expect(onDisk.kind).toBe("tapeci.fork.authorization.v1");
    expect(onDisk.fork.forkBlockNumber).toBe(run.fork.forkBlockNumber);
    expect(onDisk.fixture.container).toBe(run.fixture.container);
    expect(onDisk.result.pass).toBe(true);
  });

  it("re-reads the holder-written file from the fork after the scenario", async () => {
    const run = requireEvidence();
    const { publicClient } = requireClients();
    const registry = XLAYER_MAINNET.registries[0];
    expect(registry).toBeDefined();
    const written = run.writes.ownerPutFile;
    const info = await readFileInfo(
      publicClient,
      registry as Hex,
      run.fixture.container as Hex,
      written.path,
    );
    expect(info.exists).toBe(true);
    expect(info.size).toBe(written.size);
    expect(info.sha256.toLowerCase()).toBe(written.sha256.toLowerCase());
    const read = await readFileBytesAt(
      publicClient,
      registry as Hex,
      run.fixture.container as Hex,
      written.path,
    );
    expect(sha256Hex(read.bytes).toLowerCase()).toBe(written.sha256.toLowerCase());
    const pathCount = await publicClient.readContract({
      address: registry as Hex,
      abi: siteRegistryAbi,
      functionName: "pathCount",
      args: [run.fixture.container as Hex],
    });
    expect(Number(pathCount)).toBe(run.authorizationModel.expectedPathCount);
  });
});
