import type { Hex } from "viem";
import type { ReleaseManifest } from "@tapeci/artifact";
import { readFileBytesAt, retryPinnedRead, verifyFileRead, waitForBlockOnAll, type ReadClient, type WaitForBlockOptions } from "@tapeci/chain";
import { TapeCiError } from "@tapeci/shared";
import type { DeploymentJournal, JournalEvent, JournalEventInput, JournalState } from "./journal.js";

export interface ReverifyReader {
  readonly client: ReadClient;
  readonly label: string;
}

/** Highest `tx_mined` block in a journal, or null when nothing was mined. */
export function maxMinedBlock(state: JournalState): bigint | null {
  let max: bigint | null = null;
  for (const record of state.transactions.values()) {
    if (record.mined === undefined) continue;
    const block = BigInt(record.mined.blockNumber);
    if (max === null || block > max) max = block;
  }
  return max;
}

/** Manifest paths that have no `file_verified` evidence in the journal. */
export function unverifiedPaths(state: JournalState, manifest: Pick<ReleaseManifest, "files">): string[] {
  return manifest.files.filter((file) => !state.verifiedFiles.has(file.path)).map((file) => file.path);
}

export interface ReverifyOptions {
  readonly journal: DeploymentJournal;
  readonly manifest: Pick<ReleaseManifest, "files" | "container">;
  readonly registry: Hex;
  /** Every reader must reach the pin and return matching bytes (fail closed). */
  readonly readers: readonly ReverifyReader[];
  /** Mark events `recovered` (required after deployment_complete). */
  readonly recovered: boolean;
  /** Explicit lower bound for the pin (defaults to the journal's max mined block). */
  readonly minBlock?: bigint;
  readonly wait?: Omit<WaitForBlockOptions, "label">;
  readonly record?: (input: JournalEventInput) => Promise<JournalEvent>;
}

export interface ReverifyResult {
  readonly pin: bigint | null;
  readonly verified: readonly { readonly path: string; readonly status: "UPLOADED" | "UNCHANGED" }[];
}

/**
 * Re-verify manifest files that have no `file_verified` event (resume after a
 * read-after-write false negative, or a file that became UNCHANGED on re-plan).
 *
 * Evidence is only recorded after real reads: every reader waits until its head
 * reaches a pin >= the highest mined write in the journal, then reads the file at
 * that pin and must match the manifest sha256/size. Any mismatch, absence or
 * timeout throws and nothing is appended for that file. Never fabricates evidence.
 */
export async function reverifyMissingFiles(options: ReverifyOptions): Promise<ReverifyResult> {
  const { journal, manifest } = options;
  const state = journal.state;
  const deploymentId = state.deploymentId;
  if (deploymentId === null) throw new TapeCiError("INTERNAL", "journal has no deployment id");
  if (options.readers.length === 0) throw new TapeCiError("INTERNAL", "re-verification needs at least one reader");
  const missing = manifest.files.filter((file) => !state.verifiedFiles.has(file.path));
  if (missing.length === 0) return { pin: null, verified: [] };

  for (const file of missing) {
    for (const record of state.transactions.values()) {
      if (record.intent.path === file.path && record.mined === undefined) {
        throw new TapeCiError(
          "VERIFICATION_FAILED",
          `cannot re-verify ${file.path}: journal has a write for it that is not mined`,
          { details: { fingerprint: record.fingerprint } },
        );
      }
    }
  }

  const mined = maxMinedBlock(state);
  let pin = options.minBlock ?? mined ?? 0n;
  if (mined !== null && mined > pin) pin = mined;
  if (pin === 0n) {
    // Nothing mined and no explicit bound: pin at the lowest current head.
    const heads = await Promise.all(options.readers.map((reader) => reader.client.getBlockNumber({ cacheTime: 0 })));
    pin = heads.reduce((low, head) => (head < low ? head : low));
  } else {
    await waitForBlockOnAll(options.readers, pin, options.wait ?? {});
  }

  const record = options.record ?? ((input: JournalEventInput) => journal.append(input));
  const verified: { path: string; status: "UPLOADED" | "UNCHANGED" }[] = [];
  for (const file of missing) {
    for (const reader of options.readers) {
      const read = await retryPinnedRead(() =>
        readFileBytesAt(reader.client, options.registry, manifest.container, file.path, {
          expectedSize: file.size,
          blockNumber: pin,
        }),
      );
      const check = verifyFileRead(file.path, read, { sha256: file.sha256, size: file.size });
      if (!check.matched) {
        throw new TapeCiError(
          "VERIFICATION_FAILED",
          `${reader.label}: ${file.path} does not match the manifest at block ${pin}`,
          { details: { path: file.path, operator: reader.label, block: pin.toString() } },
        );
      }
    }
    let count = 0;
    for (const tx of state.transactions.values()) if (tx.intent.path === file.path && tx.mined !== undefined) count += 1;
    const status = count > 0 ? "UPLOADED" : "UNCHANGED";
    await record({
      type: "file_verified",
      deploymentId,
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      status,
      transactionCount: count,
      verifiedAtBlock: pin.toString(),
      operators: options.readers.map((reader) => reader.label),
      ...(options.recovered ? { recovered: true } : {}),
    });
    verified.push({ path: file.path, status });
  }
  return { pin, verified };
}
