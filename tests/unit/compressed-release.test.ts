import { describe, expect, it } from "vitest";
import { sha256Hex } from "@tapeci/shared";
import { computeArtifactDigest, releaseManifestHash } from "@tapeci/artifact";
import { XLAYER_MAINNET } from "@tapeci/config";
import { scanArtifactFiles } from "@tapeci/validator";
import { analyzeCompression, parsePackEntry } from "../../packages/compression/src/index.js";
import { prepareCompressedRelease } from "../../packages/release/src/compressed.js";

const context = { chainId: 196 as const, siteRegistry: XLAYER_MAINNET.registries[0]!, container: `0x${"11".repeat(20)}` as const, repositoryId: 77, commitSha: "a".repeat(40) };
function candidate(text = "red") {
  return analyzeCompression(scanArtifactFiles([
    { relativePath: "index.html", bytes: Buffer.from('<html><script src="app.js"></script><link rel="stylesheet" href="style.css"></html>') },
    { relativePath: "app.js", bytes: Buffer.from('console.log("same");'.repeat(200)) },
    { relativePath: "style.css", bytes: Buffer.from(`body{color:${text}}`.repeat(100)) },
  ]).files).candidates.find(candidate => candidate.index.strategy === "gzip-grouped")!;
}

describe("compressed physical release preparation", () => {
  it("commits to every physical byte with the existing strict Manifest v1", () => {
    const packed = candidate();
    const result = prepareCompressedRelease({ ...context, candidate: packed, spaFallback: true });
    expect(result.manifest.schemaVersion).toBe("tapeci.release.v1");
    expect(releaseManifestHash(result.manifest)).toBe(result.releaseManifestHash);
    expect(computeArtifactDigest(result.files)).toBe(result.artifactDigest);
    expect(result.sourceArtifactDigest).toBe(packed.index.sourceArtifactDigest);
    expect(result.artifactDigest).not.toBe(result.sourceArtifactDigest);
    const descriptor = parsePackEntry(result.entryBytes)!;
    expect(descriptor.indexSha256).toBe(packed.candidateId);
    expect(result.files.find(file => file.path === descriptor.indexPath)?.bytes).toEqual(new Uint8Array(packed.indexBytes));
    expect(result.entryBytes.length).toBeLessThanOrEqual(24_000);
    result.manifest.files.forEach(row => {
      const file = result.files.find(file => file.path === row.path)!;
      expect(sha256Hex(file.bytes)).toBe(row.sha256);
      expect(row.sourcePath).toBe(row.path);
      expect(file.bytes.length).toBe(row.size);
    });
  });

  it("reuses immutable object paths across releases and changes identity with signed fallback settings", () => {
    const before = prepareCompressedRelease({ ...context, candidate: candidate() });
    const after = prepareCompressedRelease({ ...context, candidate: candidate("blue"), commitSha: "b".repeat(40) });
    const shared = before.files.filter(file => file.path.startsWith("objects/")).filter(file => after.files.some(next => next.path === file.path));
    expect(shared.length).toBeGreaterThan(0);
    const changed = prepareCompressedRelease({ ...context, candidate: candidate(), spaFallback: true });
    expect(changed.sourceArtifactDigest).toBe(before.sourceArtifactDigest);
    expect(changed.releaseManifestHash).not.toBe(before.releaseManifestHash);
    expect(changed.releaseId).not.toBe(before.releaseId);
    expect(prepareCompressedRelease({ ...context, candidate: candidate() }).releaseManifestHash).toBe(before.releaseManifestHash);
  });

  it("rejects stale candidate identities and owns copies of the final physical bytes", () => {
    const packed = candidate();
    expect(() => prepareCompressedRelease({ ...context, candidate: { ...packed, candidateId: `0x${"0".repeat(64)}` } })).toThrow(/identity/i);
    const result = prepareCompressedRelease({ ...context, candidate: packed });
    packed.objects[0]!.bytes[0] = packed.objects[0]!.bytes[0]! ^ 1;
    expect(sha256Hex(result.files.find(file => file.path === packed.objects[0]!.path)!.bytes)).toBe(packed.objects[0]!.sha256);
  });

  it("rejects source paths reserved by the host gateway instead of dropping them", () => {
    const packed = analyzeCompression(scanArtifactFiles([{ relativePath: "index.html", bytes: Buffer.from("hello") }, { relativePath: "sw.js", bytes: Buffer.from("worker") }]).files).candidates[1]!;
    expect(() => prepareCompressedRelease({ ...context, candidate: packed })).toThrow(/reserved/i);
  });
});

it("normalizes target address casing like original release preparation", () => {
  const base = prepareCompressedRelease({ ...context, candidate: candidate() });
  const mixed = prepareCompressedRelease({ ...context, candidate: candidate(), siteRegistry: `0x${context.siteRegistry.slice(2).toUpperCase()}` });
  expect(mixed.manifest).toEqual(base.manifest);
  expect(mixed.releaseManifestHash).toBe(base.releaseManifestHash);
});
