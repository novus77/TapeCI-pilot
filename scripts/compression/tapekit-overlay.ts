import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { x } from "tar";
import { canonicalJson, sha256Hex } from "@tapeci/shared";

export const TAPEKIT_COMMIT = "37c617e7e332787c8a32a81e4d7d05a28a06c156";
const execute = promisify(execFile);
const SOURCE_SHA256 = {
  "sw-gateway/sw.js": "affabe80d05ddb974b4cc9fce81e973255dfdc9b1c653740f7dbc99db3d8ab72",
  "sw-gateway/worker.js": "b4d7f3a61a115a515f94d612eb03fcc093271d344af56281cecfcbb57ab6c148",
  "sw-gateway/serve.js": "b1858e0c8a9b709e372d1b2d8b28176940692d562c736726f03e8fe8d4d4304e",
  "sw-gateway/build.mjs": "fb31ea9cdd807077c330116be7fd5d61644a12b92be00f197a61d06dd99db042",
  "sw-gateway/dev-server.mjs": "cb462db1632502ae415d7773405e63a58cc3450e370e39a19c601e2bc0be0044",
};

/** Export only pinned tracked source; never copy a checkout's untracked environment files. */
export async function prepareTapeKitOverlay(options: { sourceDir: string; outputDir: string }) {
  const source = await realpath(options.sourceDir);
  const requested = resolve(options.outputDir);
  const destination = join(await realpath(dirname(requested)), relative(dirname(requested), requested));
  if (contains(source, destination) || contains(destination, source)) throw new Error("Source and output must not contain each other");
  const revision = (await execute("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
  if (revision !== TAPEKIT_COMMIT) throw new Error(`Unsupported TapeKit source pin: ${revision}`);
  const originals = new Map(await Promise.all(Object.entries(SOURCE_SHA256).map(async ([path, expected]) => {
    const result = await execute("git", ["show", `${TAPEKIT_COMMIT}:${path}`], { cwd: source, encoding: "buffer" });
    if (sha256Hex(result.stdout).slice(2) !== expected) throw new Error(`Unsupported source hash: ${path}`);
    return [path, result.stdout.toString("utf8")] as const;
  })));
  const patches: Record<string, readonly (readonly [string, string])[]> = {
    "sw-gateway/sw.js": [
      ["const VERSION =", "import { openPackedSite, PackIntegrityError } from './.tape/compression.js';\n\nconst VERSION ="],
      ["siteNodes } from", "siteNodes, safeContentType } from"],
      ["await kernel.openSite(res)", "await openPackedSite(await kernel.openSite(res), { safeContentType })"],
      ["h.site.get(url.pathname)", "h.site.get(url.pathname, { navigation: req.mode === 'navigate', accept: req.headers.get('accept') })"],
      ["sha: file.sha256 }, 'path'", "sha: file.sha256, compression: file.compression || null }, 'path'"],
      ["own(e, url).catch((err) => html(", "own(e, url).catch((err) => err instanceof PackIntegrityError ? html('Packed content verification failed', 502) : html("],
    ],
    "sw-gateway/worker.js": [
      ["/** 4246-0-open", "import { openPackedSite, PackIntegrityError } from './compression.js';\n\n/** 4246-0-open"],
      ["KernelError } from", "KernelError, safeContentType } from"],
      ["(await kernel.openSite(res)).get(url.pathname)", "(await openPackedSite(await kernel.openSite(res), { safeContentType })).get(url.pathname, { navigation: request.mode === 'navigate' || request.headers.get('sec-fetch-mode') === 'navigate', accept: request.headers.get('accept') })"],
      ["if (err instanceof InputError)", "if (err instanceof PackIntegrityError) return new Response('Packed content verification failed', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': LOCKED_CSP } });\n    if (err instanceof InputError)"],
    ],
    "sw-gateway/serve.js": [["boot\\.js$", "compression\\.js$|boot\\.js$"]],
    "sw-gateway/build.mjs": [["['boot.js',", "['compression.js', 'boot.js',"]],
    "sw-gateway/dev-server.mjs": [["const STATIC = {", "const STATIC = { '/.tape/compression.js': 'compression.js',"]],
  };
  const patched = new Map([...originals].map(([path, text]) => [path, (patches[path] ?? []).reduce((text, [before, after]) => replaceOnce(text, before, after), text)]));
  const archive = await execute("git", ["archive", "--format=tar", TAPEKIT_COMMIT], { cwd: source, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
  await mkdir(destination);
  await pipeline(Readable.from([archive.stdout]), x({ cwd: destination, strict: true }));
  await Promise.all([...patched].map(([path, text]) => writeFile(join(destination, path), text)));
  const adapterPath = join(destination, "sw-gateway/compression.js");
  await execute("bun", ["build", fileURLToPath(new URL("../../packages/compression/src/tapekit.ts", import.meta.url)), "--target", "browser", "--minify", "--outfile", adapterPath]);
  const license = await readFile(join(destination, "LICENSE"), "utf8");
  const adapter = Buffer.concat([Buffer.from(`/*! Includes TapeOutProtocol MIT-licensed code.\n${license}\n*/\n`), await readFile(adapterPath)]);
  await writeFile(adapterPath, adapter);
  await execute(process.execPath, [join(destination, "sw-gateway/build.mjs")], { cwd: destination });
  for (const path of patched.keys()) await execute(process.execPath, ["--check", join(destination, path)]);
  const manifest = {
    schemaVersion: "tapeci.tapekit-overlay.v1", tapeKitCommit: TAPEKIT_COMMIT,
    sourceFileSha256: SOURCE_SHA256,
    patchedFileSha256: Object.fromEntries([...patched].map(([path, text]) => [path, sha256Hex(Buffer.from(text))])),
    adapterSha256: sha256Hex(adapter), adapterBytes: adapter.length,
    bunVersion: (await execute("bun", ["--version"])).stdout.trim(),
    scope: "local-source-integration-only", liveGatewayModified: false,
  };
  await writeFile(join(destination, "tapeci-overlay.json"), canonicalJson(manifest), { flag: "wx" });
  return { outputDir: destination, manifest };
}

function replaceOnce(text: string, before: string, after: string) {
  if (text.split(before).length !== 2) throw new Error(`Source patch anchor mismatch: ${before}`);
  return text.replace(before, after);
}
function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
