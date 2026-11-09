import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { canonicalJson, sha256Hex } from "@tapeci/shared";
import { scanArtifactFiles } from "@tapeci/validator";
import { analyzeCompression } from "../../packages/compression/src/index.js";
import { servePackRequest } from "../../packages/compression/src/gateway.js";
import { createBrowserPack } from "../../packages/compression/src/browser.js";

function candidate() {
  return analyzeCompression(scanArtifactFiles([
    { relativePath: "index.html", bytes: Buffer.from('<html><script src="app.js"></script></html>') },
    { relativePath: "app.js", bytes: Buffer.from('console.log("packed");'.repeat(300)) },
    { relativePath: "empty.txt", bytes: Buffer.alloc(0) },
  ]).files).candidates.find(item => item.index.strategy === "gzip-grouped")!;
}

describe("browser pack resolver", () => {
  it("reads actual gzip and identity objects through Web APIs without changing file bytes", async () => {
    const packed = candidate();
    const runtime = await createBrowserPack({ indexBytes: packed.indexBytes, expectedIndexHash: packed.candidateId, loadObject: async object => new Response(packed.objects.find(item => item.path === object.path)!.bytes) });
    expect(Buffer.from((await runtime.readFile("app.js"))!.bytes).toString()).toBe('console.log("packed");'.repeat(300));
    expect((await runtime.readFile("empty.txt"))!.bytes).toHaveLength(0);
    expect(await runtime.readFile("missing.json")).toBeNull();
  });

  it("rejects an index not matching its independently supplied pin", async () => {
    const packed = candidate();
    await expect(createBrowserPack({ indexBytes: packed.indexBytes, expectedIndexHash: `0x${"0".repeat(64)}`, loadObject: async () => new Response() })).rejects.toThrow(/index hash/i);
  });

  it("coalesces concurrent file requests into one object read and rejects corruption", async () => {
    const packed = candidate();
    let calls = 0;
    const runtime = await createBrowserPack({ indexBytes: packed.indexBytes, expectedIndexHash: packed.candidateId, loadObject: async object => {
      calls += 1;
      return new Response(packed.objects.find(item => item.path === object.path)!.bytes);
    } });
    await Promise.all([runtime.readFile("app.js"), runtime.readFile("app.js")]);
    expect(calls).toBe(1);
    const corrupt = await createBrowserPack({ indexBytes: packed.indexBytes, expectedIndexHash: packed.candidateId, loadObject: async object => {
      const bytes = Buffer.from(packed.objects.find(item => item.path === object.path)!.bytes);
      bytes[0] = bytes[0]! ^ 1;
      return new Response(bytes);
    } });
    await expect(corrupt.readFile("app.js")).rejects.toThrow(/hash/i);
    await expect(corrupt.readFile("app.js")).rejects.toThrow(/hash/i);
  });

  it("bounds transport reads and rejects missing object responses", async () => {
    const packed = candidate();
    const runtime = await createBrowserPack({ indexBytes: packed.indexBytes, expectedIndexHash: packed.candidateId, loadObject: async () => new Response(Buffer.alloc(100000)) });
    await expect(runtime.readFile("app.js")).rejects.toThrow(/limit|size/i);
    const missing = await createBrowserPack({ indexBytes: packed.indexBytes, expectedIndexHash: packed.candidateId, loadObject: async () => new Response("missing", { status: 404 }) });
    await expect(missing.readFile("app.js")).rejects.toThrow(/response/i);
  });
});

describe("gateway pack adapter", () => {
  it("serves original URLs, query strings, directory indexes and HEAD responses", async () => {
    const packed = candidate();
    const runtime = await createBrowserPack({ indexBytes: packed.indexBytes, expectedIndexHash: packed.candidateId, loadObject: async object => new Response(packed.objects.find(item => item.path === object.path)!.bytes) });
    const response = await servePackRequest(runtime, new Request("https://preview.test/site/app.js?v=1"), { scopeUrl: "https://preview.test/site/" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/javascript/);
    expect(await response.text()).toBe('console.log("packed");'.repeat(300));
    const head = await servePackRequest(runtime, new Request("https://preview.test/site/app.js", { method: "HEAD" }), { scopeUrl: "https://preview.test/site/" });
    expect(head.headers.get("content-length")).toBe("6600");
    expect(await head.text()).toBe("");
    expect((await servePackRequest(runtime, new Request("https://preview.test/site/"), { scopeUrl: "https://preview.test/site/" })).status).toBe(200);
  });

  it("keeps missing assets, external scopes and unsupported methods out of the pack", async () => {
    const packed = candidate();
    const runtime = await createBrowserPack({ indexBytes: packed.indexBytes, expectedIndexHash: packed.candidateId, loadObject: async object => new Response(packed.objects.find(item => item.path === object.path)!.bytes) });
    const options = { scopeUrl: "https://preview.test/site/", spaFallback: true };
    expect((await servePackRequest(runtime, new Request("https://preview.test/site/missing.json", { headers: { accept: "text/html" } }), options)).status).toBe(404);
    expect((await servePackRequest(runtime, new Request("https://preview.test/other/app.js"), options)).status).toBe(404);
    expect((await servePackRequest(runtime, new Request("https://external.test/site/app.js"), options)).status).toBe(404);
    expect((await servePackRequest(runtime, new Request("https://preview.test/site/", { method: "POST" }), options)).status).toBe(405);
    expect((await servePackRequest(runtime, new Request("https://preview.test/site/%2e%2e%2fprivate"), options)).status).toBe(400);
  });
});


it("rejects decoded stream expansion beyond the pinned index's declared size", async () => {
  const packed = analyzeCompression(scanArtifactFiles([{ relativePath: "index.html", bytes: Buffer.from("a".repeat(1000)) }]).files).candidates.find(item => item.index.strategy === "gzip-whole")!;
  const payload = gzipSync(Buffer.alloc(2_000_000, 65));
  const sha256 = sha256Hex(payload);
  const path = `objects/${sha256.slice(2)}.gz`;
  const index = { ...packed.index, objects: packed.index.objects.map(object => ({ ...object, path, sha256, storedBytes: payload.length })), files: packed.index.files.map(file => ({ ...file, objectPath: path })) };
  const indexBytes = Buffer.from(canonicalJson(index));
  const runtime = await createBrowserPack({ indexBytes, expectedIndexHash: sha256Hex(indexBytes), loadObject: async () => new Response(payload) });
  await expect(runtime.readFile("index.html")).rejects.toThrow(/stream byte limit/i);
});

it("keeps returned bytes isolated from the verified object cache", async () => {
  const packed = candidate();
  const runtime = await createBrowserPack({ indexBytes: packed.indexBytes, expectedIndexHash: packed.candidateId, loadObject: async object => new Response(packed.objects.find(item => item.path === object.path)!.bytes) });
  const first = (await runtime.readFile("app.js"))!;
  first.bytes[0] = 0;
  expect(Buffer.from((await runtime.readFile("app.js"))!.bytes).toString()).toBe('console.log("packed");'.repeat(300));
});

it("allows a later retry after a transient object response failure", async () => {
  const packed = candidate();
  let attempts = 0;
  const runtime = await createBrowserPack({ indexBytes: packed.indexBytes, expectedIndexHash: packed.candidateId, loadObject: async object => {
    attempts += 1;
    if (attempts === 1) return new Response("unavailable", { status: 503 });
    return new Response(packed.objects.find(item => item.path === object.path)!.bytes);
  } });
  await expect(runtime.readFile("app.js")).rejects.toThrow(/response/i);
  expect(Buffer.from((await runtime.readFile("app.js"))!.bytes).toString()).toBe('console.log("packed");'.repeat(300));
});
