# P1-06 — journal, nonce lock and resume

**Date:** 2026-10-19 · **Scope:** crash-tolerant chunk execution on an Anvil fork. No mainnet writes.
**Code:** [`journal.ts`](../packages/deployer/src/journal.ts),
[`nonce.ts`](../packages/deployer/src/nonce.ts),
[`execute-release.ts`](../packages/deployer/src/execute-release.ts),
upload sender hook in [`upload.ts`](../packages/deployer/src/upload.ts).
**Tests:** [`tests/unit/p1-journal.test.ts`](../tests/unit/p1-journal.test.ts) (9),
[`tests/fork/journal.test.ts`](../tests/fork/journal.test.ts) (2).
**Evidence log:** [`docs/evidence/logs/p1-journal.log`](./evidence/logs/p1-journal.log).

---

## 1. What it guarantees

`executeRelease()` turns an approved P1-05 plan into on-chain writes with four invariants:

1. **No duplicate append.** Before every transaction the engine reconciles against the
   journal and the chain; `appendChunk` is never re-sent for a chunk that is already mined.
2. **Crash-safe resume.** A JSONL journal is fsynced before broadcast and after each state
   change, so a restarted process reconstructs intent, nonces and tx hashes.
3. **Serialized nonces.** One `NonceLock` per signer allocates strictly increasing nonces and
   refuses to continue while a sent transaction is unresolved (it never guesses).
4. **Safe cutover order.** All versioned assets are written and verified first; the root
   `index.html` is written **last** in a single transaction, so a crash cannot point the live
   entry at missing assets.

It also fails closed if the chain id or ERC-1967 implementations changed since planning.

## 2. Journal format

Append-only JSONL, one event per line, `fsync` after every line, with a `<journal>.lock` file
for single-writer access (stale locks older than 10 minutes are replaced).

Every event carries `{ v: 1, type, at }` plus a `deploymentId` derived from
`commitSha + artifactDigest`:

| Event | Purpose |
|---|---|
| `plan` | plan fingerprint, manifest/artifact hashes, target, commit, release, pinned block, JSON-safe plan copy |
| `tx_intent` | operation, path, chunk index, **nonce**, payload SHA-256/length, `expectIndex` |
| `tx_sent` | broadcast tx hash + nonce |
| `tx_mined` | block number/hash, gas used |
| `tx_failed` | tx hash (if broadcast) + error |
| `file_verified` | read-back SHA-256/size after a file completes |
| `deployment_complete` | verified file count and total transactions |
| `note` | human/audit note (e.g. pre-broadcast send rejection) |

Event identity `(path, chunkIndex, operation, payload hash, expectIndex)` prevents the same
chunk from being journaled twice. Replay rejects duplicates, wrong deployment ids, mismatched
hashes and events after completion. A **partial trailing line** (a crash during append) is
dropped and truncated on the next open; a complete but invalid line is an error.

## 3. Recovery algorithm

On every `executeRelease()` call:

1. Open/lock the journal and replay it.
2. If a plan event exists, require the same **plan fingerprint** (commit, container, registry,
   release, artifact digest, manifest hash); otherwise `PLAN_STALE`.
3. Reconcile every `tx_sent` without a terminal event by fetching its receipt:
   - success → append `tx_mined`;
   - reverted → append `tx_failed`;
   - **not found → abort (`UPLOAD_INTERRUPTED`)**, never guess or silently skip a nonce.
4. If the journal is already complete, re-verify every file on chain; return with
   `newTransactions = 0`.
5. Otherwise call `uploadFile` per file: it reads the on-chain chunk count/prefix, skips
   identical files, resumes a verified partial prefix, and re-hashes the full file at the end.
6. Append `file_verified`; write assets first, entry last; append `deployment_complete`.

A pre-broadcast rejection (e.g. node refused `eth_sendTransaction`) appends a `note`, not a
terminal failure: nothing was sent and the nonce is untouched, so a later resume may retry.

## 4. Nonce lock

```
start = max( chain.getTransactionCount(signer, "pending"),
             journal.maxConsumedNonce() + 1 )
```

- `maxConsumedNonce` counts only mined successes and reverted-but-broadcast transactions
  (both consume a nonce); pre-broadcast rejections do not.
- If any `tx_sent` is unresolved, allocation throws `UPLOAD_INTERRUPTED`.
- Allocation is serialized in-process (promise queue), so concurrent tasks cannot share a nonce.

## 5. Fork test evidence

`tests/fork/journal.test.ts` runs against a fresh Anvil fork (fork block recorded at runtime):

- A 3-file release (30,000 B app with 2 chunks, 500 B CSS, small `index.html`) is executed with
  `maxTransactions: 2`, interrupting after the first asset. The journal is **not** complete,
  has 2 transactions and 1 verified file.
- Resuming with the same journal adds exactly **2** transactions, finishes the release, and
  every manifest file matches its raw SHA-256/size when read back.
- Journal invariants: 4 transactions, 4 unique hashes, nonces strictly increasing, entry mined
  block greater than every asset block, `deployment_complete` present.
- Replaying the completed journal sends **0** transactions and still verifies the site.
- A journal whose plan fingerprint differs is rejected with `PLAN_STALE` (no writes).

Unit coverage: journal replay/truncated tail/duplicate events/lock, nonce start/serialization/
unresolved refusal, operation fingerprints and deterministic journal paths.

## 6. Limitations / carry-forward

- No raw-transaction storage or fee replacement: a transaction that was broadcast but never
  appears requires operator reconciliation (fail closed by design).
- A transaction that reverted after broadcast consumes a nonce and is terminal for that
  fingerprint; the operator must inspect the journal and start a new plan.
- The journal is local (file per deployment). The PostgreSQL/BullMQ journal is P2-06; the
  event shape is intentionally JSON-serializable for that migration.
- Approval binding / operator TTL verification is not part of this slice (P2-08); entry cutover
  with full reference verification is P1-08.
- Still no mainnet writes. P0-07 remains gated on explicit budget authorization.

## 7. Reproduce

```bash
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"

corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test:unit          # 246 tests
corepack pnpm test:fork          # 40 tests, includes tests/fork/journal.test.ts
```

Running `test:fork` regenerates the P0 fork evidence JSONs; the P1-06 evidence run backed them
up and restored them afterwards so the P0 hashes stay frozen.
