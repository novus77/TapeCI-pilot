import { gzipSync, gunzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scanArtifactFiles } from "@tapeci/validator";
import { sha256Hex } from "@tapeci/shared";
import { analyzeCompression, decodeCandidate } from "../../packages/compression/src/index.js";
import { parsePackIndex } from "../../packages/compression/src/pack-index.js";

function source(css = "body{color:red}".repeat(200)) {
  return scanArtifactFiles([
    { relativePath: "index.html", bytes: Buffer.from('<html><link rel="stylesheet" href="style.css"></html>') },
    { relativePath: "style.css", bytes: Buffer.from(css) },
    { relativePath: "app.js", bytes: Buffer.from('console.log("hello");'.repeat(500)) },
    { relativePath: "empty.txt", bytes: Buffer.alloc(0) },
  ]).files;
}

describe("offline compression candidates", () => {
  it("preserves all files in real gzip objects and counts the actual index overhead", () => {
    const analysis = analyzeCompression(source());
    expect(analysis.report.compatibility).toBe("unverified");
    expect(analysis.report.estimatedFeeWei).toBeNull();
    expect(analysis.report.productionTotalBytes).toBeNull();
    expect(analysis.candidates.map(candidate => candidate.index.strategy)).toEqual([
      "original", "gzip-individual", "gzip-whole", "gzip-grouped",
    ]);
    const candidate = analysis.candidates.find(candidate => candidate.index.strategy === "gzip-whole")!;
    const object = candidate.objects[0]!;
    expect(object.encoding).toBe("gzip");
    const decoded = gunzipSync(object.bytes);
    candidate.index.files.forEach(file => {
      expect(decoded.subarray(file.offset, file.offset + file.size)).toEqual(Buffer.from(source().find(item => item.path === file.path)!.bytes));
    });
    const summary = analysis.report.candidates.find(item => item.strategy === "gzip-whole")!;
    expect(summary.analysisBytes).toBe(object.bytes.length + candidate.indexBytes.length);
    expect(summary.indexBytes).toBeGreaterThan(0);
    expect(summary.payloadChunks).toBe(1);
  });

  it("reproduces candidate identities when source order changes", () => {
    const first = analyzeCompression(source());
    const second = analyzeCompression([...source()].reverse());
    expect(second.candidates.map(candidate => candidate.candidateId)).toEqual(first.candidates.map(candidate => candidate.candidateId));
    expect(second.candidates.map(candidate => candidate.indexBytes)).toEqual(first.candidates.map(candidate => candidate.indexBytes));
  });

  it("uses identity encoding for resources that grow under gzip", () => {
    const files = scanArtifactFiles([
      { relativePath: "index.html", bytes: Buffer.from("hello") },
      { relativePath: "noise.bin", bytes: randomBytes(2048) },
    ]).files;
    const candidate = analyzeCompression(files).candidates.find(item => item.index.strategy === "gzip-individual")!;
    const row = candidate.index.files.find(file => file.path === "noise.bin")!;
    expect(candidate.objects.find(object => object.path === row.objectPath)?.encoding).toBe("identity");
    expect(candidate.objects.find(object => object.path === row.objectPath)?.bytes).toEqual(Buffer.from(files.find(file => file.path === "noise.bin")!.bytes));
  });

  it("deduplicates identical stored objects while retaining both file mappings", () => {
    const files = scanArtifactFiles([
      { relativePath: "index.html", bytes: Buffer.from("same") },
      { relativePath: "copy.txt", bytes: Buffer.from("same") },
    ]).files;
    const candidate = analyzeCompression(files).candidates[0]!;
    expect(candidate.objects).toHaveLength(1);
    expect(candidate.index.files).toHaveLength(2);
    expect(candidate.index.files[0]?.objectPath).toBe(candidate.index.files[1]?.objectPath);
  });

  it("reports reuse only within the same strategy and preserves unchanged script objects", () => {
    const before = analyzeCompression(source());
    const after = analyzeCompression(source("body{color:blue}".repeat(200)), { previous: before.report });
    const grouped = after.report.candidates.find(candidate => candidate.strategy === "gzip-grouped")!;
    expect(grouped.reusedObjectBytes).toBeGreaterThan(0);
    expect(grouped.changedObjectBytes).toBeGreaterThan(0);
    expect(after.report.candidates.find(candidate => candidate.strategy === "gzip-whole")!.reusedObjectBytes).toBe(0);
  });

  it("rejects duplicate and noncanonical paths and incorrect source hashes", () => {
    expect(() => analyzeCompression([source()[0]!, source()[0]!])).toThrow(/duplicate/i);
    expect(() => analyzeCompression([{ ...source()[0]!, path: "../index.html" }])).toThrow();
    expect(() => analyzeCompression([{ ...source()[0]!, sha256: sha256Hex(Buffer.from("wrong")) }])).toThrow(/hash/i);
    expect(() => analyzeCompression([{ ...source()[0]!, path: "/index.html" }])).toThrow(/canonical/i);
  });

  it("marks oversized stored units unavailable without losing valid original publication", () => {
    const files = scanArtifactFiles([
      { relativePath: "index.html", bytes: Buffer.from("<html></html>") },
      { relativePath: "a.bin", bytes: randomBytes(4_300_000) },
      { relativePath: "b.bin", bytes: randomBytes(4_300_000) },
    ]).files;
    const analysis = analyzeCompression(files);
    expect(analysis.candidates.some(candidate => candidate.index.strategy === "original")).toBe(true);
    expect(analysis.report.candidates.find(candidate => candidate.strategy === "gzip-whole")).toMatchObject({ available: false, candidateId: null });
  });
});


describe("verified candidate decoding", () => {
  it("reconstructs every file including empty files and shared objects", () => {
    const files = source();
    const analysis = analyzeCompression(files);
    analysis.candidates.forEach(candidate => {
      const decoded = decodeCandidate(candidate.index, new Map(candidate.objects.map(object => [object.path, object.bytes])));
      expect(decoded.map(file => ({ path: file.path, bytes: Buffer.from(file.bytes) }))).toEqual([...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ path: file.path, bytes: Buffer.from(file.bytes) })));
    });
    const duplicates = scanArtifactFiles([{ relativePath: "index.html", bytes: Buffer.from("same") }, { relativePath: "copy", bytes: Buffer.from("same") }]).files;
    const original = analyzeCompression(duplicates).candidates[0]!;
    expect(decodeCandidate(original.index, new Map(original.objects.map(object => [object.path, object.bytes])))).toHaveLength(2);
  });

  it("rejects corrupted, missing and unexpected stored objects", () => {
    const candidate = analyzeCompression(source()).candidates[2]!;
    const objects = new Map(candidate.objects.map(object => [object.path, object.bytes]));
    expect(() => decodeCandidate(candidate.index, new Map())).toThrow(/object/i);
    expect(() => decodeCandidate(candidate.index, new Map([...objects, ["unexpected", Buffer.alloc(0)]]))).toThrow(/object/i);
    const object = candidate.objects[0]!;
    const corrupt = Buffer.from(object.bytes);
    corrupt[0] = corrupt[0]! ^ 1;
    expect(() => decodeCandidate(candidate.index, new Map([[object.path, corrupt]]))).toThrow(/hash/i);
  });

  it("rejects an index whose total stored object bytes exceed the aggregate bound", () => {
    // Each object is individually capped at 8.4 MB, but 4,096 of them is ~34 GB — so without an
    // aggregate bound a hostile index could make a browser fetch tens of gigabytes before any
    // decoded-size check fires (Stage C review F4).
    const object = (index: number) => {
      const sha256 = `0x${index.toString(16).padStart(64, "0")}`;
      return {
        path: `objects/${sha256.slice(2)}.gz`,
        sha256,
        encoding: "gzip" as const,
        storedBytes: 8_000_000,
        decodedBytes: 8_000_000,
      };
    };
    const objects = Array.from({ length: 9 }, (_, index) => object(index + 1));
    const index = {
      schemaVersion: "tapeci.pack-index.v1",
      strategy: "gzip-whole",
      sourceArtifactDigest: `0x${"aa".repeat(32)}`,
      groupingPolicy: "type-groups-v1",
      entryPath: "index.html",
      encoder: { name: "gzip", node: "test", zlib: "test", level: 9 },
      files: [
        {
          path: "index.html",
          contentType: "text/html; charset=utf-8",
          size: 8_000_000,
          sha256: `0x${"bb".repeat(32)}`,
          objectPath: objects[0]!.path,
          offset: 0,
        },
      ],
      objects,
    };
    // 9 × 8 MB = 72 MB, above the 64 MiB aggregate bound.
    expect(() => parsePackIndex(index)).toThrow(/stored byte limit/i);
    // An absolute cap alone would still allow a 64 MB fetch that decodes to 8 bytes. The stored
    // total is tied to the decoded total, so this probe is refused too.
    const undercover = {
      ...index,
      objects: Array.from({ length: 8 }, (_, position) => ({ ...object(position + 1), decodedBytes: 1 })),
    };
    expect(() => parsePackIndex(undercover)).toThrow(/stored byte limit/i);
    // And the same index under the bound is accepted, so the check is not rejecting everything.
    expect(() => parsePackIndex({ ...index, objects: objects.slice(0, 2) })).not.toThrow();
  });

  it("rejects unsupported schemas, encodings and traversal", () => {
    const candidate = analyzeCompression(source()).candidates[2]!;
    const objects = new Map(candidate.objects.map(object => [object.path, object.bytes]));
    expect(() => decodeCandidate({ ...candidate.index, schemaVersion: "future" }, objects)).toThrow(/schema/i);
    expect(() => decodeCandidate({ ...candidate.index, objects: [{ ...candidate.index.objects[0], encoding: "zstd" }] }, objects)).toThrow(/encoding/i);
    expect(() => decodeCandidate({ ...candidate.index, files: candidate.index.files.map((file, i) => i === 0 ? { ...file, path: "../bad" } : file) }, objects)).toThrow();
  });

  it("rejects altered ranges, file hashes and source digests", () => {
    const candidate = analyzeCompression(source()).candidates[2]!;
    const objects = new Map(candidate.objects.map(object => [object.path, object.bytes]));
    expect(() => decodeCandidate({ ...candidate.index, files: candidate.index.files.map(file => ({ ...file, offset: file.offset + 1 })) }, objects)).toThrow();
    expect(() => decodeCandidate({ ...candidate.index, files: candidate.index.files.map(file => ({ ...file, sha256: sha256Hex(Buffer.from("wrong")) })) }, objects)).toThrow(/hash/i);
    expect(() => decodeCandidate({ ...candidate.index, sourceArtifactDigest: sha256Hex(Buffer.from("wrong")) }, objects)).toThrow(/digest/i);
  });

  it("bounds decompression by declared decoded size before allocating large output", () => {
    const candidate = analyzeCompression(source()).candidates[2]!;
    const bytes = gzipSync(Buffer.alloc(2_000_000, 65));
    const sha256 = sha256Hex(bytes);
    const path = `objects/${sha256.slice(2)}.gz`;
    const index = { ...candidate.index, objects: [{ ...candidate.index.objects[0], path, sha256, storedBytes: bytes.length, decodedBytes: 100 }], files: candidate.index.files.map(file => ({ ...file, objectPath: path })) };
    expect(() => decodeCandidate(index, new Map([[path, bytes]]))).toThrow();
  });

  it("rejects a valid payload with trailing bytes not mapped to any file", () => {
    const candidate = analyzeCompression(source()).candidates[2]!;
    const object = candidate.objects[0]!;
    const bytes = gzipSync(Buffer.concat([gunzipSync(object.bytes), Buffer.from("unmapped")]));
    const sha256 = sha256Hex(bytes);
    const path = `objects/${sha256.slice(2)}.gz`;
    const index = { ...candidate.index, objects: [{ ...candidate.index.objects[0], path, sha256, storedBytes: bytes.length, decodedBytes: object.decodedBytes + 8 }], files: candidate.index.files.map(file => ({ ...file, objectPath: path })) };
    expect(() => decodeCandidate(index, new Map([[path, bytes]]))).toThrow();
  });
});


it("does not claim strict scanning without an explicit scan context", () => {
  const scanned = scanArtifactFiles([{ relativePath: "index.html", bytes: Buffer.from('<img src="https://example.com/a.png">') }], { strictOnChain: false });
  expect(analyzeCompression(scanned.files).report.strictOnChain).toBeNull();
});


it("retains hash-verified aliases with different segment boundaries in one shared object", () => {
  const files = scanArtifactFiles([
    { relativePath: "index.html", bytes: Buffer.from("abc") },
    { relativePath: "a.bin", bytes: Buffer.from("ab") },
    { relativePath: "b.bin", bytes: Buffer.from("c") },
  ]).files;
  const candidate = analyzeCompression(files).candidates.find(item => item.index.strategy === "gzip-grouped")!;
  expect(candidate.objects).toHaveLength(1);
  expect(decodeCandidate(candidate.index, new Map(candidate.objects.map(object => [object.path, object.bytes]))).map(file => Buffer.from(file.bytes).toString())).toEqual(["ab", "c", "abc"]);
});

it("rejects excessive source counts and advertised decoded sizes", () => {
  expect(() => analyzeCompression(Array.from({ length: 4097 }, () => source()[0]!))).toThrow(/count/i);
  const candidate = analyzeCompression(source()).candidates[2]!;
  const index = { ...candidate.index, objects: candidate.index.objects.map(object => ({ ...object, decodedBytes: 64 * 1024 * 1024 + 1 })) };
  expect(() => decodeCandidate(index, new Map(candidate.objects.map(object => [object.path, object.bytes])))).toThrow(/limit/i);
});
