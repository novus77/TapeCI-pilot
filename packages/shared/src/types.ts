import type { Hex } from "./hash.js";

/** Directory index file name used by TapeOut (TapeKit SPEC §6 step 3). */
export const INDEX_FILE = "index.html";

/** A single static file that TapeCI may publish. `path` is canonical (NFC, no `..`). */
export interface ArtifactFile {
  /** Canonical target path on chain, e.g. `index.html` or `releases/r-.../assets/app.js`. */
  readonly path: string;
  /** Path as it appeared inside the build output (after safe extraction). */
  readonly sourceRelativePath: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: Hex;
  readonly bytes: Uint8Array;
}

export interface Artifact {
  readonly files: readonly ArtifactFile[];
  readonly totalBytes: number;
}

export type UploadAction = "WRITE" | "UNCHANGED" | "CONFLICT";

export interface OnChainFileInfo {
  readonly exists: boolean;
  readonly size: number;
  readonly contentType: string;
  readonly sha256: Hex;
  readonly updatedAt: number;
  readonly chunkCount: number;
}

export interface PlannedFile {
  readonly file: ArtifactFile;
  readonly onChain: OnChainFileInfo;
  readonly action: UploadAction;
  readonly reason?: string;
}

export interface DeploymentPlan {
  readonly container: Hex;
  readonly files: readonly PlannedFile[];
  readonly writes: number;
  readonly unchanged: number;
  readonly conflicts: number;
}

export type UploadStatus =
  | "UNCHANGED"
  | "UPLOADED"
  | "CONFLICT"
  | "RECOVERY_REQUIRES_RESTART";

export interface UploadResult {
  readonly path: string;
  readonly status: UploadStatus;
  readonly transactionHashes: readonly Hex[];
  readonly verified: boolean;
  readonly detail?: string | undefined;
  /** Block at which the post-upload read-back was pinned (read-after-write guard). */
  readonly verifiedAtBlock?: bigint | undefined;
}
