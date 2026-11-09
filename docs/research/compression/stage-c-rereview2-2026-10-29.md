# Stage C Re-Review 2 — Compression Release (2026-10-29)

Independent read-only review of `compression-release` at HEAD `40411bf` (draft PR #32). Baseline: `docs/research/compression/stage-c-rereview-2026-10-29.md` (F1/F3/F4 residuals). Worktree `/private/tmp/tapeci-compression-worktree-20261028` was clean at start and after the runs; branch and HEAD match. The only change is this untracked report.

## 1. Verdict

**residuals closed.** All three claims hold in the production path. The qualifications below (all P3) are not wrong-bytes paths: `sourceArtifactDigest` remains a caller-anchored, shape-only label at the freeze/load boundary, legacy `preparation_request = NULL` rows fail closed late, and `MAX_STORED_BYTES` is now redundant inside `parsePackIndex`.

## 2. Residuals

### F3 — rollback route (`apps/api/src/routes/projects.ts`)

Claim: the pinned/compressed decision now precedes raw-key resolution, so a pinned compressed release with no `artifactStorageKey` and no upload rows can be rolled back.

**Status: closed** (request-tagged compressed rows; legacy NULL-request caveat below).

- Pin before raw key: `projects.ts:689-702` parses the request and computes `targetPinned` (`:693-694`), refuses a compressed row without a pin (`:695-701`), and only then resolves `artifactStorageKey`/uploads (`:703-712`). The raw-key guard is now conditioned on `!targetPinned` (`:713-715`).
- Pinned + `preparation_request` NULL: `parsePreparationRequest(NULL)` returns `original` (`preparation-policy.ts:20`). The route skips both refusals, copies `preparation_request: null` and the pin into the rollback row (`projects.ts:729-731`). In the worker, `request.mode` is `original`, but the pin branch still calls `loadPreparedArtifact` (`runtime.ts:273-274`); `prepared-artifact.ts:119` compares the parsed metadata request with expected. A pin frozen from a compressed request therefore fails `PLAN_STALE`/`prepared request context mismatch` (fail closed, generic error); a pin frozen in original mode loads. No wrong bytes, but a legacy compressed row with NULL request gets 202 and fails later, not a successful rollback.
- Not pinned + compressed + missing raw key: the first guard fires, so it returns `409 PREPARED_ARTIFACT_UNAVAILABLE` (`projects.ts:695-701`), not `ARTIFACT_UNAVAILABLE`. This fixes the prior F9 error-code path; both are 409, so only diagnostics change. Only a legacy NULL-request row falls through to `ARTIFACT_UNAVAILABLE` at `:713-715`.
- Rollback row: `prepared_artifact_key` is copied at `projects.ts:730`; the worker pin branch loads it (`runtime.ts:273-274`) and does not require `artifactStorageKey` (`runtime.ts:247-263`). The new test loads the created deployment and compares `releaseManifestHash` (`prepared-artifact.test.ts:388-391`); it passes. Yes, loadable.

### F1 — `sourceArtifactDigest` (`apps/api/src/worker/prepared-artifact.ts`)

Claim: a compressed snapshot refuses to freeze without an explicit digest; the physical `artifactDigest` fallback is gone.

**Status: closed.**

- Fallback: `freezePreparedArtifact` now uses `input.prepared.sourceArtifactDigest ?? (request.mode === "original" ? input.prepared.artifactDigest : null)` and fails when null (`prepared-artifact.ts:69-77`). Compressed requests cannot use the fallback; the new test (`prepared-artifact.test.ts:315-354`) covers it.
- Original mode: `prepareVersionedRelease` computes `artifactDigest` from source files before entry rewriting (`packages/release/src/prepare.ts:86-92`), and `sourceDigest` (`packages/compression/src/analyze.ts:23,54-56`) hashes the same `{path,size,sha256}` rows; the fallback is the logical source digest, so it remains correct. `tests/unit/prepared-artifact.test.ts:16-29` freezes/loads original mode with no explicit source digest.
- Shape-only: `loadPreparedArtifact` still only regex-checks `metadata.sourceArtifactDigest` (`prepared-artifact.ts:137`) and never recomputes it. But the production chain anchors it: `analyzeCompression` derives `sourceArtifactDigest` from `sourceDigest(files)` (`analyze.ts:23,54-56`); `prepareCompressedRelease` calls `decodeCandidate` before returning, which recomputes `sourceDigest(decoded files)` and rejects a mismatch against `index.sourceArtifactDigest` (`decode.ts:8-27`, `compressed.ts:20,44`); `freezePreparedArtifact` copies that value. The pin is `sha256/<archive hash>` (`prepared-artifact.ts:97-100`) and both `loadPreparedArtifact` (`:108`) and `LocalObjectStore.get` (`packages/github/src/ingest.ts:127-146`) verify the archive hash. For the only production freeze caller (`runtime.ts:305`) the argument is sound, not hand-waving.
- Bypass: `freezePreparedArtifact` is exported and does not validate the source digest itself (it accepts any runtime string), and `loadPreparedArtifact` only shape-checks. A direct caller could freeze a compressed snapshot with a fabricated Hex digest that never went through `decodeCandidate`; no production path does (only `runtime.ts:305`; tests use `prepareCompressedRelease`). This is a caller-discipline gap, not a reached path; no current consumer reads the value.

### F4 — stored-byte bound (`packages/compression/src/pack-index.ts`, `types.ts`)

Claim: `storedTotal > max(MAX_FILE_BYTES, decodedTotal)` rejects an index declaring 64 MB of objects that decode to 8 bytes.

**Status: closed.**

- Rule: `pack-index.ts:70-72`. Probe: 8 objects × `storedBytes: 8_000_000`, `decodedBytes: 1` gives `storedTotal = 64_000_000`, `decodedTotal = 8`, `max = 8_400_000`; rejected with `Stored byte limit exceeded`. The old parser accepted it because `64_000_000 < MAX_STORED_BYTES` (67_108_864) and the decoded total was 8. The new unit assertion is `compression.test.ts:155-166`.
- Legitimate candidates: the analyzer uses `gzip` only when `compressed.length < raw.length`, otherwise `identity` (`analyze.ts:71-73`), so `storedBytes <= decodedBytes` per object and `storedTotal <= decodedTotal`. Probe results: all four strategies on the small fixture parse; an 8,399,999-byte incompressible file is identity 8,399,999/8,399,999 and parses; a 4,096-file fixture parses for original (16/16), gzip-individual (16/16), gzip-whole (65/12,298) and gzip-grouped (63/12,298). No legitimate candidate rejected.
- `MAX_STORED_BYTES`: in `parsePackIndex` it is subsumed once `:31` caps `decodedTotal` at 64 MiB and `MAX_FILE_BYTES` (8.4 MB) is below that: a proportional pass implies `storedTotal <= 64 MiB`, so `|| storedTotal > MAX_STORED_BYTES` can no longer reject an index that line 31 would accept. It is still load-bearing for `parsePreviousAnalysis` (`pack-index.ts:13`), which reuses `parseObjects` without the decoded aggregate check; a 9 × 8,000,000 stored / 64 MiB decoded previous candidate is rejected by `MAX_STORED_BYTES` alone. Not dead code, but redundant in the `parsePackIndex` path.

## 3. Test validity

| Test | Fails if fix reverted? | Why |
|---|---|---|
| `prepared-artifact.test.ts` — refuses to freeze a compressed snapshot that omits its source artifact digest (`:315-354`) | **yes** | Old code falls back to `valid.prepared.artifactDigest`; `assertPreparedDigests` passes because that digest matches the rows, freeze resolves, and `rejects.toThrow` fails. |
| `prepared-artifact.test.ts` — rolls back a pinned compressed release whose raw artifact key is gone (`:356-395`) | **yes** | Old route resolved the raw key first; with uploads deleted and `artifactStorageKey` null it returned `409 ARTIFACT_UNAVAILABLE` before the pin branch, so `expect(202)` fails. The test also proves the new row's pin loads. Caveat: it leaves `artifactSha256` non-null, so it does not test both source fields null. |
| `compression.test.ts` — aggregate/proportional bound (`:122-168`) | **yes** | The first 9×8MB fixture is confounded (old `MAX_STORED_BYTES` already rejects it). The decisive 8×8,000,000 stored / 1 decoded probe is 64,000,000 < 67,108,864 with decoded total 8, so only the new proportional rule rejects it; without it, `expect(...).toThrow` fails. Caveat: the fixture is parser-only; its single file maps 8 MB to an object declared 1 byte and seven objects are unreferenced, so `validatePackCoverage` would reject it before a browser fetch. A coverage-valid variant with eight 1-byte files also fails the new rule. |

## 4. New findings (severity-ordered)

**P3 — `sourceArtifactDigest` has no local validation.** `freezePreparedArtifact` accepts any value (no shape check) and `loadPreparedArtifact` only regex-checks; the guarantee depends on the sole production caller using `prepareCompressedRelease`. Add a shape check at freeze or parse the frozen pack index and compare, if Stage D will display or bill against this value.

**P3 — Legacy NULL-request rows fail late.** A row whose `preparation_request` is NULL parses as `original`; if its pin metadata is compressed, rollback answers 202 and the worker fails with a generic `prepared request context mismatch`; if unpinned and raw-key-less it returns `ARTIFACT_UNAVAILABLE`. The same parse also makes such a row take the original-mode fallback and skip `assertPreparedDigests`; no current production path creates a compressed pin with a NULL request, and the path is fail-closed, but it is not covered by the new F3 test.

**P3 — `MAX_STORED_BYTES` is now dead weight in `parsePackIndex`.** It still constrains `parsePreviousAnalysis`; removing it globally would widen CLI previous-report acceptance. Keep it, but a comment or test distinguishing the two paths would prevent future cleanup mistakes.

## 5. What I could not verify

- I did not run the fork/browser/UI suites; only the three required commands were run.
- I did not mutate code or tests to force the "reverted" behavior; test validity above is from the commit diff and code paths, not an actual revert run.
- I did not exercise the legacy `preparation_request = NULL` path against PostgreSQL; it is traced from `preparation-policy.ts:20` and `prepared-artifact.ts:119`.
- The C4 measurement and production gateway qualification are out of scope; F5/F6/F7 were left as accepted open items and not re-audited.

## Run numbers

| Command | Result |
|---|---|
| `pnpm check` | exit 0 (lint, root tsc, web tsc) |
| `pnpm exec vitest run tests/unit` | 38 files passed, **624 tests** |
| `DATABASE_URL=… pnpm exec vitest run tests/p2` | 51 files passed, **422 tests** |

### Summary

residuals closed
F1 closed: compressed freeze now requires an explicit source digest; the decode-time anchor holds for the production path.
F3 closed: the rollback route decides the pin before the raw key; a pinned compressed row with no raw key rolls back and loads its pin.
F4 closed: the proportional stored/decoded rule rejects the 64 MB/8-byte probe; analyzer candidates still pass.
Most serious remaining issue: none in scope; the P3 caller-discipline and legacy NULL-request caveats are not wrong-bytes paths.
