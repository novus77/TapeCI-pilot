import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "@tapeci/shared";
import { decodeCandidate } from "./decode.js";
import type { CompressionAnalysis } from "./types.js";

export async function writeAnalysis(directory: string, analysis: CompressionAnalysis): Promise<void> {
  analysis.candidates.forEach(candidate => {
    const canonicalBytes = Buffer.from(canonicalJson(candidate.index));
    if (!canonicalBytes.equals(Buffer.from(candidate.indexBytes)) || sha256Hex(canonicalBytes) !== candidate.candidateId) throw new Error("Candidate index identity mismatch");
    decodeCandidate(candidate.index, new Map(candidate.objects.map(object => [object.path, object.bytes])));
  });
  await mkdir(directory);
  for (const candidate of analysis.candidates) {
    const folder = join(directory, candidate.index.strategy);
    await mkdir(join(folder, "objects"), { recursive: true });
    await Promise.all(candidate.objects.map(object => writeFile(join(folder, object.path), object.bytes, { flag: "wx" })));
    await writeFile(join(folder, "index.json"), candidate.indexBytes, { flag: "wx" });
  }
  // A completed report is the last write; incomplete candidate folders are not successful analyses.
  await writeFile(join(directory, "report.json"), canonicalJson(analysis.report), { flag: "wx" });
}
