import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@tapeci/shared";
import { scanArtifactFiles } from "@tapeci/validator";
import { analyzeCompression } from "../../packages/compression/src/index.js";
import { buildPackEntry, parsePackEntry } from "../../packages/compression/src/entry.js";
import { openPackedSite } from "../../packages/compression/src/tapekit.js";
import type { TapeKitFile } from "../../packages/compression/src/tapekit.js";

function fixture(options: { htmlType?: string } = {}) {
  const candidate = analyzeCompression(scanArtifactFiles([
    { relativePath: "index.html", bytes: Buffer.from('<html><script src="app.js"></script></html>') },
    { relativePath: "docs/index.html", bytes: Buffer.from("<h1>Docs</h1>") },
    { relativePath: "app.js", bytes: Buffer.from('console.log("packed");'.repeat(400)) },
  ]).files.map(file => file.path === "index.html" && options.htmlType ? { ...file, contentType: options.htmlType } : file)).candidates.find(candidate => candidate.index.strategy === "gzip-grouped")!;
  const descriptor = { schemaVersion: "tapeci.pack-entry.v1" as const, indexPath: `tapeci-packs/${candidate.candidateId.slice(2)}.json`, indexSha256: candidate.candidateId, indexBytes: candidate.indexBytes.length, spaFallback: true };
  const files = new Map<string, TapeKitFile>();
  function put(path: string, bytes: Uint8Array, contentType = "application/octet-stream") {
    files.set(path, { path, bytes, size: bytes.length, sha256: sha256Hex(bytes), contentType, verified: true, status: "ok" });
  }
  put("index.html", buildPackEntry(descriptor), "text/html");
  put(descriptor.indexPath, candidate.indexBytes, "application/json");
  candidate.objects.forEach(object => put(object.path, object.bytes));
  const site = { manifest: { pathSet: new Set(files.keys()) }, get: async (path: string) => files.get(path.replace(/^\//, "")) ?? files.get("index.html")! };
  return { candidate, descriptor, files, site };
}

describe("TapeKit packed site trust chain", () => {
  it("passes ordinary sites through without changing their original get behavior", async () => {
    const bytes = Buffer.from("<h1>ordinary</h1>");
    const site = { manifest: { pathSet: new Set(["index.html"]) }, get: async () => ({ path: "index.html", bytes, size: bytes.length, contentType: "text/html", sha256: sha256Hex(bytes), verified: true, status: "ok" }) };
    expect(await openPackedSite(site)).toBe(site);
  });

  it("resolves packed files with transitive proof and keeps immutable source metadata", async () => {
    const f = fixture();
    const wrapped = await openPackedSite(f.site);
    const file = (await wrapped.get("/app.js"))!;
    expect(Buffer.from(file.bytes!).toString()).toBe('console.log("packed");'.repeat(400));
    expect(file.verified).toBe(true);
    expect(file.compression?.indexSha256).toBe(f.candidate.candidateId);
    expect(file.sha256).toBe(f.candidate.index.files.find(file => file.path === "app.js")?.sha256);
    expect(await wrapped.get("/missing.json", { navigation: true, accept: "text/html" })).toBeNull();
    expect((await wrapped.get("/route", { navigation: true, accept: "text/html" }))?.path).toBe("index.html");
    expect(await wrapped.get("/missing%2Ejson", { navigation: true, accept: "text/html" })).toBeNull();
    expect(wrapped.manifest).toBe(f.site.manifest);
  });

  it("refuses unverified entry bytes and no-hash index results", async () => {
    const f = fixture();
    f.files.set("index.html", { ...f.files.get("index.html")!, verified: false, status: "no-hash" });
    await expect(openPackedSite(f.site)).rejects.toThrow(/verified/i);
    const second = fixture();
    second.files.set(second.descriptor.indexPath, { ...second.files.get(second.descriptor.indexPath)!, verified: false, status: "no-hash" });
    await expect(openPackedSite(second.site)).rejects.toThrow(/verified/i);
  });

  it("never accepts the upstream fallback for a missing index or object", async () => {
    const f = fixture();
    f.site.manifest.pathSet.delete(f.descriptor.indexPath);
    await expect(openPackedSite(f.site)).rejects.toThrow(/missing/i);
    const second = fixture();
    const object = second.candidate.index.files.find(file => file.path === "app.js")!.objectPath;
    second.site.manifest.pathSet.delete(object);
    const wrapped = await openPackedSite(second.site);
    await expect(wrapped.get("/app.js")).rejects.toThrow(/missing/i);
  });

  it("rejects mismatched returned paths and corrupt stored bytes even if marked verified", async () => {
    const f = fixture();
    f.files.set(f.descriptor.indexPath, { ...f.files.get(f.descriptor.indexPath)!, path: "index.html" });
    await expect(openPackedSite(f.site)).rejects.toThrow(/path/i);
    const second = fixture();
    const object = second.candidate.index.files.find(file => file.path === "app.js")!.objectPath;
    const original = second.files.get(object)!;
    const bytes = Buffer.from(original.bytes!);
    bytes[0] = bytes[0]! ^ 1;
    second.files.set(object, { ...original, bytes });
    const wrapped = await openPackedSite(second.site);
    await expect(wrapped.get("app.js")).rejects.toThrow(/hash/i);
  });

  it("validates recognized descriptors strictly while preserving arbitrary original HTML", () => {
    const f = fixture();
    expect(parsePackEntry(buildPackEntry(f.descriptor))).toEqual(f.descriptor);
    expect(parsePackEntry(Buffer.from("<!doctype html><h1>ordinary</h1>"))).toBeNull();
    expect(() => buildPackEntry({ ...f.descriptor, indexBytes: 0 })).toThrow();
    expect(() => buildPackEntry({ ...f.descriptor, indexPath: "../bad.json" })).toThrow();
    const malformed = Buffer.from(`<!doctype html>\n<!--tapeci.pack-entry.v1\n${canonicalJson({ ...f.descriptor, unknown: true })}\n-->`);
    expect(() => parsePackEntry(malformed)).toThrow();
  });
});


it("preserves extensionless directory indexes and the gateway's MIME sanitization", async () => {
  const f = fixture({ htmlType: "text/html\n; charset=utf-8" });
  const wrapped = await openPackedSite(f.site);
  expect((await wrapped.get("/docs"))?.path).toBe("docs/index.html");
  expect((await wrapped.get("/docs", { navigation: true, accept: "text/html" }))?.path).toBe("docs/index.html");
  expect((await wrapped.get("/"))?.contentType).toBe("text/html; charset=utf-8");
});

it("preserves the original transport error identity for both index and object failures", async () => {
  const f = fixture();
  const outage = new Error("fixture RPC unavailable");
  const indexSite = { ...f.site, get: async (path: string) => { if (path === f.descriptor.indexPath) throw outage; return f.site.get(path); } };
  await expect(openPackedSite(indexSite)).rejects.toBe(outage);
  const objectSite = { ...f.site, get: async (path: string) => { if (path.startsWith("objects/")) throw outage; return f.site.get(path); } };
  const wrapped = await openPackedSite(objectSite);
  await expect(wrapped.get("/app.js")).rejects.toBe(outage);
});
