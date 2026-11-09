# Stage C Re-Review — Compression Release (2026-10-29)

Independent read-only re-review of `compression-release` at HEAD `9094ad8` (PR #32 against `main`).
Baseline: `docs/research/compression/stage-c-review-2026-10-29.md` (F1–F9).
Worktree `/private/tmp/tapeci-compression-worktree-20261028` was clean at start (branch
`compression-release`, HEAD `9094ad8`, five commits `main..HEAD`). The only file this review writes
is this report; no code, test, other doc, or commit was changed.

## 1. Verdict

**fix first.** No P0 or wrong-bytes path was found, and F8/F2 are genuinely closed. But three of the
six claimed fixes are only partially closed: F1 still does not verify `sourceArtifactDigest` (the
prior review called F1 a P1), F3 fixes only the load path while the rollback route still requires a
raw key before it looks at the pin, and F4 adds the aggregate cap but leaves the stored-vs-decoded
interaction and the post-receipt browser stream check open. Stage D should not be treated as cleared
until the F1 residual is either implemented or explicitly downgraded and the F3 rollback invariant
is fixed or formally accepted as a P2.

## 2. Six claimed fixes

| ID | Claim | Status | Evidence |
|---|---|---|---|
| F8 | Compressed record outside planning cannot rebuild from source even when pin and manifest are NULL | **closed** | `apps/api/src/worker/runtime.ts:286-289` checks `BUILT`/`VALIDATING` before any source read; test `tests/p2/worker/prepared-artifact.test.ts:197-210`. Caveat: the guard keys off `request.mode`; a legacy compressed row with `preparation_request = NULL` parses as original (`preparation-policy.ts:20`) and bypasses it. |
| F9 | Rollback of a compressed release with NULL pin returns `409 PREPARED_ARTIFACT_UNAVAILABLE` instead of 202 | **closed** (202 eliminated) | `apps/api/src/routes/projects.ts:706-714`; test `tests/p2/worker/prepared-artifact.test.ts:212-255`. If the raw key is also missing, the earlier `ARTIFACT_UNAVAILABLE` check at `projects.ts:699-700` wins, so the stated code is only returned when a raw key exists. |
| F1 | `artifactDigest` recomputed from manifest rows at freeze and load; `releaseId` derivation checked | **partially closed** | `prepared-artifact.ts:68,129,151-166` does this for compressed snapshots. `sourceArtifactDigest` remains shape-checked only (`:128`) and is never recomputed or matched to the pack index; `assertPreparedDigests` is also skipped whenever `request.mode === "original"`, including legacy compressed rows whose request is NULL. |
| F2 | `0020` down migration refuses while any pin or preparation request exists | **closed** | `packages/database/migrations/0020_prepared_artifacts.down.sql:7-20`; test `tests/p2/db/migrations.test.ts:319-349` verifies refusal and that both columns survive. It remains a non-reversible blocking migration; prior review asked for that to be documented. |
| F3 | Pinned deployment with no `artifactStorageKey` and no upload rows can still load its frozen snapshot | **partially closed** | Load path: `runtime.ts:243-268`, `prepared-artifact.ts:169-181`; test `tests/p2/worker/prepared-artifact.test.ts:295-312`. Rollback path still rejects the same row: `apps/api/src/routes/projects.ts:689-700` throws `ARTIFACT_UNAVAILABLE` before the pin branch at `:706-714`. |
| F4 | `parsePackIndex` rejects an index whose declared `storedBytes` total exceeds the aggregate bound | **partially closed** | `packages/compression/src/pack-index.ts:63-68`, `types.ts:16`; test `tests/unit/compression.test.ts:122-160`. The aggregate check exists, but the decoded bound does not constrain stored bytes and the browser stream check is unchanged. |

## 3. Did any fix weaken a check?

**F3 context relaxation.** `contextMatches` (`apps/api/src/worker/prepared-artifact.ts:169-181`)
treats expected `sourceArtifactKey` and `sourceArtifactSha256` as wildcards when they are `null`.
Both are skipped if a row has no `artifactStorageKey`, no upload row, and `artifactSha256 = null`.
An attacker who controls a stored archive cannot exploit this to substitute arbitrary bytes: the
pin is re-checked against its content-addressed key at `prepared-artifact.ts:99`, and
`LocalObjectStore.get` also verifies the hash (`packages/github/src/ingest.ts:127-146`). The row
still guarantees project, repository, commit, chain, registry, container, the exact preparation
request and gateway, `manifestSha256` when set, and every file hash against the manifest. What is
lost is provenance to the original source tar; a pin-only row with `manifestSha256 = null` could
resolve to a snapshot from a different build of the same commit. That is a data-repair assumption,
not an unauthenticated byte-substitution path. Safe in the narrow sense, but the test only covers
the key-null/hash-present case, not both fields null.

**F1 original-mode skip.** `prepareVersionedRelease` computes `artifactDigest` over the raw source
before entry rewriting (`packages/release/src/prepare.ts:86-92`), while manifest rows use the
rewritten entry and `releases/<releaseId>/...` paths (`prepare.ts:115-129`). A probe gave
`0x0898…1364` for the original digest versus `0xc540…0210` for `computeArtifactDigest(manifest.files)`.
The skip is justified because the original value is a source-build identity, not a physical
published-byte identity. The comment's absolute "cannot match" is overstated: in root mode with no
entry rewrite, the two values can and do match (probe: equal). The real loophole is mode-based:
a compressed snapshot whose `preparation_request` is NULL or original skips the check entirely.

**F4 stored vs decoded.** `MAX_STORED_BYTES = MAX_DECODED_BYTES` (`types.ts:16`), but the parser
never enforces `storedBytes <= decodedBytes` per object (`pack-index.ts:63-68`). A probe accepted an
index with eight 8,000,000-byte stored objects and one decoded byte each: both aggregate checks
pass, yet a browser would fetch 64,000,000 bytes to produce 8 bytes. The cap does reduce the old
~34 GB theoretical fetch to 64 MiB, but it does not make the decoded bound bound the fetch.
`browser.ts:66-79` still adds `part.value.length` before checking `maxBytes`, so one oversized
chunk is buffered before rejection; F4's "pre-receipt" half is unchanged.

## 4. Test validity

| Test | Fails if fix reverted? | Why / gap |
|---|---|---|
| F3 `tests/p2/worker/prepared-artifact.test.ts:295-312` | **yes** | Old code throws `INVALID_ARTIFACT` at `runtime.ts:248-250` before reaching the pin. But it only nulls `artifactStorageKey`; `artifactSha256` still matches, so the test would also pass if `contextMatches` ignored both source fields unconditionally. No strict-path negative case. |
| F1 `tests/p2/worker/prepared-artifact.test.ts:258-292` | **yes** | Without `assertPreparedDigests`, `freezePreparedArtifact` succeeds and the expected rejection fails. Only freeze is tested; load-time recomputation and the separate `releaseId` branch are untested (the zero-digest case fails at the digest check first). `sourceArtifactDigest` is not tested at all. |
| F4 `tests/unit/compression.test.ts:122-160` | **yes** | Without the stored check the same fixture throws `Decoded byte limit exceeded` (9 × 8 MB = 72 MB also exceeds the decoded 64 MiB bound), so the error-message assertion fails. The fixture is confounded: a check that summed `decodedBytes` by mistake would also pass. |
| F2 `tests/p2/db/migrations.test.ts:319-349` | **yes** | Without the guard, down drops both columns and `captureError` returns no Error, failing `toBeInstanceOf`. The fixture sets a pin and a request together, so a guard that checked only `prepared_artifact_key` would also pass; the request-only condition is not isolated. |

The older F8/F9 tests (`prepared-artifact.test.ts:197-210,212-255`) also fail on revert and cover the
claimed rows; F9 does not cover the raw-key-missing branch.

## 5. New findings (severity-ordered)

**P1 (residual of prior P1 F1) — `sourceArtifactDigest` is still unchecked.** The commit message
claims both digests are recomputed, but `prepared-artifact.ts:128` only regex-checks
`metadata.sourceArtifactDigest`; `assertPreparedDigests` (`:151-166`) never reads it, and
`loadPreparedArtifact` returns it at `:131` to no consumer. The prior review's F1 fix required both
digests from the frozen rows/pack index. Low current impact because no code consumes the value, but
the fix claim is false and Stage D must not treat it as verified identity.

**P2 — F3 rollback path still requires a raw key before the pin.** `apps/api/src/routes/projects.ts:689-700`
resolves `artifactStorageKey`/uploads and throws `ARTIFACT_UNAVAILABLE` when absent, before the pin
check at `:706-714`. A pinned compressed release that `loadDeploymentArtifact` now successfully loads
therefore cannot be rolled back if its raw key was cleaned up. This also makes the F9 code path
return `ARTIFACT_UNAVAILABLE` rather than `PREPARED_ARTIFACT_UNAVAILABLE` for a pin-null row with no
raw key. Operational/legacy gap (normal freeze sets the key at `runtime.ts:306`), not a wrong-bytes
path.

**P2 — Legacy compressed rows with `preparation_request = NULL` still bypass F8/F9.** `parsePreparationRequest`
returns `mode: "original"` for NULL (`apps/api/src/worker/preparation-policy.ts:20`). Such a row
skips the `request.mode !== "original"` guard at `runtime.ts:287` and the rollback check at
`projects.ts:706-707`; if both pin and manifest are NULL it can still take the source-preparation
path, and rollback returns 202 before failing later on the stored-manifest comparison. This is the
legacy case the prior review noted under F3; it is not in the Lead's list of remaining P2s.

**P2 — F4 browser residual.** As above: 64 MiB can still be fetched for an index with almost no
decoded output; `readStream` checks after adding a chunk. Track it as an explicit residual rather
than calling F4 closed.

**P2 — The compressed pin/manifest invariant is still not enforced at approval or in the DB.** The
prior review's minimum fix #2 asked for an explicit invariant; `apps/api/src/routes/deployments.ts:436-439`
checks only `manifestSha256`, not `prepared_artifact_key`, and `packages/database/src/schema.ts:399-401`
has no constraint. A compressed `AWAITING_APPROVAL` row with a NULL pin can be approved and only
fails closed at execution (`runtime.ts:287-289`).

**P3 — F2's blocking migration is undocumented.** The guard prevents data loss but makes 0020
down non-reversible whenever any pin/request exists; the prior review asked for this to be
documented as a blocking migration. No doc or export/restore procedure was added.

**Recorded P2s still open (verified):** F5 — `compareReleaseCosts` has no production caller
(`packages/deployer/src/comparison.ts:4-18`; only `tests/unit/release-cost-comparison.test.ts` and
`tests/fork/compressed-release.test.ts:53`). F6 — the missing-archive test uses the original
`deployment()` at `tests/p2/worker/prepared-artifact.test.ts:88`, not a compressed pin. F7 —
original-mode digest mismatch remains (`prepare.ts:86-93` vs `release-plan.ts:488-490`). The Lead's
"only F5, F6, F7 remain open" statement is therefore incomplete: F1/F3/F4 residuals above are also
open and were not recorded in the Lead's summary.

## 6. What I could not verify

- **C4 measurement** was not run (explicitly out of scope; ~160 s and needs the TapeKit checkout).
  C2 fork test was run: `tests/fork/compressed-release.test.ts` 1 file / 1 test passed in 81.5 s.
- Browser/UI C3 journeys, the full Stage B browser matrix, and the remaining fork suites were not
  run. Only `tests/fork/compressed-release.test.ts` was exercised.
- Migration behavior was tested only against disposable PostgreSQL, not a persistent environment.
- Test-revert behavior above was established by reading the code and fixtures; I did not mutate the
  code or tests (the deliverable is the only written file).

### Commands and numbers actually observed

| Command | Result |
|---|---|
| `pnpm check` | exit 0 (eslint, root tsc, web tsc) |
| `pnpm exec vitest run tests/unit` | 38 files passed, **624 tests** |
| `DATABASE_URL=… vitest run tests/p2` | 51 files passed, **420 tests** |
| `TAPECI_COMPRESSION_FORK=1 … vitest run tests/fork/compressed-release.test.ts` | 1 file, **1 test**, 81.5 s |
| Focused files inside p2 | `prepared-artifact.test.ts` 11 tests, `migrations.test.ts` 6 tests |

The C4 measurement is unreviewed here; the earlier review's reproduction claim is not re-adopted.
