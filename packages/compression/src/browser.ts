import { parsePackIndex, validatePackCoverage } from "./pack-index.js";
import type { PackFile, PackObject } from "./types.js";

export const MAX_PACK_INDEX_BYTES = 4 * 1024 * 1024;

export interface BrowserPackOptions {
  readonly indexBytes: Uint8Array;
  readonly expectedIndexHash: string;
  readonly loadObject: (object: PackObject) => Promise<Response>;
}

/** The caller must obtain the expected hash independently of the fetched index. */
export async function createBrowserPack(options: BrowserPackOptions) {
  if (options.indexBytes.length > MAX_PACK_INDEX_BYTES) throw new Error("Pack index byte limit exceeded");
  if (!/^0x[0-9a-f]{64}$/.test(options.expectedIndexHash) || await hashPackBytes(options.indexBytes) !== options.expectedIndexHash) throw new Error("Pack index hash mismatch");
  const index = parsePackIndex(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(options.indexBytes)));
  validatePackCoverage(index);
  const sourceRows = [...index.files].sort((a, b) => comparePaths(a.path, b.path)).map(file => ({ path: file.path, sha256: file.sha256, size: file.size }));
  if (await hashPackBytes(new TextEncoder().encode(JSON.stringify(sourceRows))) !== index.sourceArtifactDigest) throw new Error("Source artifact digest mismatch");
  const files = new Map(index.files.map(file => [file.path, file]));
  const objects = new Map(index.objects.map(object => [object.path, object]));
  const verified = new Map<string, Promise<Uint8Array>>();
  return {
    index,
    indexHash: options.expectedIndexHash,
    async readFile(path: string): Promise<(PackFile & { bytes: Uint8Array }) | null> {
      const file = files.get(path);
      if (!file) return null;
      const object = objects.get(file.objectPath)!;
      const cached = verified.get(object.path) ?? verifyObject(object);
      verified.set(object.path, cached);
      const decoded = await cached.catch((error: unknown) => {
        if (verified.get(object.path) === cached) verified.delete(object.path);
        throw error;
      });
      // Copy the requested bytes so callers cannot mutate the verified object cache.
      return { ...file, bytes: decoded.slice(file.offset, file.offset + file.size) };
    },
  };

  async function verifyObject(object: PackObject) {
    const response = await options.loadObject(object);
    if (response.status !== 200) throw new Error(`Packed object response failed: ${response.status}`);
    const stored = await readPackResponse(response, object.storedBytes);
    if (stored.length !== object.storedBytes) throw new Error("Stored object size mismatch");
    if (await hashPackBytes(stored) !== object.sha256) throw new Error("Stored object hash mismatch");
    if (object.encoding === "gzip" && typeof DecompressionStream !== "function") throw new Error("Native gzip decompression unavailable");
    const decoded = object.encoding === "identity" ? stored : await readStream(
      new Blob([new Uint8Array(stored).buffer]).stream().pipeThrough(new DecompressionStream("gzip")), object.decodedBytes,
    );
    if (decoded.length !== object.decodedBytes) throw new Error("Decoded object size mismatch");
    await Promise.all(index.files.filter(file => file.objectPath === object.path).map(async file => {
      if (await hashPackBytes(decoded.subarray(file.offset, file.offset + file.size)) !== file.sha256) throw new Error(`Decoded file hash mismatch: ${file.path}`);
    }));
    return decoded;
  }
}

export type BrowserPack = Awaited<ReturnType<typeof createBrowserPack>>;

export async function readPackResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Pack response failed: ${response.status}`);
  return response.body === null ? new Uint8Array(0) : readStream(response.body, maxBytes);
}

async function readStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Pack stream byte limit exceeded");
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  parts.forEach(part => {
    bytes.set(part, offset);
    offset += part.length;
  });
  return bytes;
}

export async function hashPackBytes(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return `0x${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function comparePaths(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const difference = left.findIndex((byte, position) => byte !== right[position]);
  if (difference >= 0 && difference < right.length) return left[difference]! - right[difference]!;
  return left.length - right.length;
}
