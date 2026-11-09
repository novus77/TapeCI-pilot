// P1-04: deterministic release manifest v1.
//
// Public API consumed by the release planner (P1-05), the deployer, and the CLI:
// - buildReleaseManifest -> { manifest, artifactDigest, releaseManifestHash, canonicalJson }
// - computeArtifactDigest, releaseManifestHash, deriveReleaseId, buildManifestFiles
export * from "./manifest.js";
export * from "./types.js";
