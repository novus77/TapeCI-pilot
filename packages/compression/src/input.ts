import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { MAX_FILE_BYTES, compareUtf8 } from "@tapeci/shared";
import { scanArtifactFiles } from "@tapeci/validator";
import { MAX_ANALYSIS_FILES, MAX_DECODED_BYTES } from "./types.js";

/** Preflight all metadata before reading source bytes; sources must remain immutable during analysis. */
export async function scanCompressionDirectory(root: string, options: { entryPath: string; strictOnChain: boolean }) {
  const paths: string[] = [];
  let declaredBytes = 0;
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareUtf8(left.name, right.name));
    // Traversal and reads are serial to enforce a cumulative budget before allocation.
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported source file type: ${relative(root, path)}`);
      const stat = await lstat(path);
      if (!stat.isFile()) throw new Error(`Unsupported source file type: ${relative(root, path)}`);
      paths.push(path);
      declaredBytes += stat.size;
      if (stat.size > MAX_FILE_BYTES || declaredBytes > MAX_DECODED_BYTES || paths.length > MAX_ANALYSIS_FILES) throw new Error("Source metadata limit exceeded");
    }
  }
  await visit(root);
  const files: { relativePath: string; bytes: Uint8Array }[] = [];
  let actualBytes = 0;
  for (const path of paths) {
    const bytes = await readFile(path);
    actualBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || actualBytes > MAX_DECODED_BYTES) throw new Error("Source byte limit exceeded");
    files.push({ relativePath: relative(root, path), bytes });
  }
  return scanArtifactFiles(files, options);
}
