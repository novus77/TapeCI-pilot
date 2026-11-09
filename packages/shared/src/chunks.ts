import { TapeCiError } from "./errors.js";

/**
 * TapeOut hard limits (TapeKit SPEC §5, contract constant `CHUNK_MAX`).
 * A file is stored as `putFile` (chunk 0) plus `appendChunk` calls, 24,000 bytes each.
 */
export const CHUNK_MAX = 24_000;
export const MAX_CHUNKS = 350;
export const MAX_FILE_BYTES = CHUNK_MAX * MAX_CHUNKS; // 8,400,000

/**
 * Split raw file bytes into on-chain chunks. An empty file still needs one
 * `putFile` call (empty `data`), matching `release_files.chunk_count >= 1`.
 */
export function chunkBytes(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length > MAX_FILE_BYTES) {
    throw new TapeCiError(
      "FILE_TOO_LARGE",
      `file is ${bytes.length} bytes, TapeOut allows at most ${MAX_FILE_BYTES}`,
      { details: { size: bytes.length, max: MAX_FILE_BYTES } },
    );
  }
  if (bytes.length === 0) return [new Uint8Array(0)];

  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_MAX) {
    chunks.push(bytes.subarray(offset, Math.min(offset + CHUNK_MAX, bytes.length)));
  }
  if (chunks.length > MAX_CHUNKS) {
    throw new TapeCiError(
      "TOO_MANY_CHUNKS",
      `file needs ${chunks.length} chunks, TapeOut allows at most ${MAX_CHUNKS}`,
      { details: { chunks: chunks.length, max: MAX_CHUNKS } },
    );
  }
  return chunks;
}

/** Number of chunks a file of `size` bytes will occupy (minimum 1). */
export function chunkCountFor(size: number): number {
  if (!Number.isInteger(size) || size < 0) {
    throw new TapeCiError("INVALID_ARTIFACT", `invalid file size: ${size}`);
  }
  if (size > MAX_FILE_BYTES) {
    throw new TapeCiError("FILE_TOO_LARGE", `file is ${size} bytes, max ${MAX_FILE_BYTES}`);
  }
  return Math.max(1, Math.ceil(size / CHUNK_MAX));
}

/** Verify that a concatenation of chunks equals the whole file. */
export function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
