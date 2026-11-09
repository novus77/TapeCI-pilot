import { describe, expect, it } from "vitest";
import type { FileCheck } from "@tapeci/verifier";
import {
  checkJournalEvidence,
  deriveReleaseStatus,
  journalEvidenceFromState,
  matchReleaseFiles,
  type JournalStateLike,
  type ReleaseJournalEvidence,
  type ReleaseManifestView,
} from "@tapeci/verifier";
import { sha256Hex, utf8, type Hex } from "@tapeci/shared";

const ENTRY_SHA = sha256Hex(utf8("entry"));
const ASSET_SHA = sha256Hex(utf8("asset"));
const CONTAINER = `0x${"11".repeat(20)}` as Hex;
const REGISTRY = `0x${"22".repeat(20)}` as Hex;

function manifest(): ReleaseManifestView {
  return {
    chainId: 196,
    container: CONTAINER,
    siteRegistry: REGISTRY,
    commitSha: "a".repeat(40),
    releaseId: "r-aaaaaaaaaaaa-bbbbbbbb",
    entryPath: "index.html",
    fallbackPath: "index.html",
    files: [
      {
        path: "index.html",
        sourcePath: "index.html",
        size: 5,
        sha256: ENTRY_SHA,
        contentType: "text/html; charset=utf-8",
        chunks: 1,
      },
      {
        path: "releases/r-aaaaaaaaaaaa-bbbbbbbb/assets/app.js",
        sourcePath: "assets/app.js",
        size: 5,
        sha256: ASSET_SHA,
        contentType: "text/javascript; charset=utf-8",
        chunks: 1,
      },
    ],
  };
}

function check(
  path: string,
  sha256: Hex,
  options: { operators?: readonly string[]; declaredSha?: Hex } = {},
): FileCheck {
  const operators = options.operators ?? ["okx", "drpc"];
  const declared = options.declaredSha ?? sha256;
  return {
    path,
    expectedSha256: sha256,
    actualSha256: sha256,
    expectedSize: 5,
    actualSize: 5,
    matched: true,
    chunkCount: 1,
    contentType: "text/plain",
    updatedAt: 0,
    actualSha256ByOperator: Object.fromEntries(operators.map((operator) => [operator, sha256])),
    actualSizeByOperator: Object.fromEntries(operators.map((operator) => [operator, 5])),
    declaredByOperator: Object.fromEntries(
      operators.map((operator) => [
        operator,
        { sha256: declared, size: 5, chunkCount: 1, contentType: "text/plain", updatedAt: 0 },
      ]),
    ),
    operatorsAgree: true,
    errors: [],
  };
}

function journal(): ReleaseJournalEvidence {
  return {
    deploymentId: "dep-aaaaaaaaaaaa-bbbbbbbb",
    complete: true,
    transactions: [
      {
        fingerprint: sha256Hex(utf8("asset-op")),
        operation: "putFile",
        path: "releases/r-aaaaaaaaaaaa-bbbbbbbb/assets/app.js",
        chunkIndex: 0,
        nonce: "0",
        txHash: sha256Hex(utf8("asset-tx")),
        blockNumber: 10,
        gasUsed: 100_000n,
        status: "mined",
      },
      {
        fingerprint: sha256Hex(utf8("entry-op")),
        operation: "putFile",
        path: "index.html",
        chunkIndex: 0,
        nonce: "1",
        txHash: sha256Hex(utf8("entry-tx")),
        blockNumber: 11,
        gasUsed: 90_000n,
        status: "mined",
      },
    ],
    verifiedFiles: [
      { path: "index.html", sha256: ENTRY_SHA, size: 5, status: "UPLOADED" },
      {
        path: "releases/r-aaaaaaaaaaaa-bbbbbbbb/assets/app.js",
        sha256: ASSET_SHA,
        size: 5,
        status: "UPLOADED",
      },
    ],
  };
}

describe("P1-07 release file matching", () => {
  it("matches a manifest against an agreeing two-operator chain report", () => {
    const m = manifest();
    const result = matchReleaseFiles(m, [check("index.html", ENTRY_SHA), check(m.files[1]!.path, ASSET_SHA)]);
    expect(result.allMatched).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.files.every((file) => file.matched && file.operatorsAgree)).toBe(true);
  });

  it("detects a manifest/chain-declaration mismatch even when both operators agree", () => {
    const m = manifest();
    const result = matchReleaseFiles(
      m,
      [check("index.html", ENTRY_SHA, { declaredSha: sha256Hex(utf8("different")) }), check(m.files[1]!.path, ASSET_SHA)],
    );
    expect(result.allMatched).toBe(false);
    expect(result.files[0]?.manifestDeclarationMatchesChain).toBe(false);
  });

  it("detects a per-operator byte disagreement and a missing path", () => {
    const m = manifest();
    const base = check("index.html", ENTRY_SHA);
    const oneOperatorDifferent: FileCheck = {
      ...base,
      actualSha256ByOperator: {
        okx: ENTRY_SHA,
        drpc: sha256Hex(utf8("drpc-different")),
      },
    };
    const result = matchReleaseFiles(m, [oneOperatorDifferent]);
    expect(result.allMatched).toBe(false);
    expect(result.missing).toEqual([m.files[1]!.path]);
    expect(result.files[0]?.matched).toBe(false);
  });
});

describe("P1-07 journal evidence checks", () => {
  it("accepts a complete journal whose files and entry ordering match the manifest", () => {
    const result = checkJournalEvidence(manifest(), journal(), 12);
    expect(result.issues).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.verifiedFilesMatch).toBe(true);
    expect(result.transactionsOk).toBe(true);
    expect(result.allMinedBeforePin).toBe(true);
    expect(result.entryWrittenLast).toBe(true);
    expect(result.transactionCount).toBe(2);
    expect(result.totalGasUsed).toBe(190_000n);
  });

  it("flags missing verified files, failed transactions, a late pin and entry-before-assets", () => {
    const broken = journal();
    const result = checkJournalEvidence(
      manifest(),
      {
        ...broken,
        transactions: [
          { ...broken.transactions[0]!, blockNumber: 20 },
          { ...broken.transactions[1]!, blockNumber: 19 },
          { ...broken.transactions[0]!, fingerprint: sha256Hex(utf8("failed")), status: "failed" },
        ],
        verifiedFiles: [broken.verifiedFiles[0]!],
      },
      15,
    );
    expect(result.verifiedFilesMatch).toBe(false);
    expect(result.transactionsOk).toBe(false);
    expect(result.allMinedBeforePin).toBe(false);
    expect(result.entryWrittenLast).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("maps P1-06 journal state to chain-independent evidence", () => {
    const state: JournalStateLike = {
      deploymentId: "dep-1",
      complete: false,
      transactions: new Map([
        [
          "op-1",
          {
            intent: {
              fingerprint: sha256Hex(utf8("op-1")),
              operation: "putFile",
              path: "index.html",
              chunkIndex: 0,
              nonce: "4",
            },
            sent: { txHash: sha256Hex(utf8("tx-1")) },
            mined: { txHash: sha256Hex(utf8("tx-1")), blockNumber: "9", gasUsed: "12345" },
          },
        ],
        [
          "op-2",
          {
            intent: {
              fingerprint: sha256Hex(utf8("op-2")),
              operation: "appendChunk",
              path: "index.html",
              chunkIndex: 1,
              nonce: "5",
            },
            sent: { txHash: sha256Hex(utf8("tx-2")) },
          },
        ],
      ]),
      verifiedFiles: new Map([
        ["index.html", { path: "index.html", sha256: ENTRY_SHA, size: 5, status: "UPLOADED" }],
      ]),
    };
    const evidence = journalEvidenceFromState(state);
    expect(evidence.deploymentId).toBe("dep-1");
    expect(evidence.transactions.map((transaction) => transaction.status)).toEqual([
      "mined",
      "unresolved",
    ]);
    expect(evidence.transactions[0]?.blockNumber).toBe(9);
    expect(evidence.transactions[0]?.gasUsed).toBe(12_345n);
    expect(evidence.verifiedFiles).toHaveLength(1);
  });
});

describe("P1-07 release status", () => {
  it("maps chain status, file mismatch and journal issues", () => {
    expect(deriveReleaseStatus("VERIFIED", true, null)).toBe("VERIFIED");
    expect(deriveReleaseStatus("VERIFIED", false, null)).toBe("MISMATCH");
    expect(deriveReleaseStatus("UNSUPPORTED_IMPLEMENTATION", true, null)).toBe(
      "UNSUPPORTED_IMPLEMENTATION",
    );
    expect(deriveReleaseStatus("DISAGREEMENT", true, null)).toBe("DISAGREEMENT");
    expect(deriveReleaseStatus("INCOMPLETE", true, null)).toBe("INCOMPLETE");
    const journalCheck = {
      checked: true as const,
      deploymentId: "dep",
      complete: false,
      verifiedFilesMatch: false,
      transactionsOk: false,
      allMinedBeforePin: false,
      entryWrittenLast: false,
      transactionCount: 1,
      totalGasUsed: 0n,
      issues: ["journal is not complete"],
    };
    expect(deriveReleaseStatus("VERIFIED", true, journalCheck)).toBe("MISMATCH");
  });
});
