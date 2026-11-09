import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanArtifactFiles } from "@tapeci/validator";
import { analyzeCompression, writeAnalysis } from "../../packages/compression/src/index.js";
import { scanCompressionDirectory } from "../../packages/compression/src/input.js";
import { startCompressionPreview } from "../../packages/compression/src/preview.js";

test.beforeEach(async ({ browser }, info) => { info.annotations.push({ type: "browser-version", description: browser.version() }); });

const html = `<!doctype html><link rel="stylesheet" href="/assets/style.css"><h1 id="title">Packed app</h1><img id="image" src="/image.svg"><button id="lazy">Load module</button><output id="result"></output><script type="module" src="/assets/app.js"></script>`;
const app = `
window.booted = true;
const data = await (await fetch('/data.json')).json();
document.querySelector('#title').dataset.data = data.message;
document.querySelector('#lazy').onclick = async () => { document.querySelector('#result').textContent = (await import('./lazy.js')).message; };
const worker = new Worker('/worker.js'); worker.onmessage = e => { document.body.dataset.worker = e.data; worker.terminate(); }; worker.postMessage('ok');
const wasm = await WebAssembly.instantiateStreaming(fetch('/module.wasm')); document.body.dataset.wasm = wasm.instance.exports.answer();
`;
const wasm = Uint8Array.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11]);

async function fixture(options: { corruptObject?: boolean; wrongPin?: boolean; spaFallback?: boolean; strategy?: "gzip-grouped" | "gzip-whole" | "original" } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "tapeci-browser-fixture-"));
  const font = await readFile(new URL("../../apps/web/node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf", import.meta.url));
  const files = scanArtifactFiles([
    { relativePath: "index.html", bytes: Buffer.from(html) },
    { relativePath: "assets/style.css", bytes: Buffer.from('@font-face{font-family:PackedDemo;src:url("../fonts/demo.ttf")}h1{color:rgb(12, 34, 56);font-family:PackedDemo}'.repeat(20)) },
    { relativePath: "assets/app.js", bytes: Buffer.from(app) },
    { relativePath: "assets/lazy.js", bytes: Buffer.from('export const message="lazy module loaded";') },
    { relativePath: "fonts/demo.ttf", bytes: font },
    { relativePath: "data.json", bytes: Buffer.from('{"message":"verified data"}') },
    { relativePath: "image.svg", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="red"/></svg>') },
    { relativePath: "worker.js", bytes: Buffer.from('onmessage=e=>postMessage("worker:"+e.data)') },
    { relativePath: "module.wasm", bytes: wasm },
    { relativePath: "docs/index.html", bytes: Buffer.from('<h1 id="docs">Static directory page</h1>') },
  ]).files;
  const analysis = analyzeCompression(files);
  const candidate = analysis.candidates.find(item => item.index.strategy === (options.strategy ?? "gzip-grouped"))!;
  await writeAnalysis(join(folder, "analysis"), analysis);
  const candidateDir = join(folder, "analysis", candidate.index.strategy);
  if (options.corruptObject) {
    const object = candidate.objects.find(object => candidate.index.files.some(file => file.path === "index.html" && file.objectPath === object.path))!;
    const path = join(candidateDir, object.path);
    const bytes = await readFile(path);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(path, bytes);
  }
  const preview = await startCompressionPreview({ candidateDir, expectedIndexHash: options.wrongPin ? `0x${"0".repeat(64)}` : candidate.candidateId, spaFallback: options.spaFallback ?? false });
  test.info().annotations.push({ type: "runtime-bytes", description: String(preview.runtimeBytes) });
  return { ...preview, cleanup: async () => { await preview.close(); await rm(folder, { recursive: true, force: true }); } };
}

test("loads original paths, CSS/font, image, fetch, lazy import, Worker and WASM under CSP", async ({ page }) => {
  const preview = await fixture();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(preview.url);
    await page.getByRole("button", { name: "Open packed app" }).click();
    await expect(page.locator("#title")).toHaveAttribute("data-data", "verified data");
    await expect(page.locator("#title")).toHaveCSS("color", "rgb(12, 34, 56)");
    await expect.poll(() => page.evaluate("document.fonts.check('16px PackedDemo')")).toBe(true);
    await expect(page.locator("#title")).toHaveCSS("font-family", "PackedDemo");
    await expect.poll(() => page.locator("#image").evaluate(image => (image as unknown as { naturalWidth: number }).naturalWidth)).toBe(12);
    await page.locator("#lazy").click();
    await expect(page.locator("#result")).toHaveText("lazy module loaded");
    await expect(page.locator("body")).toHaveAttribute("data-worker", "worker:ok");
    await expect(page.locator("body")).toHaveAttribute("data-wasm", "42");
    expect(errors).toEqual([]);
    expect(await page.evaluate("navigator.serviceWorker.controller?.scriptURL")).toContain("/__tapeci_preview/worker.js");
  } finally { await preview.cleanup(); }
});

test("refreshes deep SPA routes and does not convert missing assets to HTML", async ({ page }) => {
  const preview = await fixture({ spaFallback: true });
  try {
    await page.goto(preview.url);
    await page.getByRole("button", { name: "Open packed app" }).click();
    await expect(page.locator("#title")).toBeVisible();
    await page.goto(new URL("/nested/route", preview.url).href);
    await expect(page.locator("#title")).toHaveAttribute("data-data", "verified data");
    await page.reload();
    await expect(page.locator("#title")).toBeVisible();
    const missing = await page.evaluate(async () => { const response = await fetch('/missing.json'); return { status: response.status, body: await response.text() }; });
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain("Packed app");
    const encodedMissing = await page.goto(new URL("/missing%2Ejson", preview.url).href);
    expect(encodedMissing?.status()).toBe(404);
    await page.goto(new URL("/docs/", preview.url).href);
    await expect(page.locator("#docs")).toHaveText("Static directory page");
  } finally { await preview.cleanup(); }
});

for (const failure of ["corruptObject", "wrongPin"] as const) {
  test(`rejects ${failure} without running application code`, async ({ page }) => {
    const preview = await fixture({ [failure]: true });
    try {
      await page.goto(preview.url);
      const responsePromise = page.waitForResponse(response => response.url() === new URL("/", preview.url).href);
      await page.getByRole("button", { name: "Open packed app" }).click();
      expect((await responsePromise).status()).toBe(502);
      await expect(page.locator("body")).toContainText("Packed content verification failed");
      expect(await page.evaluate("Object.hasOwn(window, 'booted')")).toBe(false);
    } finally { await preview.cleanup(); }
  });
}

test("loads a whole gzip object with shared resources", async ({ page }) => {
  const preview = await fixture({ strategy: "gzip-whole" });
  try {
    await page.goto(preview.url);
    await page.getByRole("button", { name: "Open packed app" }).click();
    await expect(page.locator("#title")).toHaveAttribute("data-data", "verified data");
    await page.locator("#lazy").click();
    await expect(page.locator("#result")).toHaveText("lazy module loaded");
  } finally { await preview.cleanup(); }
});


test("renders the CircuitGuard Vite build with root-relative hashed assets", async ({ page, context }) => {
  const input = process.env.TAPECI_COMPRESSION_REAL_DIST;
  test.skip(!input, "Set TAPECI_COMPRESSION_REAL_DIST to an existing real Vite dist for this opt-in smoke test");
  const folder = await mkdtemp(join(tmpdir(), "tapeci-real-browser-"));
  const scanned = await scanCompressionDirectory(input!, { entryPath: "index.html", strictOnChain: true });
  const analysis = analyzeCompression(scanned.files);
  const candidate = analysis.candidates.find(item => item.index.strategy === "gzip-grouped")!;
  await writeAnalysis(join(folder, "analysis"), analysis);
  const preview = await startCompressionPreview({ candidateDir: join(folder, "analysis", candidate.index.strategy), expectedIndexHash: candidate.candidateId });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => new URL(route.request().url()).origin === preview.origin ? route.continue() : route.abort());
  try {
    await page.goto(preview.url);
    await page.getByRole("button", { name: "Open packed app" }).click();
    await expect(page).toHaveTitle("CircuitGuard Capsule");
    await expect(page.locator("h1")).toContainText("Agents can propose.");
    expect(await page.locator("h1").evaluate("element => getComputedStyle(element).fontSize")).not.toBe("32px");
    expect(errors).toEqual([]);
  } finally {
    await preview.close();
    await rm(folder, { recursive: true, force: true });
  }
});
