import { getAddress, type Hex } from "viem";
import {
  MAX_FILE_BYTES,
  TapeCiError,
  hexToBytes,
  joinChunks,
  sha256Hex,
  type OnChainFileInfo,
} from "@tapeci/shared";
import type { ChainConfig } from "@tapeci/config";
import { siteRegistryAbi } from "./abis.js";
import type { ReadClient } from "./clients.js";

/** TapeKit reads files up to 96 KiB in one call; larger files use `readRange` segments. */
export const READ_SEGMENT_BYTES = 96 * 1024;

type FileInfoTuple = readonly [number, string, Hex, number, bigint];

export async function readFileInfo(
  client: ReadClient,
  registry: Hex,
  container: Hex,
  path: string,
  blockNumber?: bigint,
): Promise<OnChainFileInfo> {
  const raw = (await client.readContract({
    address: registry,
    abi: siteRegistryAbi,
    functionName: "fileInfo",
    args: [getAddress(container), path],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  })) as unknown as FileInfoTuple;
  const [size, contentType, sha256Hash, updatedAt, chunkCount] = raw;
  return {
    exists: chunkCount > 0n,
    size: Number(size),
    contentType,
    sha256: sha256Hash,
    updatedAt,
    chunkCount: Number(chunkCount),
  };
}

export async function pathCountAt(
  client: ReadClient,
  registry: Hex,
  container: Hex,
  blockNumber?: bigint,
): Promise<number> {
  const count = await client.readContract({
    address: registry,
    abi: siteRegistryAbi,
    functionName: "pathCount",
    args: [getAddress(container)],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  return Number(count);
}

export async function pathsAt(
  client: ReadClient,
  registry: Hex,
  container: Hex,
  blockNumber?: bigint,
): Promise<string[]> {
  const result = await client.readContract({
    address: registry,
    abi: siteRegistryAbi,
    functionName: "paths",
    args: [getAddress(container)],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
  return [...result];
}

export async function fallbackPathAt(
  client: ReadClient,
  registry: Hex,
  container: Hex,
  blockNumber?: bigint,
): Promise<string> {
  return client.readContract({
    address: registry,
    abi: siteRegistryAbi,
    functionName: "fallbackPath",
    args: [getAddress(container)],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

export async function isOpenedContainerAt(
  client: ReadClient,
  registry: Hex,
  container: Hex,
  blockNumber?: bigint,
): Promise<boolean> {
  return client.readContract({
    address: registry,
    abi: siteRegistryAbi,
    functionName: "isOpenedContainer",
    args: [getAddress(container)],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  });
}

/** Contract constant CHUNK_MAX(); returns null if the implementation has no such getter. */
export async function readChunkMax(
  client: ReadClient,
  registry: Hex,
  blockNumber?: bigint,
): Promise<number | null> {
  try {
    const value = await client.readContract({
      address: registry,
      abi: siteRegistryAbi,
      functionName: "CHUNK_MAX",
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    return Number(value);
  } catch {
    return null;
  }
}

export interface FileRead {
  readonly info: OnChainFileInfo;
  readonly bytes: Uint8Array;
  readonly actualSha256: Hex;
}

/**
 * Read a file's full bytes at one pinned block. All `read`/`readRange` calls use the
 * same `blockNumber` so a concurrent upload can never produce mixed content
 * (TapeKit SPEC §4.2, §5).
 */
export async function readFileBytesAt(
  client: ReadClient,
  registry: Hex,
  container: Hex,
  path: string,
  options: { blockNumber?: bigint; expectedSize?: number } = {},
): Promise<FileRead> {
  const { blockNumber, expectedSize } = options;
  const info = await readFileInfo(client, registry, container, path, blockNumber);
  if (!info.exists) {
    throw new TapeCiError("VERIFICATION_FAILED", `file does not exist on chain: ${path}`, {
      details: { container, path },
    });
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new TapeCiError("FILE_TOO_LARGE", `on-chain file is ${info.size} bytes, above TapeOut limit`, {
      details: { container, path, size: info.size },
    });
  }
  if (expectedSize !== undefined && info.size !== expectedSize) {
    throw new TapeCiError(
      "VERIFICATION_FAILED",
      `size mismatch for ${path}: on chain ${info.size}, expected ${expectedSize}`,
      { details: { container, path, onChainSize: info.size, expectedSize } },
    );
  }

  const readOptions = blockNumber === undefined ? {} : { blockNumber };
  let bytes: Uint8Array;
  if (info.size <= READ_SEGMENT_BYTES) {
    const whole = await client.readContract({
      address: registry,
      abi: siteRegistryAbi,
      functionName: "read",
      args: [getAddress(container), path],
      ...readOptions,
    });
    bytes = hexToBytes(whole);
  } else {
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < info.size; offset += READ_SEGMENT_BYTES) {
      const length = Math.min(READ_SEGMENT_BYTES, info.size - offset);
      const part = await client.readContract({
        address: registry,
        abi: siteRegistryAbi,
        functionName: "readRange",
        args: [getAddress(container), path, BigInt(offset), BigInt(length)],
        ...readOptions,
      });
      parts.push(hexToBytes(part));
    }
    bytes = joinChunks(parts);
  }

  const actualSha256 = sha256Hex(bytes);
  if (bytes.length !== info.size) {
    throw new TapeCiError(
      "VERIFICATION_FAILED",
      `length mismatch for ${path}: read ${bytes.length} bytes, chain declares ${info.size}`,
      { details: { container, path, readLength: bytes.length, onChainSize: info.size } },
    );
  }
  return { info, bytes, actualSha256 };
}

export interface FileVerification {
  readonly path: string;
  readonly expectedSha256: Hex;
  readonly actualSha256: Hex;
  readonly expectedSize: number;
  readonly actualSize: number;
  readonly matched: boolean;
}

/** Byte-level verification; a transaction receipt is never enough (PRD §6.3). */
export function verifyFileRead(
  path: string,
  read: FileRead,
  expected: { sha256: Hex; size: number },
): FileVerification {
  const matched =
    read.actualSha256.toLowerCase() === expected.sha256.toLowerCase() &&
    read.bytes.length === expected.size;
  return {
    path,
    expectedSha256: expected.sha256,
    actualSha256: read.actualSha256,
    expectedSize: expected.size,
    actualSize: read.bytes.length,
    matched,
  };
}

/** Read all files of a site and verify each declared hash. Used by the P0-06 verifier. */
export async function readAndVerifyPaths(
  client: ReadClient,
  config: ChainConfig,
  container: Hex,
  paths: readonly string[],
  blockNumber?: bigint,
): Promise<FileVerification[]> {
  const registry = config.registries[0];
  if (!registry) throw new TapeCiError("INTERNAL", "no registry configured");
  const results: FileVerification[] = [];
  for (const path of paths) {
    const info = await readFileInfo(client, registry, container, path, blockNumber);
    if (!info.exists) {
      results.push({
        path,
        expectedSha256: `0x${"0".repeat(64)}`,
        actualSha256: `0x${"0".repeat(64)}`,
        expectedSize: 0,
        actualSize: 0,
        matched: false,
      });
      continue;
    }
    const read = await readFileBytesAt(client, registry, container, path, {
      ...(blockNumber === undefined ? {} : { blockNumber }),
      expectedSize: info.size,
    });
    results.push(verifyFileRead(path, read, { sha256: info.sha256, size: info.size }));
  }
  return results;
}
