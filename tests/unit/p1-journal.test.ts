import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadClient } from "@tapeci/chain";
import {
  DeploymentJournal,
  NonceLock,
  deriveDeploymentId,
  journalPathForDirectory,
  operationFingerprint,
  planFingerprint,
  readJournalState,
  RELEASE_PLAN_SCHEMA_VERSION,
  type JournalPlanEvent,
  type ReleasePlan,
} from "@tapeci/deployer";
import { TapeCiError, sha256Hex, utf8, type Hex } from "@tapeci/shared";

const temporaryDirectories: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tapeci-journal-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

const hex = (value: string): Hex => sha256Hex(utf8(value));
const CONTAINER = `0x${"11".repeat(20)}` as Hex;
const REGISTRY = `0x${"22".repeat(20)}` as Hex;
const COMMIT = "a".repeat(40);
const DEPLOYMENT_ID = "dep-aaaaaaaaaaaa-abcdef12";

function planEventInput(): Omit<JournalPlanEvent, "v" | "at"> {
  return {
    type: "plan",
    deploymentId: DEPLOYMENT_ID,
    planFingerprint: hex("plan"),
    releaseManifestHash: hex("manifest"),
    artifactDigest: hex("artifact"),
    chainId: 196,
    container: CONTAINER,
    siteRegistry: REGISTRY,
    commitSha: COMMIT,
    releaseId: "r-aaaaaaaaaaaa-bbbbbbbb",
    entryPath: "index.html",
    pinnedBlockNumber: "123",
    planJson: { schemaVersion: RELEASE_PLAN_SCHEMA_VERSION },
  };
}

function intentInput(fingerprint: Hex, nonce = "7"): Parameters<DeploymentJournal["append"]>[0] {
  return {
    type: "tx_intent",
    deploymentId: DEPLOYMENT_ID,
    fingerprint,
    operation: "putFile",
    path: "index.html",
    chunkIndex: 0,
    nonce,
    dataSha256: hex("data"),
    dataBytes: 10,
    expectIndex: null,
  };
}

describe("P1-06 deployment journal", () => {
  it("appends and replays plan, intent, send, mined, verified and completion events", async () => {
    const dir = await tempDir();
    const path = join(dir, "dep.jsonl");
    const fingerprint = hex("op");
    const journal = await DeploymentJournal.open(path);
    await journal.append(planEventInput());
    await journal.append(intentInput(fingerprint));
    await journal.append({
      type: "tx_sent",
      deploymentId: DEPLOYMENT_ID,
      fingerprint,
      txHash: hex("tx"),
      nonce: "7",
    });
    await journal.append({
      type: "tx_mined",
      deploymentId: DEPLOYMENT_ID,
      fingerprint,
      txHash: hex("tx"),
      blockNumber: "124",
      blockHash: hex("block"),
      gasUsed: "21000",
    });
    await journal.append({
      type: "file_verified",
      deploymentId: DEPLOYMENT_ID,
      path: "index.html",
      sha256: hex("file"),
      size: 10,
      status: "UPLOADED",
      transactionCount: 1,
    });
    await journal.append({
      type: "deployment_complete",
      deploymentId: DEPLOYMENT_ID,
      releaseManifestHash: hex("manifest"),
      verifiedFiles: 1,
      totalTransactions: 1,
    });
    expect(journal.state.complete).toBe(true);
    expect(journal.state.transactions.size).toBe(1);
    expect(journal.maxConsumedNonce()).toBe(7n);
    expect(journal.state.events).toHaveLength(6);
    await journal.close();

    const replayed = await readJournalState(path);
    expect(replayed.complete).toBe(true);
    expect(replayed.deploymentId).toBe(DEPLOYMENT_ID);
    expect(replayed.verifiedFiles.get("index.html")?.sha256).toBe(hex("file"));
    expect(replayed.transactions.get(fingerprint)?.mined?.gasUsed).toBe("21000");
    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter((line) => line.length > 0)).toHaveLength(6);
  });

  it("drops a partial trailing line left by a crash and can continue appending", async () => {
    const dir = await tempDir();
    const path = join(dir, "partial.jsonl");
    const planLine = JSON.stringify({ v: 1, at: "2026-10-19T00:00:00.000Z", ...planEventInput() });
    await writeFile(path, `${planLine}\n{"v":1,"type":"tx_int`);
    const journal = await DeploymentJournal.open(path);
    expect(journal.state.events).toHaveLength(1);
    expect(journal.state.plan?.deploymentId).toBe(DEPLOYMENT_ID);
    await journal.append({
      type: "note",
      deploymentId: DEPLOYMENT_ID,
      message: "resumed after crash",
    });
    await journal.close();
    const replayed = await readJournalState(path);
    expect(replayed.events).toHaveLength(2);
    expect(replayed.complete).toBe(false);
  });

  it("rejects duplicate fingerprints, wrong deployments and events after completion", async () => {
    const dir = await tempDir();
    const path = join(dir, "rules.jsonl");
    const fingerprint = hex("op");
    const journal = await DeploymentJournal.open(path);
    await journal.append(planEventInput());
    await journal.append(intentInput(fingerprint));
    await expect(journal.append(intentInput(fingerprint))).rejects.toThrowError(TapeCiError);
    await expect(
      journal.append({
        type: "note",
        deploymentId: "dep-different",
        message: "wrong deployment",
      }),
    ).rejects.toThrowError(TapeCiError);
    await journal.append({
      type: "deployment_complete",
      deploymentId: DEPLOYMENT_ID,
      releaseManifestHash: hex("manifest"),
      verifiedFiles: 0,
      totalTransactions: 1,
    });
    await expect(
      journal.append({
        type: "note",
        deploymentId: DEPLOYMENT_ID,
        message: "after completion",
      }),
    ).rejects.toThrowError(TapeCiError);
    await journal.close();
  });

  it("takes an exclusive lock and releases it on close", async () => {
    const dir = await tempDir();
    const path = join(dir, "locked.jsonl");
    const first = await DeploymentJournal.open(path);
    await first.append(planEventInput());
    await expect(DeploymentJournal.open(path)).rejects.toMatchObject({ code: "UPLOAD_INTERRUPTED" });
    await first.close();
    const second = await DeploymentJournal.open(path);
    expect(second.state.plan?.deploymentId).toBe(DEPLOYMENT_ID);
    await second.close();
  });
});

describe("P1-06 nonce lock", () => {
  function fakeJournal(consumed: bigint | null, unresolved = 0): DeploymentJournal {
    return {
      maxConsumedNonce: () => consumed,
      unresolvedTransactions: () =>
        Array.from({ length: unresolved }, () => ({
          fingerprint: hex("op"),
          intent: intentInput(hex("op")),
        })),
    } as unknown as DeploymentJournal;
  }

  function fakeClient(chainNonce: number): Pick<ReadClient, "getTransactionCount"> {
    return {
      getTransactionCount: async () => chainNonce,
    } as unknown as Pick<ReadClient, "getTransactionCount">;
  }

  it("starts at the pending chain nonce and serializes concurrent allocations", async () => {
    const lock = new NonceLock({
      client: fakeClient(6),
      signer: CONTAINER,
      journal: fakeJournal(null),
    });
    const allocated = await Promise.all([lock.allocate(), lock.allocate(), lock.allocate()]);
    expect(allocated).toEqual([6n, 7n, 8n]);
  });

  it("never goes below a journal-consumed nonce", async () => {
    const lock = new NonceLock({
      client: fakeClient(3),
      signer: CONTAINER,
      journal: fakeJournal(5n),
    });
    expect(await lock.allocate()).toBe(6n);
  });

  it("refuses to allocate while a sent transaction is unresolved", async () => {
    const lock = new NonceLock({
      client: fakeClient(6),
      signer: CONTAINER,
      journal: fakeJournal(null, 1),
    });
    await expect(lock.allocate()).rejects.toMatchObject({ code: "UPLOAD_INTERRUPTED" });
  });
});

describe("P1-06 fingerprints and paths", () => {
  it("fingerprints one chunk write deterministically and distinctly", () => {
    const base = {
      container: CONTAINER,
      operation: "appendChunk" as const,
      path: "assets/app.js",
      chunkIndex: 1,
      contentType: "text/javascript",
      sha256: hex("file"),
      data: utf8("abc"),
      expectIndex: 1n,
    };
    expect(operationFingerprint(base)).toBe(operationFingerprint({ ...base }));
    expect(operationFingerprint({ ...base, chunkIndex: 2, expectIndex: 2n })).not.toBe(
      operationFingerprint(base),
    );
    expect(operationFingerprint({ ...base, path: "assets/app2.js" })).not.toBe(
      operationFingerprint(base),
    );
  });

  it("derives a deterministic deployment id and journal path", () => {
    const plan = {
      schemaVersion: RELEASE_PLAN_SCHEMA_VERSION,
      chainId: 196 as const,
      container: CONTAINER,
      siteRegistry: REGISTRY,
      commitSha: COMMIT,
      releaseId: "r-aaaaaaaaaaaa-bbbbbbbb",
      artifactDigest: hex("artifact"),
      releaseManifestHash: hex("manifest"),
    } satisfies Pick<
      ReleasePlan,
      | "schemaVersion"
      | "chainId"
      | "container"
      | "siteRegistry"
      | "commitSha"
      | "releaseId"
      | "artifactDigest"
      | "releaseManifestHash"
    >;
    expect(deriveDeploymentId(plan)).toBe("dep-aaaaaaaaaaaa-c7c5c1d7");
    expect(planFingerprint(plan)).toBe(planFingerprint({ ...plan }));
    expect(planFingerprint({ ...plan, commitSha: "b".repeat(40) })).not.toBe(planFingerprint(plan));
    expect(journalPathForDirectory("/tmp/tapeci/", plan as ReleasePlan)).toBe(
      `/tmp/tapeci/${deriveDeploymentId(plan)}.jsonl`,
    );
  });
});
