import {
  TapeCiError,
  type ArtifactFile,
  type DeploymentPlan,
  type OnChainFileInfo,
  type PlannedFile,
} from "@tapeci/shared";

export function planFile(file: ArtifactFile, onChain: OnChainFileInfo): PlannedFile {
  if (!onChain.exists) {
    return { file, onChain, action: "WRITE", reason: "missing on chain" };
  }
  const sameBytes =
    onChain.size === file.size && onChain.sha256.toLowerCase() === file.sha256.toLowerCase();
  if (sameBytes) {
    return { file, onChain, action: "UNCHANGED" };
  }
  return {
    file,
    onChain,
    action: "CONFLICT",
    reason: "same path already holds different content",
  };
}

/**
 * Diff a local artifact against on-chain state (PRD §5.3). Only exact byte/size
 * matches are skipped; a same-path/different-hash file is a conflict unless the
 * caller explicitly allows replacing a controlled entry path.
 */
export function planDeployment(container: `0x${string}`, pairs: readonly PlannedFile[]): DeploymentPlan {
  const writes = pairs.filter((pair) => pair.action === "WRITE").length;
  const unchanged = pairs.filter((pair) => pair.action === "UNCHANGED").length;
  const conflicts = pairs.filter((pair) => pair.action === "CONFLICT").length;
  return { container, files: pairs, writes, unchanged, conflicts };
}

export function assertPlanWritable(plan: DeploymentPlan): void {
  if (plan.conflicts > 0) {
    throw new TapeCiError(
      "UPLOAD_CONFLICT",
      `plan has ${plan.conflicts} conflicting path(s); refusing to overwrite versioned assets`,
      { details: { conflicts: plan.files.filter((file) => file.action === "CONFLICT").map((file) => file.file.path) } },
    );
  }
}
