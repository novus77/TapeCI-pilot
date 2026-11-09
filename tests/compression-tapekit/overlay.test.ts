import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanArtifactFiles } from "@tapeci/validator";
import { XLAYER_MAINNET } from "@tapeci/config";
import { analyzeCompression } from "../../packages/compression/src/index.js";
import { prepareCompressedRelease } from "../../packages/release/src/compressed.js";
import type { TapeKitSite, TapeKitFile } from "../../packages/compression/src/tapekit.js";
import { prepareTapeKitOverlay, TAPEKIT_COMMIT } from "../../scripts/compression/tapekit-overlay.js";

const source = process.env.TAPECI_TAPEKIT_SOURCE;
describe.skipIf(!source)("pinned actual TapeKit gateway source integration", () => {
  let workspace: string;
  let output: string;
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "tapeci-tapekit-test-"));
    output = join(workspace, "gateway");
    await prepareTapeKitOverlay({ sourceDir: source!, outputDir: output });
  });
  afterAll(async () => { if (workspace) await rm(workspace, { recursive: true, force: true }); });

  it("builds an actual gateway tree and returns decoded content with original CSP and client/server headers", async () => {
    const serve = await import(pathToFileURL(join(output, "sw-gateway/serve.js")).href) as { SITE_CSP: string; GATEWAY_PATHS: RegExp; fileResponse(file: TapeKitFile, headers: Record<string, string>, mode: string): Response };
    const adapter = await import(pathToFileURL(join(output, "sw-gateway/compression.js")).href) as { openPackedSite(site: TapeKitSite): Promise<TapeKitSite> };
    const paths = await import(pathToFileURL(join(output, "kernel/src/path.js")).href) as { resolvePath(path: string, paths: ReadonlySet<string>, fallback: string): string | null };
    const candidate = analyzeCompression(scanArtifactFiles([{ relativePath: "index.html", bytes: Buffer.from('<html><img src="https://example.com/remote.png"><h1>Packed</h1></html>') }], { strictOnChain: false }).files, { strictOnChain: false }).candidates[1]!;
    const prepared = prepareCompressedRelease({ candidate, chainId: 196, siteRegistry: XLAYER_MAINNET.registries[0]!, container: `0x${"11".repeat(20)}`, repositoryId: 1, commitSha: "a".repeat(40) });
    const data = new Map(prepared.files.map(file => [file.path, { path: file.path, bytes: file.bytes, size: file.size, sha256: file.sha256, contentType: file.contentType, verified: true, status: "ok" }]));
    const physical: TapeKitSite = { manifest: { pathSet: new Set(data.keys()) }, get: async path => data.get(paths.resolvePath(path, new Set(data.keys()), "index.html") ?? "") ?? null };
    const site = await adapter.openPackedSite(physical);
    const file = (await site.get("/"))!;
    for (const mode of ["client", "server"]) {
      const response = serve.fileResponse(file, {}, mode);
      expect(response.headers.get("content-security-policy")).toBe(serve.SITE_CSP);
      expect(response.headers.get("x-tape-mode")).toBe(mode);
      expect(response.headers.get("x-tape-verified")).toBe("1");
      expect(await response.text()).toContain("<h1>Packed</h1>");
    }
    const purity = await import(pathToFileURL(join(output, "kernel/src/purity.js")).href) as { scanHtml(html: string): { url: string }[] };
    expect(purity.scanHtml(new TextDecoder().decode(file.bytes)).some(item => item.url.includes("example.com"))).toBe(true);
    expect(serve.GATEWAY_PATHS.test("/.tape/compression.js")).toBe(true);
    const publishedAdapter = await import(pathToFileURL(join(output, "dist/gateway/.tape/compression.js")).href) as { openPackedSite(site: TapeKitSite): Promise<TapeKitSite> };
    expect((await (await publishedAdapter.openPackedSite(physical)).get("/"))?.sha256).toBe(file.sha256);
    const manifest = JSON.parse(await readFile(join(output, "tapeci-overlay.json"), "utf8"));
    expect(manifest.tapeKitCommit).toBe(TAPEKIT_COMMIT);
  });

  it("retains the actual server worker's reserved asset routing", async () => {
    const worker = await import(pathToFileURL(join(output, "sw-gateway/worker.js")).href) as { default: { fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }): Promise<Response> } };
    const response = await worker.default.fetch(new Request("https://4246-0-open.localhost/.tape/compression.js"), { ASSETS: { fetch: async () => new Response("gateway-owned module") } });
    expect(await response.text()).toBe("gateway-owned module");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("reproduces the exact overlay hashes in a second output directory", async () => {
    const next = await prepareTapeKitOverlay({ sourceDir: source!, outputDir: join(workspace, "second") });
    expect(next.manifest).toEqual(JSON.parse(await readFile(join(output, "tapeci-overlay.json"), "utf8")));
  });

  it("refuses an existing output rather than overwriting a prepared gateway", async () => {
    await writeFile(join(output, "keep.txt"), "keep");
    await expect(prepareTapeKitOverlay({ sourceDir: source!, outputDir: output })).rejects.toThrow(/EEXIST/);
    expect(await readFile(join(output, "keep.txt"), "utf8")).toBe("keep");
  });
});
