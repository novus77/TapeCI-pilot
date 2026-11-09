# TapeCI Compression Development Specification

Date: 2026-10-28. Branch: compression-release. Authoring language: English. This is the detailed execution specification accompanying compressed-release-design.md. User has authorized documentation and implementation. Stage A is implemented first; later production gates remain mandatory.

## 1. Product goal

Reduce static artifact publication cost while retaining application files, routes, approvals, verification, retry and rollback. Compression applies after build and source validation, before final bytes, quote and approval. Never recompress approved bytes. SSR, APIs and databases remain external runtime requirements.

## 2. Milestone boundaries

A: reusable offline analyzer, actual candidate objects and index, verified decode, previous-analysis comparison, CLI, tests and local evidence. B: browser and gateway loading feasibility. C: prepared-release/approval integration and fork verification. D: feature-gated product UI and codec tuning. A does not mean B/C/D are complete. There are no mainnet writes, paid Actions runs, DNS changes or automatic publication in this implementation.

## 3. Existing behavior retained

Existing original-file preparation, Manifest v1 and deployment execution remain unchanged. Production compressed mode is not enabled by merely installing the analyzer. Preserve every scanned source file, including empty, dynamically loaded and already compressed resources. No lossy transforms, unreferenced-file deletion or user-wallet key handling.

## 4. Package and interfaces

Create packages/compression with src/types.ts, src/analyze.ts, src/decode.ts, src/storage.ts, src/input.ts, src/cli.ts and src/index.ts. Dependencies: existing @tapeci/shared and @tapeci/validator, Node built-ins; no new third-party runtime dependency. Export analyzeCompression(files, options), decodeCandidate(index, objectBytes), writeAnalysis(directory, analysis), parsePreviousAnalysis(unknown) and related types. CLI runs with tsx directly. Filesystem source scanning uses the existing validator.

Options: entryPath defaults index.html; previous is a validated previous-analysis projection. Source bounds: 4,096 files and 64 MiB total decoded data; per-file and per-stored-object maximum is TapeOut MAX_FILE_BYTES (8,400,000). These are initial local analysis policy limits, not claims about browser memory safety. All typed source files must be canonical, hashes/sizes correct and unique; validate at this API boundary because independent callers can supply them.

## 5. Candidate strategies

Generate original, gzip-individual, gzip-whole and gzip-grouped in fixed order. Original stores each file unchanged. gzip-individual encodes each file independently. Whole encodes concatenated source bytes. Grouped uses shell (.html/.css), scripts (.js/.mjs), other (everything else), each in UTF-8 source-path order; group order is UTF-8. Policy identifier: type-groups-v1. This is coarse grouping, not dependency analysis.

For a compressed unit whose gzip bytes are not smaller, store the uncompressed concatenated bytes with explicit identity encoding. No content mutation occurs. If any stored object exceeds 8,400,000 bytes, mark that entire candidate unavailable with a reason and do not emit it as deployable. Do not silently omit files. The original valid candidate remains available.

## 6. Pack index contract

schemaVersion: tapeci.pack-index.v1; explicitly experimental and not a new release Manifest version. Fields: strategy, sourceArtifactDigest, entryPath, groupingPolicy, encoder {name, node, zlib, level}, files[], objects[]. No incidental timestamps. Original encoder name identity with level 0; gzip candidates use gzip with level 9. Runtime versions pin local reproducibility, not cross-version guarantees.

Each object: path objects/<64 lowercase sha256 hex>.<gz|bin>, sha256 as 0x-prefixed 32-byte hash, encoding gzip|identity, storedBytes, decodedBytes. Hash stored bytes. Multiple equal units share one object row and one physical binary. gzip suffix is used only for actual gzip objects.

Each file: path, contentType, size, sha256, objectPath, offset. Offset indexes the decoded concatenation. No internal tar/ZIP header is used: the complete external index provides boundaries and MIME. Groups concatenate files in sorted path order. Empty files are retained even when their intervals have zero length.

Serialize with shared canonicalJson and UTF-8. candidateId = sha256(indexBytes), so identity commits to all mapping, metadata and stored bytes transitively. No candidate ID is embedded inside its own index. SourceArtifactDigest commits to sorted {path,size,sha256}, separate from encoded-object identity. Source hashes stay unchanged by compression.

## 7. Analysis report contract

schemaVersion tapeci.compression-analysis.v1; source digest/file count/byte count; candidate summaries with strategy, available/reason, candidateId, storedBytes, indexBytes, analysisBytes (stored+index), payloadChunks, changedObjectBytes and reusedObjectBytes. Payload chunks use max(1,ceil(storedBytes/24000)) per physical object, excluding index and loader transactions. Change metrics compare object path/hash/size against the same strategy in a previous analysis, and default to all changed without history.

The library records strictOnChain=null without an explicit scanner context; the CLI records its actual scan policy. Report must always include compatibility='unverified', estimatedFeeWei=null and productionTotalBytes=null. Loader overhead and gateway operations are unknown. Byte/chunk results must never be titled gas savings, total transactions or production quote. Previous-analysis reuse is hypothetical local byte reuse, not evidence of current on-chain contents. A later publisher must query and verify chain state.

## 8. Decode and integrity boundary

Decode accepts an unknown index, validates its schema/strategy, canonical paths, hashes, positive limits, encodings, object path/hash consistency, unique file/object paths, entry existence and file-to-object mapping. Reject unsupported schema and unknown encodings. Validate the index once before typed decode work.

Verify stored size/hash before decompression. Use bounded zlib output and total/file count limits. Verify decoded size, complete contiguous coverage for each object's files (independently hash-verified aliases may overlap; empty intervals allowed), each file size/hash and source artifact digest before returning files. Missing/extra object input, trailing unmapped decoded bytes, traversal and corrupted payloads fail closed. API returns bytes only; it never extracts to filesystem or executes application scripts.

## 9. Persistence and CLI

writeAnalysis creates a new directory and fails if it already exists; no overwrite behavior. Per available candidate write <strategy>/index.json and <strategy>/objects/<hash>.<ext>; report.json at root. Persist actual bytes, not only statistics. Never persist input credentials. Failed writes may leave an incomplete directory; report.json is written last and serves as the completion marker. Retrying uses a new directory.

CLI: --input DIR --output NEW_DIR [--previous REPORT_JSON] [--entry PATH] [--allow-external]. Flags are unique and unknown/missing values fail. Strict on-chain source scanning is default; allow-external explicitly relaxes external-reference policy and the report records that choice. Metadata preflight enforces source count/byte limits before reading file bytes; the source directory must remain immutable during the analysis. Source/output must not contain one another, including realpath-resolved symlink ancestors. Previous JSON parses only the report projection required for comparison and rejects malformed entries. CLI exits nonzero with a concise error and creates no misleading success report when validation fails.

## 10. Stage A acceptance tests

Actual gzip roundtrip and object/index integrity; stable outputs across reordered files; empty files; duplicate/noncanonical paths; bad input hash; unsupported schema/encoding; corrupted/missing/unexpected objects; output bounds; out-of-range/unmapped file data; incompressible identity fallback; coarse-group incremental reuse; byte-identical object deduplication; oversized candidate rejection; real filesystem CLI persistence/no overwrite/source-output isolation and previous-analysis handling. No mocks of codec or filesystem.

## 11. Benchmark evidence

Run on a real local Vite build, plus self-contained static and media-heavy fixtures. Include two genuine distinct-commit builds when available; otherwise explicitly leave that acceptance item open. Record source provenance/digests, command, runtime, decoded equality, size and change metrics. Do not promote the synthetic CSS test to real-build evidence.

## 12. Stage B loading gate

Inspect the actual TapeKit runtime to determine native Content-Encoding response support and Service Worker scope ownership. A website merely accepting .gz uploads proves neither. Qualify route behavior and response verification first. Browser loader experiments use an isolated origin and do not register workers on live user sites. Test dynamic imports, CSS URLs/fonts, fetch, nested routes and refresh, Worker/WASM where applicable, CSP and cache updates. Chromium/Firefox/WebKit results are distinct from physical Safari/device verification.

## 13. Stage C integration

Add a separate compressed preparation path; do not mutate original prepareVersionedRelease. Prefer physical Manifest v1 containing objects/index/loader/entry, with pack index transitively committed by manifest hash. If v1 cannot represent all semantics, review an explicit v2 migration. Persist selected strategy, original digest, immutable candidate storage key, index hash and final manifest before approval. New strategy/bytes require new approval. Verify all dependencies before the <=24,000-byte entry switch. Existing container lock, RPC disagreement and budget blockers remain active.

## 14. Resume, rollback and data retention

Compare actual chain contents before reusing objects. Preserve old release indices/objects/loaders; do not implement GC in this milestone. Resume only missing/unverified writes. Root-mode deployments remain supported separately; they do not gain atomic rollback automatically. Fork evidence precedes any explicit, budgeted mainnet test.

## 15. Cost selection and product UI

Only qualified candidates enter automatic selection. Compare complete physical plans within the same quote context, including loader, index, decoder, writes and any service fees. Unknown cost means original mode. Automatic compression requires a strictly cheaper complete quote. Existing projects retain original default. Display selected strategy, size, uploaded/reused objects, transaction estimate, fee ceiling and compatibility reasons within existing plan review.

## 16. Development and review

Implement tests before behavior. Run focused tests from packages/compression using root Vitest configuration; repository .opencode/skills does not exist, so use existing Vitest conventions. Run bun run check as canonical lint/type verification and report environment/baseline failures. Preserve unrelated working changes; no automatic commit/push. Final review uses a fresh reviewer agent for new compression files and documentation; review does not authorize external operations.

## 17. Completion reporting

Separate implemented analyzer, real local evidence, loading feasibility, fork/production evidence and deferred work. Never say compression is production-ready based only on Node decompression. Handoff includes reproducible commands, touched files, dependency changes, test outcomes, remaining gates and user-visible limitations.

## Stage B implementation addendum (2026-10-28)

Selected route: explicit browser/gateway pack-resolver hook, exercised on a fresh loopback origin. See the separate compression-browser implementation plan and Stage B evidence for qualification. No transparent native gzip support is assumed. Browser index validation is shared with Node. Expected index hash comes from a trusted caller, not the fetched index. A 4 MiB index transport limit applies to the prototype. Native gzip absence is unsupported. The local preview uses a root worker only on its newly allocated local origin so original root-relative application paths remain unchanged; it never replaces a live TapeKit worker. Actual TapeKit routing, policy and pinned-chain integration remain open gates.

## Stage C1 implementation addendum (2026-10-28)

The supported physical mode uses a verified index.html descriptor -> content-addressed pack index -> stored objects -> logical source files. prepareCompressedRelease retains Manifest v1 and emits separate sourceArtifactDigest/artifactDigest; the latter covers all physical bytes and derives the release ID. A pinned source overlay connects both TapeKit gateway modes, preserves native directory/MIME/RPC handling, and keeps actual deployment disabled. See compression-tapekit implementation plan and C1 evidence. get is virtualized; other physical site APIs retain physical semantics. Live deployment, fees, API approval persistence and fork upload/rollback remain open.

## Stage C2 implementation addendum (2026-10-28)

Worker preparation now pins a deterministic physical artifact snapshot before approval.
Nullable preparation_request/prepared_artifact_key columns are carried through recovery
and rollback. A pinned load validates exact context, manifest and bytes and never reads the
source tar; a compressed record outside the planning phase (`BUILT`/`VALIDATING`) refuses to
prepare from source at all, and rollback refuses (409) a compressed release with no pin rather
than answering 202. A pin-only row loads without a raw artifact key, because the snapshot is
self-contained and content-addressed. `sourceArtifactDigest` is **not** recomputed at load: it
is anchored when the pack index is decoded and cannot change afterwards; a compressed snapshot
will not freeze without one. Original mode remains default; compressed requests require
operator runtime qualification, with no public toggle and no nonzero service fees yet.

Same-snapshot plan comparison exists as a **library only**: `compareReleaseCosts` is implemented
and unit-tested but has **no production caller**, so no API, worker or console path performs it.
Its results are model estimates and automatic selection stays `original`. Do not read this
addendum as "complete comparison is delivered".

Disposable PostgreSQL tests and isolated Anvil fork publication/resume/cutover/rollback passed;
production gateway qualification, production fee simulation, persistent-environment migration and
public review controls remain open. Migration `0020` is deliberately a **blocking** down
migration: it refuses to run while any deployment still carries a pin or a preparation request,
because dropping those columns would make compressed releases unrestorable. See the Stage C2
report for exact evidence and broad-suite limitations.

## Stage C3 implementation addendum (2026-10-28)

Explicit strategy selection and a localized review panel now exist on deployment
Overview. GET/POST deployment preparation routes expose recorded snapshot identity and
create an idempotent independent BUILT attempt, respectively. New attempts require
maintainer/owner, nonarchived/current target, a preapproval nonrollback source and retained
raw bytes. They copy no approval, pin, plan or journal. Matching retries recover the
same ID even when source eligibility changes; current target/project/gateway and usable
bytes still gate enqueue. Shared opt-in operator configuration supplies matching zero-fee
gateway choices, defaulting to none. Recorded gateways removed from the current options
are not submitted by the form. The current plan remains available and new selection
requires separate review/signature. Production compatibility and transaction simulation
are still gates; no automatic strategy selection is enabled. See the C3 report for real
local API/database/browser scope and exact verification limitations.

## Stage C4 implementation addendum (2026-10-28)

An explicit local-fork benchmark now restores one exact baseline before each of four
strategy publications, accounts complete successful receipts and separates mined fees
from measured gas at a common quote price. The actual pinned TapeKit chain kernel reads
published contract bytes; the built adapter and native response function are checked for
physical/logical byte equality, expected MIME/hash and security/cache headers. Direct
fixture-container/quorum1 Node response checks are not paid-name, deployed HTTP/Cloudflare,
independent-operator or mainnet qualification. Real-build incremental analysis and full
production fee coverage remain gates; automatic selection stays original. See the C4
report for actual measurements and verification limitations.

## Stage D implementation addendum (2026-10-29)

`selectReleaseStrategy` implements §15 as an explicit, tested rule rather than a hardcoded
default: no qualified gateway -> `gateway-not-qualified`; unknown cost -> `cost-unknown` (never
treated as free); no production-compatible simulation -> `production-simulation-required`; no
comparison or not strictly cheaper -> `not-strictly-cheaper`; strictly cheaper with every gate
passed -> `strictly-cheaper`. Equality is not a saving.

**Automatic selection remains `original` in production** because no production-compatible
simulation and no qualified gateway exist. The rule exists so the reason is computed, reviewable
and testable; it is not enabled. The console still requires an explicit strategy choice.

`GET /v1/deployments/:id/preparation` now returns the recorded plan's own cost lines — physical
files, writes, reused files, planned bytes and chunks, estimated network cost, fee ceiling and
budget status — plus the automatic-selection verdict and reason. When no plan exists the cost is
`null` and the panel says it is unknown rather than implying it is free. These are measurements
of the plan the worker produced, not a fresh estimate.

Not delivered: a production-compatible cross-strategy quote (the endpoint reports one plan, and
`compareReleaseCosts` still has no production caller), Cloudflare/gateway qualification, mainnet
fee accounting, and any automatic selection.
