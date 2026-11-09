#!/usr/bin/env node
/* global process, console */
/**
 * Independent TapeKit reference-kernel cross-check for P0-06.
 *
 * Runs TapeKit's own browser kernel (pinned commit) as a third reader of the
 * same site. The kernel performs its own OKX+dRPC operator quorum and its own
 * pinned block, so this is additional evidence, NOT a replacement for
 * `packages/verifier`'s explicit byte-for-byte two-operator comparison.
 *
 * Usage: node tapekit-kernel-crosscheck.mjs <tapekit-repo-dir> <site-name>
 * Read-only: only public RPC calls are made.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [kernelDirArg, siteName] = process.argv.slice(2);
if (!kernelDirArg || !siteName) {
  console.error("usage: node tapekit-kernel-crosscheck.mjs <tapekit-repo-dir> <site-name>");
  process.exit(2);
}

const kernelDir = resolve(kernelDirArg);
const indexPath = join(kernelDir, "kernel", "src", "index.js");
const configPath = join(kernelDir, "kernel", "src", "config.js");
if (!existsSync(indexPath) || !existsSync(configPath)) {
  console.error(`TapeKit kernel not found under ${kernelDir}`);
  process.exit(2);
}

const { createKernel } = await import(pathToFileURL(indexPath).href);
const { XLAYER_MAINNET } = await import(pathToFileURL(configPath).href);

// The kernel reports block numbers as hex quantities; record decimal for consistency.
const toDecimal = (value) => {
  if (value === undefined || value === null) return null;
  try {
    return BigInt(value).toString();
  } catch {
    return String(value);
  }
};

const kernel = createKernel({ network: XLAYER_MAINNET });
const resolved = await kernel.resolve(siteName);

const result = {
  siteName,
  kernelEntry: indexPath,
  network: {
    chainId: XLAYER_MAINNET.chainId,
    key: XLAYER_MAINNET.key,
    rpcUrls: XLAYER_MAINNET.rpcs,
    pin: XLAYER_MAINNET.pin,
    maxPinLagBlocks: XLAYER_MAINNET.maxPinLagBlocks,
  },
  resolved: {
    status: resolved.status ?? null,
    name: resolved.name ?? null,
    container: resolved.container ?? null,
    chainId: resolved.chainId ?? null,
    pinnedBlockNumber: toDecimal(resolved.block),
    pinStrategy:
      "TapeKit kernel/src/rpc.js pinBlock(): per-operator lowest head, second-highest minus 2",
  },
  manifestBlockNumber: null,
  files: [],
};

if (resolved.status === "ok") {
  const site = await kernel.openSite(resolved);
  result.manifestBlockNumber = toDecimal(site.manifest.block);
  for (const path of site.manifest.paths) {
    const file = await site.get(path);
    result.files.push({
      path,
      status: file.status ?? null,
      size: file.bytes ? file.bytes.length : (file.size ?? null),
      sha256: file.sha256 ?? null,
      contentType: file.contentType ?? null,
    });
  }
}

process.stdout.write(
  `${JSON.stringify(
    result,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  )}\n`,
);
