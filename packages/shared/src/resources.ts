/**
 * Wallet resource discovery DTOs — SPEC §5 (frozen field names) and §8 (read semantics).
 *
 * Rules encoded here:
 * - The asset key is `(chainId, processor, tokenId)`; `processorIndex` is a Factory
 *   catalogue ordinal and never an ownership proof.
 * - `tokenId`, wei amounts and block numbers travel as base-10 strings so values above
 *   `Number.MAX_SAFE_INTEGER` survive. `tokenId` `"0"` is a legal query (§6).
 * - `false` is a real on-chain answer. `null` only ever means "not established".
 *   A failed RPC read must never be projected as "not opened" (§8.6).
 */

export type ResourceSyncStatus = "syncing" | "ready" | "partial" | "unavailable";

export interface ResourceRef {
  chainId: 196;
  processor: `0x${string}`;
  /** Base-10 integer string, e.g. `"0"` or `"123456789012345678901234567890"`. */
  tokenId: string;
}

export interface WalletResource {
  resource: ResourceRef;
  processorIndex: number;
  container: `0x${string}` | null;
  owner: `0x${string}` | null;
  deployed: boolean | null;
  opened: boolean | null;
  /** Base-10 block number the values were pinned to; `null` when nothing was read. */
  observedBlock: string | null;
  /**
   * `"verified"` — `owner`/`deployed`/`opened` are real chain reads and `false` is real.
   * `"not_found"` — the processor answered that the token does not exist (explicit
   * absence, not a failure); `deployed`/`opened` are `null`.
   * `"unavailable"` — transport/RPC failure; every value is unknown and no purchase or
   * "not opened" conclusion may be drawn from this row.
   */
  readStatus: "verified" | "unavailable" | "not_found";
}

export interface WalletResourcePage {
  address: `0x${string}`;
  chainId: 196;
  resources: WalletResource[];
  nextCursor: string | null;
  syncStatus: ResourceSyncStatus;
  /**
   * `true` only when the index covered the whole range from the processor deployment
   * block through `indexedThroughBlock`. An empty `resources` array is "this wallet has
   * no circuits" only when `complete` is `true`; `complete: false` means the scan is
   * unfinished and the page must not be rendered as "no resources" (§8.4, §8.8).
   */
  complete: boolean;
  indexedThroughBlock: string | null;
  observedBlock: string | null;
}
