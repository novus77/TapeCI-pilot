import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { MAX_PACK_INDEX_BYTES } from "./browser.js";
import { parsePackIndex } from "./pack-index.js";

const TOOL_PATH = "/__tapeci_preview/";
const PREVIEW_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

export interface CompressionPreviewOptions {
  readonly candidateDir: string;
  readonly expectedIndexHash: string;
  readonly spaFallback?: boolean;
  readonly port?: number;
}

/** Fresh loopback origin only: this worker simulates a gateway-owned resolver, not a live-site installer. */
export async function startCompressionPreview(options: CompressionPreviewOptions) {
  if (!/^0x[0-9a-f]{64}$/.test(options.expectedIndexHash)) throw new Error("Expected a pinned index hash");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid preview port");
  const directory = await realpath(options.candidateDir);
  const indexPath = join(directory, "index.json");
  if ((await stat(indexPath)).size > MAX_PACK_INDEX_BYTES) throw new Error("Preview index byte limit exceeded");
  const indexBytes = await readFile(indexPath);
  if (indexBytes.length > MAX_PACK_INDEX_BYTES) throw new Error("Preview index byte limit exceeded");
  const index = parsePackIndex(JSON.parse(indexBytes.toString("utf8")));
  if (index.files.some(file => `/${file.path}`.startsWith(TOOL_PATH))) throw new Error("Source collides with reserved preview namespace");
  const objects = new Map(index.objects.map(object => [`${TOOL_PATH}pack/${object.path}`, object]));
  const runtime = await bundleRuntime();
  const worker = workerScript(options.expectedIndexHash, options.spaFallback ?? false);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": PREVIEW_CSP };
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, headers).end();
        return;
      }
      const object = objects.get(url.pathname);
      if (object) {
        const path = join(directory, object.path);
        if ((await stat(path)).size !== object.storedBytes) throw new Error("Preview object size mismatch");
        response.writeHead(200, { ...headers, "content-type": "application/octet-stream" });
        response.end(request.method === "HEAD" ? undefined : await readFile(path));
        return;
      }
      const resources = new Map([
        [`${TOOL_PATH}index.json`, { bytes: indexBytes, type: "application/json" }],
        [`${TOOL_PATH}runtime.js`, { bytes: runtime, type: "application/javascript" }],
        [`${TOOL_PATH}worker.js`, { bytes: Buffer.from(worker), type: "application/javascript" }],
      ]);
      const resource = resources.get(url.pathname);
      if (resource) {
        response.writeHead(200, { ...headers, "content-type": resource.type, ...(url.pathname.endsWith("/worker.js") ? { "service-worker-allowed": "/" } : {}) });
        response.end(request.method === "HEAD" ? undefined : resource.bytes);
        return;
      }
      if (url.pathname.startsWith(TOOL_PATH) && url.pathname !== TOOL_PATH) {
        response.writeHead(404, headers).end("Not found");
        return;
      }
      if (url.pathname === TOOL_PATH || request.headers.accept?.includes("text/html")) {
        const target = url.pathname === TOOL_PATH ? "/" : `${url.pathname}${url.search}`;
        response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : bootPage(target));
        return;
      }
      response.writeHead(404, headers).end("Not found");
    } catch {
      response.writeHead(502, { ...headers, "content-type": "text/plain" }).end("Preview source read failed");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Preview address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, url: `${origin}${TOOL_PATH}`, runtimeBytes: runtime.length,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function bundleRuntime() {
  const temporary = await mkdtemp(join(tmpdir(), "tapeci-pack-runtime-"));
  try {
    const output = join(temporary, "runtime.js");
    await promisify(execFile)("bun", ["build", fileURLToPath(new URL("./browser-entry.ts", import.meta.url)), "--target", "browser", "--minify", "--outfile", output]);
    return await readFile(output);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function workerScript(expectedHash: string, spaFallback: boolean) {
  return `import {createBrowserPack,readPackResponse,MAX_PACK_INDEX_BYTES,servePackRequest} from '${TOOL_PATH}runtime.js';
const state = {};
const policy = ${JSON.stringify(PREVIEW_CSP)};
async function initialize() {
  const bytes = await readPackResponse(await fetch('${TOOL_PATH}index.json', {cache:'no-store'}), MAX_PACK_INDEX_BYTES);
  return createBrowserPack({indexBytes:bytes,expectedIndexHash:${JSON.stringify(expectedHash)},loadObject:object=>fetch('${TOOL_PATH}pack/'+object.path,{cache:'no-store'})});
}
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  const url = new URL(event.request.url);
  if(url.origin!==self.location.origin || url.pathname.startsWith('${TOOL_PATH}')) return;
  state.pack ??= initialize();
  event.respondWith(state.pack.then(pack=>servePackRequest(pack,event.request,{scopeUrl:self.location.origin+'/',spaFallback:${spaFallback}})).then(response=>{
    const headers=new Headers(response.headers);headers.set('content-security-policy',policy);
    return new Response(response.body,{status:response.status,headers});
  }).catch(()=>new Response('Packed content verification failed',{status:502,headers:{'content-type':'text/plain','content-security-policy':policy}})));
});`;
}

function bootPage(target: string) {
  return `<!doctype html><meta charset="utf-8"><title>TapeCI compressed preview</title>
<h1>Compressed application preview</h1><p>Local prototype. No chain verification or production deployment.</p>
<button id="open">Open packed app</button><pre id="status"></pre>
<script>document.querySelector('#open').onclick=async()=>{try{
  const registration=await navigator.serviceWorker.register('${TOOL_PATH}worker.js',{type:'module',scope:'/',updateViaCache:'none'});
  const worker=registration.installing||registration.waiting||registration.active;
  if(!worker)throw new Error('Worker unavailable');
  if(worker.state!=='activated')await new Promise((resolve,reject)=>{worker.addEventListener('statechange',()=>{if(worker.state==='activated')resolve();if(worker.state==='redundant')reject(new Error('Worker failed'));});});
  location.assign(${JSON.stringify(target).replace(/</g, "\\u003c")});
}catch(error){document.querySelector('#status').textContent=String(error);}};</script>`;
}
