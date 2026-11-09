# Stage C Review — Compression Release (2026-10-29)

Reviewer: independent read-only review of `compression-release` (PR #32). The task named
`5af3896` as the base. During the review another actor created commit `34df92b` ("fix(compression):
close the two gaps the Stage C review found") and committed this report with it; `34df92b` is now
the current branch HEAD. I did not author that commit or any source edit. This report states which
results are for `5af3896` and which are for `34df92b`. Worktree: `/private/tmp/tapeci-compression-worktree-20261028`.
No code, tests, other docs, commits, or mainnet state were changed by this review; the only file
written is this report.

**Worktree drift observed during review.** The checkout was clean when the review started. At
09:58–10:00, uncommitted edits appeared in `apps/api/src/routes/projects.ts`,
`apps/api/src/worker/runtime.ts`, `packages/shared/src/errors.ts`, and
`tests/p2/worker/prepared-artifact.test.ts`; they became `34df92b`. They implement a planning-phase
guard and rollback preflight, and include tests. They do not fix the digest/migration findings in
this report. Reviewing and committing code while a reviewer is reading the tree is itself a
release-process risk: the PR changed under the reviewer.

## 1. Verdict

**trustworthy-with-fixes.**

I did not find a P0 in the five high-risk areas: the normal C2 pin path does not fall back to
source, the C3 insert copies no approval/pin/plan/journal, and compressed approval is bound to the
physical `releaseManifestHash`. I found two P1 gaps that remain in `34df92b` (snapshot digest
metadata is never recomputed; migration 0020 destroys the pin data on down) and several P2 gaps
(raw-key-before-pin loading, aggregate stored-object limits, dead cost-comparison code, and test
coverage). The earlier HEAD `5af3896` also had two P1 gaps that `34df92b` closes: a compressed row
outside planning with NULL manifest could rebuild from source, and rollback answered 202 before
discovering a missing pin; those are recorded in §5.1. Stage D
can start only after the P1 fixes, and must not treat `artifactDigest`/`releaseId` as a verified
physical identity until they are recomputed from the frozen rows.

The implementation is materially better than the previous "declared done" failures in this repo:
the C2 tests exercise source deletion, the C1 adapter has real physical/decode tests, and the C4
measurement can be independently reproduced (details in §5). It is not yet a clean pass for
production/Stage D.

## 2. The five high-risk areas

### 2.1 C2 snapshot load — "never recompress or fall back to source"

**Claim.** The C2 addendum says snapshot loads "validate exact context, manifest and bytes and
never recompress or fall back to source" (`docs/superpowers/specs/2026-10-28-compression-development-spec.md:101-103`).
The C2 plan adds: "No recompression on load; corrupted/missing snapshot fails, never falls back
to source" (`docs/superpowers/plans/2026-10-28-compression-approved-artifacts.md:17`).

**What the code does.**

- `loadDeploymentArtifact` first resolves a raw artifact key. It resolves `artifactStorageKey`, or
  the latest `artifact_uploads` row, and throws `INVALID_ARTIFACT` if neither exists
  (`apps/api/src/worker/runtime.ts:233-245`). It also rejects a key that is not
  `^sha256/<64 lowercase hex>\.tar$` (`runtime.ts:246-247`).
- It then builds the exact context (`runtime.ts:248-253`), parses the request
  (`runtime.ts:254`), resolves the qualified gateway and rejects a nonzero service fee
  (`runtime.ts:255-256`), and puts both into `expected` (`runtime.ts:257`).
- If `prepared_artifact_key !== NULL`, it calls `loadPreparedArtifact` only and returns. There is
  no `try/catch` here and therefore no source fallback (`runtime.ts:258-261`).
- `loadPreparedArtifact` re-hashes the archive and compares it to the content-addressed key
  (`apps/api/src/worker/prepared-artifact.ts:84-85`); parses and bounds `prepared.json`
  (`prepared-artifact.ts:89-93`); checks exact context, gateway and request
  (`prepared-artifact.ts:95-96`); recomputes and checks `releaseManifestHash` against both the
  metadata and `deployment.manifestSha256` (`prepared-artifact.ts:97-100`); checks the prepared
  file count and every payload row's size/SHA-256 (`prepared-artifact.ts:101-109`); and checks the
  entry bytes (`prepared-artifact.ts:110-113`). A missing object throws
  `OBJECT_STORE_NOT_FOUND` from `LocalObjectStore.get` (`packages/github/src/ingest.ts:127-137`);
  no source read exists on this branch.
- In the current HEAD `34df92b`, if `prepared_artifact_key === NULL` and the request is
  non-original, a `planningPhase` guard tests `state === "BUILT" || state === "VALIDATING"`
  (`runtime.ts:262-274`). Outside planning it throws `PLAN_STALE`; inside planning it takes the
  source path: `objectStore.get(storageKey)`, tar ingest, source-digest check,
  `prepareDeploymentRelease`, optional stored-manifest check, `freezePreparedArtifact`, CAS bind,
  and reload (`runtime.ts:275-292`). The source path is therefore intentional only in planning;
  the old `manifestSha256`-only guard that allowed an approved row with both columns NULL to
  recompress is fixed by `34df92b` (§5.1).
- The API approval route refuses to approve a deployment with `manifestSha256 === NULL`
  (`apps/api/src/routes/deployments.ts:436-439`), so an honest API flow cannot create the
  dangerous approved-row state. The state machine still lists
  `AWAITING_APPROVAL -> APPROVED` (`packages/queue/src/state-machine.ts:37`), but the phase guard
  now closes the fallback regardless of how the row reached `APPROVED`.

**Failure-path results.**

- Pin present, archive missing: fails closed with `OBJECT_STORE_NOT_FOUND`; no source read
  (`runtime.ts:258-261`, `prepared-artifact.ts:84`). PASS.
- Pin present, archive digest mismatch: fails at `prepared-artifact.ts:85` before metadata use.
  PASS.
- Pin present, manifest/context disagreement: fails at `prepared-artifact.ts:95-100` or
  `assertManifestContext` (`prepared-artifact.ts:123-125`). PASS.
- Pin NULL, compressed request, non-null manifest: fails `PLAN_STALE` outside planning; current
  guard at `runtime.ts:271-274`. PASS.
- Pin NULL, compressed request, NULL manifest, outside planning: fails `PLAN_STALE` at
  `runtime.ts:271-274`; source tar is never read. PASS in `34df92b`; the pre-fix `5af3896` fell
  through to a source rebuild and is recorded in §5.1.
- Pin NULL, compressed request, NULL manifest, state `BUILT`/`VALIDATING`: source preparation is
  allowed by design; this is the planning phase that creates the snapshot.
- Pin present but `artifactStorageKey`/upload row NULL: the function throws at
  `runtime.ts:243-244` before it reaches the pin branch. A snapshot-only row is therefore not
  self-contained even though the frozen archive holds all bytes. This is an availability gap, not
  a wrong-bytes path.

The normal claim is true; `34df92b` closes the old conditional `manifestSha256` hole with the
planning-phase guard. The load path still requires a non-null raw key before it checks the pin;
that is an availability gap (F3), not a fallback to source.

### 2.2 C3 new-attempt semantics — "copies no approval, pin, plan or journal"

**Claim.** The C3 addendum says a new attempt "cop[ies] no approval, pin, plan or journal"
(`docs/superpowers/specs/2026-10-28-compression-development-spec.md:114-117`), and the C3 report
says it "does not alter the original deployment or copy its snapshot, Manifest, signature,
approved cap or recovery journal" (`docs/research/compression/stage-c3-2026-10-28.md:11-13`).

**The INSERT actually sets exactly these columns** (`apps/api/src/routes/deployment-preparation.ts:69-82`):

`projectId` (`:70`), `containerId` (`:71`), `createdByUserId` (`:72`), `triggerKind:
"manual"` (`:73`), `commitSha` (`:74`), `state: "BUILT"` (`:75`), `targetChainId` (`:76`),
`registryAddress` (`:77`), `artifactStorageKey` (`:78`), `artifactSha256` (`:79`),
`preparation_request` (the submitted new request, `:80`), `sourceEventKey` (`:81`).

It does not set any of the sensitive columns:

- `prepared_artifact_key` (snapshot/pin) — not set (`packages/database/src/schema.ts:400`).
- `manifestSha256` (approved manifest) — not set (`schema.ts:401`).
- `planJson` (plan) — not set (`schema.ts:402`).
- `approvedCostCapWei` (approved cap) — not set (`schema.ts:405`).
- `recoveryContext` (journal/recovery identity) — not set (`schema.ts:418`).
- `rollbackTargetReleaseId`, `webhookDeliveryId`, `idempotencyKey`, `stateVersion`,
  `errorCode`, `errorMessage`, `estimatedCostWei`, `startedAt`, `finishedAt` — not set; DB
  defaults apply (`schema.ts:383-418`).

Approvals and signatures live in a separate `approvals` table keyed by `deployment_id`
(`packages/database/src/schema.ts:522-528`). This route inserts no approval row, and
`activeApproval` selects by `deployment.id` (`apps/api/src/worker/runtime.ts:407-418`), so the new
attempt has no inherited approval or signer. Its journal path is `recoveryContext ??
deployment.id` (`runtime.ts:209-212`); with no recovery context it gets a fresh journal.
`tests/p2/worker/prepared-artifact.test.ts:130` asserts the new row has `prepared_artifact_key:
null`, `manifestSha256: null`, `planJson: null`, `approvedCostCapWei: null`, and
`recoveryContext: null`.

The only carried planning inputs are the raw source pointers (`artifactStorageKey` and
`artifactSha256`, lines 78-79) and the new `preparation_request`. The C3 claim holds. I found no
P0 in this area.

### 2.3 C1 digest separation — which digest gates approval?

**Claim.** The C1 addendum says `prepareCompressedRelease` "retains Manifest v1 and emits separate
sourceArtifactDigest/artifactDigest; the latter covers all physical bytes and derives the release
ID" (`docs/superpowers/specs/2026-10-28-compression-development-spec.md:95`).

**Which digest is computed where.**

- For compressed releases, `prepareCompressedRelease` builds `files` from the physical entry
  descriptor, the pack index, and every stored object (`packages/release/src/compressed.ts:30-34`);
  `artifactDigest` is `computeArtifactDigest(files)` (`compressed.ts:35`); `releaseId` is
  `deriveReleaseId(commitSha, artifactDigest)` (`compressed.ts:36`). The returned
  `sourceArtifactDigest` is the candidate index's logical-source digest (`compressed.ts:44`).
- `computeArtifactDigest` hashes canonical `{path,size,sha256}` rows (`packages/artifact/src/manifest.ts:211-215`), so
  the compressed `artifactDigest` covers the physical bytes the publisher uploads.
- `planRelease` recomputes a plan `artifactDigest` from `manifest.files` using `sourcePath` plus
  row size/hash (`packages/deployer/src/release-plan.ts:488-490`). For compressed rows,
  `sourcePath` is the physical path (`compressed.ts:42`), so the two values are equal. I checked
  this with the actual fixture: both were `0x06543b...` (matching in the probe).
- Approval does not sign `artifactDigest`. `GET /v1/deployments/:id/approval-payload` emits
  `deployment.manifestSha256` as `message.manifestHash` (`apps/api/src/routes/deployments.ts:273-275, 313-315`);
  `POST /approve` passes that same value to `recordApproval` (`deployments.ts:536-550`).
  `persistPlan` sets `manifestSha256` to `prepared.releaseManifestHash`
  (`apps/api/src/worker/runtime.ts:334`), which is `releaseManifestHash(manifest)`
  (`packages/release/src/compressed.ts:44`; `packages/artifact/src/manifest.ts:305-343`).
  That manifest hash includes every physical row, including the pack-index row; the pack index
  contains `sourceArtifactDigest`. So the approval covers the physical bytes and the source digest
  transitively.
- Execution verifies each payload against its manifest row in `loadPreparedArtifact`
  (`prepared-artifact.ts:105-109`) and chain bytes in `verifyDeployment`
  (`runtime.ts:790-833`); it does not recompute `artifactDigest` or `sourceArtifactDigest`.
  The manifest hash is what the approval actually gates.

**The gap.** `freezePreparedArtifact` stores `input.prepared.artifactDigest` without checking it
against `computeArtifactDigest(manifest.files)` (`prepared-artifact.ts:55-60`), and
`loadPreparedArtifact` only checks the digest fields with a regex
(`prepared-artifact.ts:114-116`). It never recomputes either digest. `verifyDeployment` then
puts `loaded.prepared.artifactDigest` into the verification report
(`runtime.ts:790-796`). I ran a read-only probe that froze a valid compressed snapshot with
`artifactDigest = 0x00...00` while the actual physical rows hashed to
`0x43ff...b818b4`; `loadPreparedArtifact` accepted the snapshot and returned the zero digest.
This is not a user-controlled API path (the worker supplies the value), and it does not change
the approved manifest bytes; it is a P1 identity/integrity gap, not the P0 "approve one byte set
and publish another" defect.

**Original mode caveat.** In original mode, `prepareVersionedRelease` computes
`artifactDigest` from the raw source files before the entry rewrite
(`packages/release/src/prepare.ts:86-92`), while `planRelease` recomputes its
`artifactDigest` from manifest rows whose entry row is the rewritten entry
(`prepare.ts:115-129`; `release-plan.ts:488-490`). I confirmed with a probe that those two
values differ for a normal original release (`0x4f67...` vs `0x5d5b...`). The compressed path
is consistent; Stage D must not generalize the compressed rule to original mode.

### 2.4 Decompression bounds

**Claim.** The Stage B/C specifications promise bounded zlib output, total/file limits and a
verified decode boundary (`docs/superpowers/specs/2026-10-28-compression-development-spec.md:45-49`;
`docs/research/compression/stage-b-2026-10-28.md:56-60`).

**Constants and checks.**

- `MAX_ANALYSIS_FILES = 4096`, `MAX_DECODED_BYTES = 64 MiB` (`packages/compression/src/types.ts:5-6`);
  `MAX_FILE_BYTES = 24_000 * 350 = 8,400,000` (`packages/shared/src/chunks.ts:7-9`).
- `parsePackIndex` bounds the object count (`packages/compression/src/pack-index.ts:54-64`), the
  sum of declared object `decodedBytes` (`:31`), every file `size` (`:37`), every file `offset`
  (`:38`), the sum of file sizes (`:42`), and every stored object's `storedBytes` (`:63`).
- `decodeCandidate` checks object count, exact stored size, stored SHA-256, and uses
  `gunzipSync(bytes, { maxOutputLength: Math.max(1, object.decodedBytes) })`
  (`packages/compression/src/decode.ts:10-16`); it then checks every file range/hash and
  coverage/source digest (`:19-27`). A declared size smaller than the actual stream throws; a
  stream smaller than declared is caught by `raw.length !== object.decodedBytes` (`:16`).
  Identity objects are length-checked the same way.
- The browser path checks `MAX_PACK_INDEX_BYTES` at `packages/compression/src/browser.ts:14`,
  uses `readPackResponse(..., object.storedBytes)` at `:44`, checks stored length/hash at `:45-46`,
  caps decoded output at `object.decodedBytes` at `:48-51`, and verifies every mapped file hash at
  `:52-54`.

**Gaps.** There is no aggregate cap on *stored* bytes. The object count is bounded at 4,096 and
each `storedBytes` at 8.4 MB, so a valid index can declare up to ~34.4 GB of storage
(`pack-index.ts:55-64`). That is large enough to be a practical DoS even though decoded output is
capped at 64 MiB. In the browser, `readStream` checks `size > maxBytes` only after adding the
chunk (`browser.ts:72-78`); a malicious server can deliver one unexpectedly large chunk before
the limit is observed, so this is not strictly "before allocation." These are P2 robustness
findings; the decoded-output bound itself is real.

### 2.5 Rollback and resume for compressed releases

**Claim.** C2 says recovery/rollback copy the prepared pin/request and never rebuild; C2 report
says "Planning, execution, verification, reapproval continuation and rollback reuse those bytes"
(`docs/research/compression/stage-c2-2026-10-28.md:10-11, 23`; plan
`docs/superpowers/plans/2026-10-28-compression-approved-artifacts.md:19`).

**Rollback.** The rollback route finds the target release's deployment
(`apps/api/src/routes/projects.ts:680-687`) and inserts the rollback deployment with
`prepared_artifact_key` (`:715`), `preparation_request` (`:716`), `artifactStorageKey` (`:714`),
`artifactSha256` (`:717`) and `manifestSha256: release.manifestSha256` (`:718`). Before the
insert it resolves a raw key and throws `ARTIFACT_UNAVAILABLE` if it cannot find one
(`projects.ts:688-700`). That preflight does not consider the pin: a target with a pin but no raw
key is rejected even though the frozen bytes could be used. If a raw key string exists but its
object is gone, the route still returns 202 and the worker later fails on the pin.

`deployRollback` loads the rollback deployment (`apps/api/src/worker/runtime.ts:506`), compares the
loaded manifest hash to the target release (`runtime.ts:508-515`), and calls
`switchEntryToRelease` with `loaded.prepared.manifest` and `loaded.prepared.entryBytes`
(`runtime.ts:553-558`). `switchEntryToRelease` verifies every non-entry asset on chain first and
then writes the exact stored entry bytes (`packages/release/src/cutover.ts:450-528`). If the
snapshot archive is missing, `loadDeploymentArtifact` fails before any write; it does not
re-prepare a compressed release. C2's PostgreSQL test covers copy-through after source deletion
(`tests/p2/worker/prepared-artifact.test.ts:93-108`), and the compressed fork test exercises an
interrupted release, resume, second release, cutover and rollback (`tests/fork/compressed-release.test.ts:33-84`).
I ran that fork test successfully.

**Resume.** A reapproval continuation copies `prepared_artifact_key` and
`preparation_request` at `apps/api/src/recovery.ts:1408-1411`; `deployDeployment` loads the snapshot
and uses `recoveryPlanJson`/`planJson` rather than rebuilding (`apps/api/src/worker/runtime.ts:654-669`).
C2's PostgreSQL tests cover copy-through (`tests/p2/worker/prepared-artifact.test.ts:70-82`).

**Failure paths.** Pin missing archive -> `OBJECT_STORE_NOT_FOUND`; no source fallback. Pin
present but manifest differs from release -> `PLAN_STALE` before `switchEntryToRelease`; no
write. Pin NULL + compressed request + non-null manifest -> `PLAN_STALE`; no source fallback.
Pin NULL + request NULL -> defaults to original and attempts source preparation; the
`deployRollback` manifest comparison catches a compressed target. Core rollback/resume is
correct. In `34df92b` the route adds a pin preflight at `projects.ts:702-714`: a compressed target
with NULL pin returns 409 `PREPARED_ARTIFACT_UNAVAILABLE` before creating a deployment. It still
resolves/throws on the raw key before that preflight (`projects.ts:688-700`), and a legacy
compressed target with `preparation_request = NULL` is parsed as original, so the pin check is
skipped and the worker rejects later. F3 remains a P2 operational gap.

## 3. C1–C4 addendum claims

Status values: `present` = code and test evidence exist; `absent` = not delivered; `overstated`
= the code exists but the sentence claims more than it proves.

### Stage C1 addendum (spec lines 93–95)

| Claim | Status | Evidence |
|---|---|---|
| Supported physical mode is descriptor -> content-addressed pack index -> stored objects -> logical files. | present | `packages/release/src/compressed.ts:23-44`; `packages/compression/src/entry.ts:16-29`; `packages/compression/src/tapekit.ts:40-83`; `tests/unit/compressed-release.test.ts:19-27`. |
| `prepareCompressedRelease` retains Manifest v1 and emits separate `sourceArtifactDigest`/`artifactDigest`; physical digest covers all physical bytes and derives release ID. | present at preparation; **overstated at load** | `compressed.ts:35-44` computes both; `tests/unit/compressed-release.test.ts:23-27`. `apps/api/src/worker/prepared-artifact.ts:55-60,114-116` never recomputes the digest; §2.3/finding F1. |
| Pinned source overlay connects both TapeKit gateway modes, preserves directory/MIME/RPC behavior, and leaves live deployment disabled. | present | `scripts/compression/tapekit-overlay.ts:10-86`; overlay test 4/4 passed with the exact pinned checkout; actual live gateway remains an open gate. |
| `get` is virtualized; other physical site APIs retain physical semantics. | present | `packages/compression/src/tapekit.ts:58-80` spreads the original site and replaces only `get`; `prefetch`/`info` remain physical. |
| Live deployment, fees, API approval persistence, fork upload/rollback remain open. | present as documented gap (not delivered) | No C1 worker/API integration in commit; C2/C3 adds later pieces; C1 report lines 63–69. |

### Stage C2 addendum (spec lines 97–108)

| Claim | Status | Evidence |
|---|---|---|
| Worker preparation pins a deterministic physical snapshot before approval. | present | `apps/api/src/worker/runtime.ts:258-279`; `apps/api/src/worker/prepared-artifact.ts:39-80`; `tests/p2/worker/prepared-artifact.test.ts:57-79`. |
| Nullable `preparation_request`/`prepared_artifact_key` are carried through recovery and rollback. | present in code; **down migration loses them** | `apps/api/src/recovery.ts:1408-1411`; `apps/api/src/routes/projects.ts:715-716`; `packages/database/migrations/0020_prepared_artifacts.down.sql:2-4` (F2). |
| Snapshot loads validate exact context, manifest and bytes and never recompress/fall back. | **partly overstated** | Normal pin path: `runtime.ts:258-262`; `prepared-artifact.ts:84-113`; no fallback. But a compressed row with NULL `manifestSha256` falls through to source re-preparation (`runtime.ts:263-280`), and digest metadata is not checked (`prepared-artifact.ts:114-116`). |
| Original mode remains default; compressed requests require operator qualification; no public toggle; nonzero fees blocked. | present | `apps/api/src/worker/preparation-policy.ts:19-43`; `runtime.ts:254-256`; `routes/deployment-preparation.ts:28,60-66`. |
| Complete same-snapshot comparison is model-estimate and automatic selection remains original. | **overstated** | `packages/deployer/src/comparison.ts:4-18` exists and tests pass, but no API/worker/UI calls it; only tests/fork (`tests/release-cost-comparison.test.ts`, `tests/fork/compressed-release.test.ts:53`). |
| Disposable PostgreSQL/fork publication/resume/cutover/rollback passed. | present | `pnpm exec vitest run tests/p2` 415/415; `tests/fork/compressed-release.test.ts` 1/1 (88.8s); `tests/p2/worker/prepared-artifact.test.ts` 7/7. |
| Production gateway qualification, fee simulation, persistent migration/public review remain open. | present as documented gaps | C2 report lines 78-85; no live gateway/operator profile proof. |

### Stage C3 addendum (spec lines 110–123)

| Claim | Status | Evidence |
|---|---|---|
| Strategy selection and localized review panel on deployment Overview. | present | `apps/web/components/compression-preparation-panel.tsx:9-80`; `apps/web/app/deployments/[id]/page.tsx:313`; not independently run in this review. |
| GET/POST routes expose recorded snapshot identity and create an idempotent independent BUILT attempt. | present | `apps/api/src/routes/deployment-preparation.ts:32-100`; `tests/p2/worker/prepared-artifact.test.ts:112-150`. |
| New attempts require maintainer/owner, nonarchived/current target, preapproval nonrollback source and retained raw bytes. | present | `routes/deployment-preparation.ts:22-27,45-67`; `tests/p2/worker/prepared-artifact.test.ts:156-190`. |
| New attempts copy no approval, pin, plan or journal. | present | Insert columns at `routes/deployment-preparation.ts:69-82`; assertions at `tests/p2/worker/prepared-artifact.test.ts:130`; §2.2. |
| Matching retries recover the same ID even when source eligibility changes; current target/project/gateway and usable bytes gate enqueue. | present | `routes/deployment-preparation.ts:57-98`; `tests/p2/worker/prepared-artifact.test.ts:135-150`. |
| Shared opt-in gateway config, matching zero-fee choices, default none. | present | `apps/api/src/worker/preparation-policy.ts:46-58`; `apps/api/src/env.ts:117`; `.env.example:114`; `tests/unit/preparation-policy.test.ts:16`. |
| Recorded gateways removed from current options are not submitted by the form. | present | `compression-preparation-panel.tsx:17-24,62-71`; C3 report line 88. |
| Current plan remains available; new selection requires separate review/signature. | present | New deployment starts `BUILT` (`routes/deployment-preparation.ts:75`) and therefore needs its own plan/approval; `apps/web/app/actions.ts:465-470`. |
| Production compatibility and transaction simulation remain gates; no automatic selection. | present as documented gaps | C3 report lines 123-128; no automatic strategy path. |

### Stage C4 addendum (spec lines 125–135)

| Claim | Status | Evidence |
|---|---|---|
| Explicit local-fork benchmark restores one exact baseline before each of four strategy publications. | present | `scripts/compression/fork-measurement.ts:42-82`; `tests/fork/compression-measurement.test.ts:7-20`; I ran it: 1/1 passed in 154.8s and all four `baselineBlockHash` values matched. |
| Accounts complete successful receipts and separates mined fees from normalized gas at a common quote price. | present | `scripts/compression/measurement.ts:4-15`; `tests/unit/compression-measurement.test.ts:1-15`; my run reproduced the report's gas/byte figures exactly. |
| Actual pinned TapeKit chain kernel reads published contract bytes; built adapter/native response checks physical/logical bytes, MIME/hash, security/cache headers. | present | `scripts/compression/fork-measurement.ts:24-79`; imported `kernel/src/index.js`, built `compression.js`, `serve.fileResponse`; my run passed. |
| Direct fixture-container/quorum-1 checks are not paid-name, deployed HTTP/Cloudflare, independent-operator or mainnet qualification. | present as limitation | C4 report lines 45–49; script uses one local endpoint, quorum 1 (`fork-measurement.ts:44,66`). |
| Real-build incremental analysis and full production fee coverage remain gates; automatic selection stays original. | present as open gate | C4 report lines 93–98; `comparison.ts:16`; no automatic selection code. |

### Stage A acceptance (§10)

I mapped every listed case to a real test. None of these tests is a mock of the codec or filesystem.

| Required case | Real test |
|---|---|
| Actual gzip roundtrip and object/index integrity | `tests/unit/compression.test.ts:18` |
| Stable outputs across reordered files | `tests/unit/compression.test.ts:39` |
| Empty files | `tests/unit/compression.test.ts:98` (source fixture includes `empty.txt`) |
| Duplicate/noncanonical paths | `tests/unit/compression.test.ts:77` |
| Bad input hash | `tests/unit/compression.test.ts:77` |
| Unsupported schema/encoding | `tests/unit/compression.test.ts:121` |
| Corrupted/missing/unexpected objects | `tests/unit/compression.test.ts:110` |
| Output bounds | `tests/unit/compression.test.ts:137`, `:175` |
| Out-of-range/unmapped file data | `tests/unit/compression.test.ts:129`, `:146` |
| Incompressible identity fallback | `tests/unit/compression.test.ts:46` |
| Coarse-group incremental reuse | `tests/unit/compression.test.ts:68` |
| Byte-identical object deduplication | `tests/unit/compression.test.ts:57` |
| Oversized candidate rejection | `tests/unit/compression.test.ts:84` |
| Real filesystem CLI persistence/no overwrite/source-output isolation/previous-analysis handling | `tests/unit/compression-cli.test.ts:29,51,60,67,76,94,106,117` |

## 4. Findings

### P0

**None found in the five areas I traced.** The C3 INSERT copies no privilege-bearing column
(§2.2); the normal C2 pin path has no source fallback (§2.1); and compressed approval is bound to
the physical manifest hash, not merely to a source digest (§2.3). I am not upgrading a
conditional/inconsistent-row issue to P0 because the normal API path prevents it.

### P1

**F1 — The frozen snapshot's `artifactDigest`/`sourceArtifactDigest` are only shape-checked, never
recomputed from the frozen rows.** `apps/api/src/worker/prepared-artifact.ts:55-60` stores
`input.prepared.artifactDigest` without checking it against
`computeArtifactDigest(manifest.files)`; `prepared-artifact.ts:114-116` only tests the hex shape;
`apps/api/src/worker/runtime.ts:790-796` puts the value into the verification report. A probe that
froze a valid compressed snapshot with `artifactDigest = 0x0000...0000` was accepted and returned
the zero value, while the physical rows hashed to `0x43ff...b818b4`. The approved bytes are still
the manifest rows, but a stale/buggy snapshot can claim a different artifact identity and release
report; this is exactly the digest-separation edge Stage D must not inherit. Fix by recomputing
both digests from the manifest rows at freeze and load, and by checking
`deriveReleaseId(commitSha, artifactDigest) === manifest.releaseId`.
A later uncommitted worktree edit adds `assertPreparedDigests`
(`apps/api/src/worker/prepared-artifact.ts:121-151`), which checks the compressed
`artifactDigest`/`releaseId` pair at freeze and load; its focused test passes, but it deliberately
skips original mode and still does not check `sourceArtifactDigest`, so F1 is only partly closed.

**F2 — Migration 0020's down migration destroys the pin and request without backup.**
`packages/database/migrations/0020_prepared_artifacts.down.sql:2-4` drops
`deployments_prepared_artifact_key_check`, `prepared_artifact_key`, and `preparation_request`.
Re-applying `up.sql:2-5` recreates empty/null columns. A compressed deployment that was pinned
before the down migration therefore loses its `prepared_artifact_key`; after re-up
`loadDeploymentArtifact` sees `preparation_request` NULL (parsed as original at
`apps/api/src/worker/preparation-policy.ts:20`), so it cannot use the frozen compressed bytes and
will fail the stored-manifest check at `apps/api/src/worker/runtime.ts:285` or attempt a source
original preparation. The migration is not reversible without data loss, and the data it loses is
exactly what C2 relies on for resume/rollback. Make down non-destructive or reject it while
pinned compressed deployments exist; add a migration test that inserts a pin/request before down
and verifies retention.
A later uncommitted worktree edit adds exactly such a refusal guard
(`packages/database/migrations/0020_prepared_artifacts.down.sql:1-20`) and a migration test; the
test passes 6/6 in the focused file. This prevents silent data loss but makes the down migration
non-reversible while any preparation row exists; it should be documented as a blocking migration,
not called reversible.

### Resolved by 34df92b (historical; not open findings)

**F8 — Source-rebuild edge and F9 — 202-for-doomed-rollback were fixed in `34df92b`.**
At `5af3896`, a compressed row outside planning with `manifestSha256 = NULL` fell through the
`manifestSha256`-only guard (`runtime.ts:262`) into source re-preparation; and rollback copied a
NULL pin and returned 202 (`projects.ts:715,750`) before failing asynchronously. `34df92b`
replaced the guard with the `BUILT`/`VALIDATING` phase check (`runtime.ts:262-274`) and added the
409 preflight (`projects.ts:702-714`), with two PostgreSQL tests. I verified the focused file
passes 9/9 on that tree; I also ran the full p2 suite separately and it passed 417/417 (see §5).
Those two old P1s are closed in current HEAD. F3's raw-key-before-pin
ordering and the legacy `preparation_request = NULL` case remain P2.

### P2

**F3 — Snapshot loading still requires raw key state before it checks the pin.**
`apps/api/src/worker/runtime.ts:233-245` throws if `artifactStorageKey` and `artifactUploads` are
both NULL, before `runtime.ts:258-261` can load a `prepared_artifact_key`. A frozen snapshot that
contains all bytes therefore is not self-contained if the raw key column is absent (for example a
legacy or repaired row). The normal `freezePreparedArtifact` update sets the key at
`runtime.ts:287`, so this is an operational/legacy gap, not a wrong-publication path. The same
issue exists in rollback preflight at `apps/api/src/routes/projects.ts:688-700`.

**F4 — No aggregate bound on stored object bytes; browser stream limit is post-receipt.**
`packages/compression/src/pack-index.ts:55-64` caps each object at 8.4 MB and the object count at
4,096 but never sums `storedBytes`; the theoretical input is ~34.4 GB. In
`packages/compression/src/browser.ts:66-79`, `readStream` checks `size > maxBytes` only after
adding the incoming chunk. The decoded-output limits (`pack-index.ts:31,63`; `decode.ts:15-16`)
are real and should remain; add an aggregate stored-byte cap and a pre-read/stream-safe check.

**F5 — The "complete same-snapshot plan comparison" is a library without a production caller.**
`packages/deployer/src/comparison.ts:4-18` implements the estimator and always reports
`automaticSelection: "original"`, but a repository search finds callers only in
`tests/unit/release-cost-comparison.test.ts` and `tests/fork/compressed-release.test.ts`; no API,
worker, or console path invokes it. The C2 sentence at
`docs/superpowers/specs/2026-10-28-compression-development-spec.md:104-105` is therefore
`overstated` as a delivered product capability (the safety default is present).

**F6 — The "missing frozen archive" test covers original mode, not the compressed path.**
`tests/p2/worker/prepared-artifact.test.ts:85-91` creates the default (original) deployment,
deletes its pin, and asserts failure. It does not create a compressed pin, set its
`manifestSha256`, delete the archive, and assert that the still-present raw source is not used.
The code path is shared but the claimed compressed fail-closed behavior is not directly
regression-tested. Add the compressed case.

**F7 — Original-mode `artifactDigest` and plan/journal `artifactDigest` are different byte sets.**
`packages/release/src/prepare.ts:86-92` hashes the raw source before entry rewriting;
`packages/deployer/src/release-plan.ts:488-490` recomputes from manifest rows whose entry is the
rewritten bytes (`prepare.ts:115-129`). My probe produced different values for a normal original
release. This is pre-existing behavior, not introduced by C1, but Stage D must not treat
`artifactDigest`/`releaseId` as a physical digest for original releases. The compressed path is
consistent (probe matched).

## 5. What I could not verify

- **C4 numbers: I actually reproduced them.** Contrary to the task brief's note, the exact pinned
  TapeKit checkout was present at `/private/tmp/tapeci-tapekit-compression-20261028` (HEAD
  `37c617e7e332787c8a32a81e4d7d05a28a06c156`), and Anvil was available at
  `/Users/a77/.foundry/bin/anvil`. I ran `tests/fork/compression-measurement.test.ts` with
  `TAPECI_COMPRESSION_MEASURE=1`; it passed 1/1 in 154.8s and wrote
  `/tmp/review-c4-measurement-2026-10-29.json`. The reproduced gas/byte figures match the C4
  report exactly: original 45,477 bytes / 5 tx / 11,331,376 gas; gzip-individual 26,959 / 7 /
  8,103,132; gzip-whole 26,408 / 4 / 6,910,884; gzip-grouped 26,710 / 6 / 7,691,472. The reported
  source block will differ because the fork head moves; the report's `sourceBlock 74405711` is not
  a stable pin, while the source digest and gas figures reproduce. This verifies the local
  benchmark, not a production gateway, mainnet fees or paid-name/Cloudflare behavior.
- **C1/C2 browser/API UI journeys** were not run. I ran the pinned-source overlay test (4/4) and
  the C2 compressed fork test (1/1), but not the C3 live Next/API browser specs or the full
  three-engine Stage B browser matrix.
- **Full C2 fork set**: C2 report claims 3 tests across 2 files; I ran
  `tests/fork/compressed-release.test.ts` (1/1) but not the other fork file or the full
  `tests/fork` suite. I did not treat the full fork suite as green or as a regression.
- **Stage A historical Vite builds** were not rerun; the Stage A report's local build paths are
  not present in this worktree. I did not accept its measured byte tables as independently
  reproduced.
- **Full Stage C1 248-case / C2 256-case / C3 257-case claims** were not reproduced. I ran the
  specific suites reported below; the difference is test-count accounting, not a claim that the
  unrun cases passed.
- **Production/mainnet**: no mainnet write, live gateway installation, real wallet signing,
  Cloudflare/HTTP deployment, independent RPC quorum or device Safari run was performed or can be
  verified here. C4 is a loopback Anvil fork with quorum 1 and a synthetic fixture.
- **Migration 0020 on a persistent environment**: only disposable PostgreSQL tests were used; the
  down migration's data-loss behavior is a source inspection finding, not a production rehearsal.

### Test commands and results actually run

| Command / scope | Result |
|---|---|
| `node /Users/a77/Desktop/tapeout/.corepack/v1/pnpm/9.15.4/bin/pnpm.cjs check` | PASS (lint, root typecheck, web typecheck) |
| `pnpm exec vitest run tests/unit` | PASS: 38 files, 623 tests (run against `34df92b`) |
| `DATABASE_URL=... pnpm exec vitest run tests/p2` | PASS: 51 files, 417 tests (run against `34df92b`) |
| `TAPECI_TAPEKIT_SOURCE=/private/tmp/tapeci-tapekit-compression-20261028 pnpm exec vitest run tests/compression-tapekit/overlay.test.ts` | PASS: 4/4 |
| `TAPECI_COMPRESSION_FORK=1 ... pnpm exec vitest run tests/fork/compressed-release.test.ts` | PASS: 1/1, 88.8s |
| `TAPECI_COMPRESSION_MEASURE=1 ... pnpm exec vitest run tests/fork/compression-measurement.test.ts` | PASS: 1/1, 154.8s; evidence matches report gas/bytes |
| Focused compression unit set (8 files) | PASS: 56/56 |

`tests/compression-tapekit/overlay.test.ts` needs `bun` on `PATH`; I used
`PATH=/Users/a77/.bun/bin:$PATH` and the exact source pin. No test was skipped when run in this
review.

### 5.1 Concurrent fix commit 34df92b

`34df92b` was created at 10:02 during this review, by another actor, and includes this report. It
changes `apps/api/src/worker/runtime.ts:262-274` to a `planningPhase` guard and
`apps/api/src/routes/projects.ts:702-714` to a rollback preflight, with two regression tests and
the `PREPARED_ARTIFACT_UNAVAILABLE` error code. The code is committed now; it is not a stray
working-tree patch.

What it fixes:
- F8/§2.1: a compressed row outside planning can no longer fall through to source preparation
  even when `manifestSha256` is NULL. The allowed source path is only `BUILT`/`VALIDATING`.
- F9/§2.5: a compressed target with a NULL pin now gets a 409 before the rollback deployment is
  created.

What it does not fix:
- F1 digest recomputation, F2 down-migration data loss, F3 raw-key-before-pin, F4 aggregate
  stored-byte cap, F5 dead comparison, F6 compressed missing-archive test, F7 original digest
  mismatch.
- The rollback code still resolves/throws on the raw key before checking the pin; a legacy
  compressed target with `preparation_request = NULL` is still parsed as original and only fails
  later at `deployRollback`.
- The new source-rebuild test constructs an invalid production row (`APPROVED`, pin NULL,
  manifest NULL) and relies on DB edit; it is a good fail-closed test but not a normal lifecycle
  proof.

Verification for the patch: focused `tests/p2/worker/prepared-artifact.test.ts` passed 9/9 and
`pnpm check` passed. I also ran the full p2 suite against this commit (see §5); full unit, C2 fork,
C4 measurement and C3 browser suites were not rerun against `34df92b`. The C2 fork/C4 measurement
code paths are unchanged by 34df92b, but that is an argument, not a fresh run.

### 5.2 Later uncommitted worktree edits (10:07, after 34df92b)

After `34df92b`, the worktree gained further uncommitted edits:
`apps/api/src/worker/prepared-artifact.ts`, `packages/database/migrations/0020_prepared_artifacts.down.sql`
and another test in `tests/p2/worker/prepared-artifact.test.ts` (10 tests now pass in that file).
I inspected them:

- `prepared-artifact.ts:121-151` adds `assertPreparedDigests`, recomputing
  `computeArtifactDigest(rows)` and `deriveReleaseId(commitSha, digest)` for **compressed** snapshots
  at freeze and load. This addresses the `artifactDigest` half of F1 and is a real improvement. It
  deliberately skips original mode (F7) and still does not verify `sourceArtifactDigest` against the
  pack index/context; F1 is therefore improved but not fully closed by this draft.
- `0020_prepared_artifacts.down.sql:1-20` adds a `DO` block that raises if any row has a pin or
  preparation request. That prevents silent data loss but makes the down migration **refuse**
  whenever the feature has been used; it is a safety stop, not a reversible migration, and it can
  block a rollback of an original-mode preparation row too.
- The new digest test uses a deliberately wrong `artifactDigest` on an otherwise valid compressed
  snapshot and expects refusal; that is a valid unit of the new guard. It does not test the
  `sourceArtifactDigest` half.

These edits are not committed in `34df92b` and are not part of the verified PR content. If they
are intended for the PR, commit them and re-run the full suite; do not treat this report's green
`34df92b` as evidence for them.

## 6. Can Stage D safely start?

**Not yet.** Stage D can start only after the minimum fix set below. The local C4 measurement is
adequate as model/fork evidence, but it is not a production qualification and does not repair the
snapshot/migration gaps.

1. Finish the F1 fix in the uncommitted draft: recompute both `artifactDigest` and
   `sourceArtifactDigest` from the frozen manifest/pack-index bytes, verify `releaseId` derives
   from the physical digest, and reject any mismatch at load. (F1)
2. Make the compressed invariant explicit: any compressed request that can reach approval or
   execution must have both `prepared_artifact_key` and `manifestSha256` non-null; enforce it in
   the DB and/or approval transition, not only by the `34df92b` phase guard. (F3/§2.1)
3. Replace the draft down-migration refusal with a genuinely reversible or explicitly
   destructive-operation plan: retain/export pins before dropping columns, and test the behavior
   with a pinned row. (F2)
4. Finish rollback preflight in `POST /v1/projects/:id/rollback`: keep the 409 for a missing pin,
   but do not resolve/throw on the raw key before checking the pin, and cover the legacy
   `preparation_request = NULL` compressed target. (F3/§2.5)
5. Add the aggregate stored-object cap and a stream chunk-before-allocation check; add the
   compressed missing/corrupt archive tests. (F4/F6)
6. Wire `compareReleaseCosts` into an actual review path or remove the delivered comparison claim
   from C2; do not build Stage D cost UI on dead code. (F5)
7. Keep automatic selection original until production-compatible quotes, gateway installation and
   independent-operator checks exist; C4's exact local numbers do not change that gate.

**Bottom line.** The feature's normal C1/C2/C3 path is coherent enough to build on after fixes 1–3;
the current code is not safe to treat as a hard "never recompress / exact digest" guarantee.
