# P1-08 — single-transaction entry cutover and rollback

**Date:** 2026-10-19 · **Scope:** Anvil-fork cutover/rollback. No mainnet writes.
**Code:** [`packages/release`](../packages/release) — entry rewriting, versioned release preparation,
local release store, cutover/rollback.
**Tests:** [`tests/unit/p1-entry-cutover.test.ts`](../tests/unit/p1-entry-cutover.test.ts) (7),
[`tests/fork/entry-cutover.test.ts`](../tests/fork/entry-cutover.test.ts) (1).
**Evidence log:** [`docs/evidence/logs/p1-entry-cutover.log`](./evidence/logs/p1-entry-cutover.log).

---

## 1. Versioned entry rewriting (required for a safe cutover)

Assets are published under `releases/<releaseId>/…`, so the root entry must reference those
versioned paths. `prepareVersionedRelease()`:

1. computes `artifactDigest` over the **source** build (entry before rewriting);
2. derives `releaseId` from commit + source digest (this avoids a self-referential hash);
3. rewrites the entry HTML so every internal `src`/`href`/`action`/`poster`/`srcset`,
   inline `style` `url()`/`@import`, and `<style>` block points at
   `/${pathPrefix}/${releaseId}/${sourcePath}`;
4. keeps external/data/anchor URLs untouched, keeps navigation `<a href>` optional;
5. hashes the rewritten entry (must be ≤24,000 bytes / one chunk) and builds the manifest;
6. fails if any required reference does not resolve to a manifest path.

`artifactDigest` identifies the source build; `releaseManifestHash` covers the published rows
(including the rewritten entry hash). The local release store persists both.

Relative references inside standalone CSS/JS files keep working because the whole asset tree is
moved under the same prefix; **root-absolute** references inside separate CSS/JS files are not
rewritten by this slice (see limitations).

## 2. Release store

`ReleaseStore` writes one JSON document per release under `.tapeci/releases/` (or any directory):
deterministic manifest + source digest + manifest hash + base64 entry bytes (≤24 KiB) + storedAt.
`load()` re-verifies the manifest hash and the entry hash/size, so a corrupted history cannot be
rolled back to silently. `list()` returns release ids/commits/file counts.

## 3. Cutover algorithm (`switchEntryToRelease`)

1. **Entry checks** — bytes match the manifest entry row, exactly one chunk, ≤24,000 bytes, and
   every internal reference resolves to a manifest path.
2. **Assets first** — `verifySite` reads every asset path through two operators at one pinned
   block; each result must match the manifest's raw SHA-256/size (the manifest is authority).
   Nothing is written if any asset is missing/mismatched.
3. **Snapshot** the current entry at that pin (bytes, hash, content type). If the old entry is
   bigger than one chunk, the cutover is refused (it could not be restored atomically).
4. **One `putFile` transaction** with an explicit 8,000,000 gas limit (the worst-case 24 KiB chunk
   needs ~5.5 M; this removes estimator flakiness). A failed transaction leaves the old entry.
5. **Read back** the entry bytes and hash; on mismatch the previous entry is restored in one
   transaction before `SWITCH_FAILED` is thrown.

`rollbackToStoredRelease()` loads a historical release from the store and runs the same algorithm;
if the old assets are no longer on chain the call fails **before** touching the entry, so the
current site stays live.

## 4. Fork evidence

A single Anvil-fork scenario covers the DoD (“old version accessible, failure does not switch”):

- Release **A**: assets uploaded, entry switched in **one transaction**; `previousEntrySha256=null`.
- Release **B**: assets uploaded while A's entry remains live (verified by reading the entry
  hash); entry switched in one transaction with `previousEntrySha256 = A`; A's versioned asset
  remains readable on chain afterwards.
- **Rollback to A** from the local store: one transaction, `previousEntrySha256 = B`, entry hash
  returns to A.
- **Missing-asset release C**: cutover is rejected before any write; the live entry is still A.

## 5. API

```ts
prepareVersionedRelease({ files, chainId, siteRegistry, container, repositoryId, commitSha,
                          entryPath?, fallbackPath?, pathPrefix? })
  -> { manifest, artifactDigest, releaseManifestHash, releaseId, entryBytes, entryHtml, references }

new ReleaseStore(dir).save({ manifest, artifactDigest, releaseManifestHash, entryBytes })
new ReleaseStore(dir).load(releaseId) / .list()

switchEntryToRelease({ manifest, entryBytes, client, wallet, config, operators, pinnedBlock? })
rollbackToStoredRelease({ store, releaseId, client, wallet, config, operators, pinnedBlock? })
  -> { purpose, releaseId, entrySha256, previousEntrySha256, transactionHashes, pinnedBlockNumber, verified }
```

## 6. Limitations / carry-forward

- The cutover transaction is a single `putFile` and is **not yet journaled** with the P1-06
  journal/nonce lock; P1-09 wires the CLI/deploy flow through the journal.
- Root-absolute references in separate CSS/JS files are not rewritten (relative trees are safe);
  Vite `base`/absolute-URL builds must be rejected or configured to relative paths.
- Service Worker cache invalidation, favicon/manifest checks and the full HTML reference graph
  are not part of this slice.
- Restoring a previous entry larger than 24,000 bytes is impossible with one transaction, so such
  a cutover is refused rather than attempted.
- The release store is local and unencrypted; it contains public manifests and entry bytes.
- No mainnet writes; P0-07 remains gated on explicit budget authorization.
