import { analyzeCompression } from "@tapeci/compression";
import { prepareCompressedRelease, prepareVersionedRelease } from "@tapeci/release";
import type { ScannedFile } from "@tapeci/validator";
import { TapeCiError } from "@tapeci/shared";
import type { PreparedArtifactContext } from "./prepared-artifact.js";
import type { PreparationRequest } from "./preparation-policy.js";

export function prepareDeploymentRelease(input: { context: PreparedArtifactContext; request: PreparationRequest; files: readonly ScannedFile[]; pathMode: string; strictOnChain: boolean }) {
  if (input.request.mode !== "original") {
    const analysis = analyzeCompression(input.files, { strictOnChain: input.strictOnChain });
    const candidate = analysis.candidates.find(candidate => candidate.index.strategy === input.request.mode);
    if (!candidate) throw new TapeCiError("INVALID_ARTIFACT", "requested compression candidate is unavailable");
    const prepared = prepareCompressedRelease({ ...input.context, candidate, spaFallback: input.request.spaFallback });
    return { prepared, files: prepared.files.map(file => ({ sourcePath: file.sourceRelativePath, bytes: file.bytes })) };
  }
  const prepared = prepareVersionedRelease({ ...input.context, files: input.files, entryPath: "index.html", pathPrefix: input.pathMode === "root" ? "" : "releases" });
  const bytes = new Map(input.files.map(file => [file.path, file.bytes]));
  return { prepared, files: prepared.manifest.files.map(row => ({ sourcePath: row.sourcePath, bytes: row.path === prepared.manifest.entryPath ? prepared.entryBytes : bytes.get(row.sourcePath)! })) };
}
