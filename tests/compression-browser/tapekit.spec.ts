import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanArtifactFiles } from "@tapeci/validator";
import { XLAYER_MAINNET } from "@tapeci/config";
import { analyzeCompression } from "../../packages/compression/src/index.js";
import { prepareCompressedRelease } from "../../packages/release/src/compressed.js";
import { prepareTapeKitOverlay } from "../../scripts/compression/tapekit-overlay.js";
import type { TapeKitSite, TapeKitFile } from "../../packages/compression/src/tapekit.js";

const source = process.env.TAPECI_TAPEKIT_SOURCE;

test("verifies prepared physical bytes through the actual TapeKit adapter and response module", async ({ page }) => {
  test.skip(!source, "Set TAPECI_TAPEKIT_SOURCE to the supported pinned source clone");
  const temporary = await mkdtemp(join(tmpdir(), "tapeci-source-browser-"));
  const overlay = await prepareTapeKitOverlay({ sourceDir: source!, outputDir: join(temporary, "gateway") });
  const candidate = analyzeCompression(scanArtifactFiles([
    { relativePath: "index.html", bytes: Buffer.from("<h1>Source adapter browser fixture</h1>".repeat(30)) },
  ]).files).candidates.find(candidate => candidate.index.strategy === "gzip-whole")!;
  const prepared = prepareCompressedRelease({ candidate, chainId: 196, siteRegistry: XLAYER_MAINNET.registries[0]!, container: `0x${"11".repeat(20)}`, repositoryId: 1, commitSha: "a".repeat(40) });
  const resources = new Map<string, { bytes: Uint8Array; contentType: string }>([
    ["/", { bytes: Buffer.from("<!doctype html><title>Local TapeKit source fixture</title>"), contentType: "text/html" }],
    ["/adapter.js", { bytes: await readFile(join(overlay.outputDir, "sw-gateway/compression.js")), contentType: "application/javascript" }],
    ["/serve.js", { bytes: await readFile(join(overlay.outputDir, "sw-gateway/serve.js")), contentType: "application/javascript" }],
    ["/path.js", { bytes: await readFile(join(overlay.outputDir, "kernel/src/path.js")), contentType: "application/javascript" }],
    ["/fixture.json", { bytes: Buffer.from(JSON.stringify(prepared.manifest.files)), contentType: "application/json" }],
    ...prepared.files.map(file => [`/physical/${file.path}`, { bytes: file.bytes, contentType: "application/octet-stream" }] as const),
  ]);
  const server = createServer((request, response) => {
    const resource = resources.get(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    response.writeHead(resource ? 200 : 404, { "content-type": resource?.contentType ?? "text/plain", "cache-control": "no-store" });
    response.end(resource?.bytes);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture address");
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const result = await page.evaluate(async () => {
      const adapterUrl = "/adapter.js";
      const serveUrl = "/serve.js";
      const pathUrl = "/path.js";
      const adapter = await import(adapterUrl) as { openPackedSite(site: TapeKitSite): Promise<TapeKitSite> };
      const serve = await import(serveUrl) as { SITE_CSP: string; fileResponse(file: TapeKitFile, id: Record<string, string>, mode: string): Response };
      const paths = await import(pathUrl) as { resolvePath(path: string, paths: Set<string>, fallback: string): string | null };
      const files = await (await fetch("/fixture.json")).json() as { path: string; size: number; sha256: string; contentType: string }[];
      const pathSet = new Set(files.map(file => file.path));
      const physical: TapeKitSite = { manifest: { pathSet }, get: async requested => {
        const path = paths.resolvePath(requested, pathSet, "index.html");
        const row = files.find(file => file.path === path);
        if (!row) return null;
        const bytes = new Uint8Array(await (await fetch(`/physical/${row.path}`)).arrayBuffer());
        // This fixture supplies physical metadata, not a live RPC or chain attestation.
        return { ...row, bytes, verified: true, status: "ok" };
      } };
      const packed = await adapter.openPackedSite(physical);
      const file = (await packed.get("/"))!;
      const response = serve.fileResponse(file, {}, "client");
      return { text: await response.text(), csp: response.headers.get("content-security-policy"), expectedCsp: serve.SITE_CSP, mode: response.headers.get("x-tape-mode"), proof: file.compression };
    });
    expect(result.text).toContain("Source adapter browser fixture");
    expect(result.csp).toBe(result.expectedCsp);
    expect(result.mode).toBe("client");
    expect(result.proof?.indexSha256).toBe(candidate.candidateId);
    test.info().annotations.push({ type: "adapter-bytes", description: String(overlay.manifest.adapterBytes) });
    test.info().annotations.push({ type: "evidence-scope", description: "pinned source + physical fixture, not live RPC" });
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(temporary, { recursive: true, force: true });
  }
});
