import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeCompression } from "../../packages/compression/src/index.js";
import { prepareCompressedRelease, prepareVersionedRelease } from "@tapeci/release";
import { scanArtifactFiles } from "@tapeci/validator";
import { LocalObjectStore } from "@tapeci/github";
import { freezePreparedArtifact, loadPreparedArtifact } from "../../apps/api/src/worker/prepared-artifact.js";
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const context = { projectId: "11111111-1111-4111-8111-111111111111", repositoryId: 1, commitSha: "a".repeat(40), chainId: 196 as const, siteRegistry: `0x${"11".repeat(20)}` as const, container: `0x${"22".repeat(20)}` as const, sourceArtifactKey: `sha256/${"33".repeat(32)}.tar`, sourceArtifactSha256: `0x${"33".repeat(32)}` as const };
const source = scanArtifactFiles([{ relativePath: "index.html", bytes: Buffer.from('<html><script src="app.js"></script></html>') }, { relativePath: "app.js", bytes: Buffer.from('console.log("frozen");'.repeat(200)) }]).files;

describe("prepared release snapshots", () => {
  it("persists deterministic actual tar bytes and reloads exact original final bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tapeci-prepared-")); temporary.push(root);
    const store = new LocalObjectStore(root);
    const prepared = prepareVersionedRelease({ ...context, files: source });
    const files = prepared.manifest.files.map(row => ({ sourcePath: row.sourcePath, bytes: row.path === "index.html" ? prepared.entryBytes : source.find(file => file.path === row.sourcePath)!.bytes }));
    const input = { context, request: { schemaVersion: "tapeci.preparation.v1" as const, mode: "original" as const, spaFallback: false }, prepared, files };
    const first = await freezePreparedArtifact(store, input);
    const second = await freezePreparedArtifact(store, input);
    expect(second.key).toBe(first.key);
    const loaded = await loadPreparedArtifact(store, first.key, { context, request: input.request, manifestSha256: prepared.releaseManifestHash });
    expect(loaded.prepared.releaseManifestHash).toBe(prepared.releaseManifestHash);
    expect(Buffer.from(loaded.prepared.entryBytes)).toEqual(Buffer.from(prepared.entryBytes));
    expect(loaded.files.map(file => Buffer.from(file.bytes))).toEqual(files.map(file => Buffer.from(file.bytes)));
  });

  it("restores compressed physical bytes without a source build or recompression", async () => {
    const root = await mkdtemp(join(tmpdir(), "tapeci-prepared-")); temporary.push(root);
    const store = new LocalObjectStore(root);
    const candidate = analyzeCompression(source).candidates[2]!;
    const compressed = prepareCompressedRelease({ ...context, candidate });
    const request = { schemaVersion: "tapeci.preparation.v1" as const, mode: "gzip-whole" as const, spaFallback: false, gatewayId: "local-qualified" };
    const pin = await freezePreparedArtifact(store, { context, request, prepared: compressed, files: compressed.files.map(file => ({ sourcePath: file.sourceRelativePath, bytes: file.bytes })) });
    const loaded = await loadPreparedArtifact(store, pin.key, { context, request, manifestSha256: compressed.releaseManifestHash });
    expect(loaded.prepared.manifest).toEqual(compressed.manifest);
    expect(loaded.files.map(file => Buffer.from(file.bytes))).toEqual(compressed.files.map(file => Buffer.from(file.bytes)));
    await expect(loadPreparedArtifact(store, pin.key, { context: { ...context, commitSha: "b".repeat(40) }, request, manifestSha256: compressed.releaseManifestHash })).rejects.toThrow(/context/i);
    await expect(loadPreparedArtifact(store, pin.key, { context, request: { ...request, spaFallback: true }, manifestSha256: compressed.releaseManifestHash })).rejects.toThrow(/request|context/i);
  });
});

it("produces the same snapshot key under different actual process umasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "tapeci-prepared-umask-")); temporary.push(root);
  const store = new LocalObjectStore(root);
  const prepared = prepareVersionedRelease({ ...context, files: source });
  const files = prepared.manifest.files.map(row => ({ sourcePath: row.sourcePath, bytes: row.path === "index.html" ? prepared.entryBytes : source.find(file => file.path === row.sourcePath)!.bytes }));
  const input = { context, request: { schemaVersion: "tapeci.preparation.v1" as const, mode: "original" as const, spaFallback: false }, prepared, files };
  const previous = process.umask(0o077);
  try {
    const first = await freezePreparedArtifact(store, input);
    process.umask(0o022);
    const second = await freezePreparedArtifact(store, input);
    expect(second.key).toBe(first.key);
  } finally { process.umask(previous); }
});
