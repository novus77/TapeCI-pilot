# Compressed static releases: implementation design

Status: proposed design, not production capability. Date: 2026-10-28.

## Intent and decisions

Reduce TapeOut deployment costs while preserving the application's behavior and TapeCI approval, verification, resume and rollback guarantees. The user requires existing functionality to remain available. Implement within TapeCI's TypeScript/pnpm workspace; do not replace its publisher with TapePack's deployment service.

Recommended engineering choices, rather than explicit user requirements: start with deterministic gzip, stable groups and immutable content-addressed objects; preserve original publication as the default until compatibility and cost gates pass. Brotli remains an optional comparison candidate. There is no promised fee reduction or mandatory compression percentage.

This document scopes a staged feature. Stage A is the first implementation milestone. Later stages have explicit decision gates; do not build all stages simultaneously.

## Existing integration points

- `packages/github/src/ingest.ts`: extract and scan source artifact bytes.
- `packages/release/src/prepare.ts`: source digest, path remapping, final entry and release Manifest v1.
- `apps/api/src/worker/runtime.ts`, `loadDeploymentArtifact`: ingests then prepares the release, and checks reproduction of a previously persisted manifest hash. Planning and later execution must reproduce the same selected final bytes.
- `packages/deployer/src/plan.ts`: exact path/size/hash comparison skips unchanged files; conflicting immutable paths are rejected.
- `packages/artifact/src/manifest.ts`: Manifest v1 rejects unknown keys. Adding compression attributes directly is incompatible.
- Entry cutover must remain within 24,000 bytes. Existing single-container locking and verification remain mandatory.

## Stage A: offline analyzer and runtime feasibility study

Propose a new `packages/compression` package plus a local analysis command following existing repository conventions. Runtime dependencies must follow the repository's existing package boundaries; no browser dependency on server code.

Input: already scanned canonical artifact files, explicit entry path, grouping/codec settings, and optional previous candidate's complete object index. No RPC, signer, credentials, automatic CI triggers or database required.

Output: a versioned analysis report and immutable local candidate directories containing their actual bytes. Report includes source digest; candidate ID; codec/version/options; group policy version; stored object paths/sizes/hashes; original file paths/MIME/sizes/hashes and membership; index/loader overhead when known; changed object bytes; payload chunks; and explicit unknown fields. Unknown cost or compatibility must never be displayed as zero cost or as supported.

Candidate ID covers all selected final bytes and transformation settings; source digest remains separately identifiable. Hash and persist final object bytes rather than relying on regeneration alone. Determinism requires canonical UTF-8 paths/order, stable serialization and no incidental timestamps. This research prototype's TCP1 format is not an approved production archive specification.

Compare original files, per-file gzip, whole-site gzip and stable grouped gzip. Brotli is an optional offline candidate. Initial groups are shell (HTML/CSS), scripts and other resources, explicitly labeled coarse research grouping. Later dependency-based grouping must have its own policy version. Do not claim coarse groups always improve incremental costs.

Use built-in server codecs initially. Do not install a full archive runtime before choosing a loading route. Compressed payloads that grow should be retained as rejected candidates or represented as identity objects with explicit encoding, never silently mislabeled gzip. Preserve all application files; no heuristic dead-file deletion or lossy media processing.

Benchmark at least a plain static site, a Vite application with lazy imports and relative CSS assets, and a media-heavy site. Include two real builds from distinct commits for one application; the prior synthetic CSS edit is insufficient. Record provenance and hashes; local fixtures may supply the builds, without spending GitHub Actions minutes.

In parallel with measurement, inspect the actual TapeKit gateway/runtime implementation and record whether content encoding is supported, whether a service worker owns the scope, and what response/routing controls are available. No DNS changes or production service worker installation. A browser POC runs in an isolated local origin with explicit labeling.

Stage A acceptance: reproducible output; decoded archives reproduce every source file byte-for-byte; a changed file invalidates the relevant object/index; actual rebuild comparison is recorded; reports distinguish payload size from final publication cost; and a feasibility decision chooses a supported loading route or blocks compression. No production worker behavior changes in Stage A.

## Stage B: one supported browser loading route

Choose only after Stage A evidence:

1. Gateway/native response decoding, if the actual platform supports the required encoding metadata and retains verification guarantees.
2. A controlled browser loader, if URL mapping and lifecycle can be made compatible with TapeKit.
3. If neither works without losing application functionality, keep original publication and report unsupported compression. Do not invent a universal loader promise.

The loader needs exact route-to-file mapping, MIME preservation, compressed-object and decoded-file verification before execution, per-format capability checks, an included and measured decoder fallback if used, and bounded decoded sizes/file counts. A missing integrity check cannot be treated as an acceptable compatibility fallback.

Initially qualify only tested static/application fixtures. Test relative paths, lazy imports, CSS url/font loading, fetch, worker/WASM where used, refresh on deep routes, CSP, offline cache lifecycle and rollback. Unsupported projects stay on the original publishing mode. Format detection alone cannot establish arbitrary app compatibility. Do not register a competing service worker or assume Blob URLs preserve module semantics.

Browser matrix: Chromium, Firefox and WebKit automation locally; record real Safari/device support as unverified until exercised. Verify against the actual TapeKit gateway via an approved non-production test publication when available. Local emulation alone cannot qualify the gateway route.

## Stage C: production plan, approval and recovery

Keep release Manifest v1 as the exact physical upload manifest if possible: it lists compressed objects, immutable index/loader files and the small final entry. Use a separately versioned, strictly validated pack index describing logical source files and their object mappings. Its hash is transitively committed by the physical Manifest. This avoids adding unsupported keys to v1. If this representation cannot satisfy current path mapping and approval semantics, design and review an explicit v2 migration before implementation, rather than extending v1 permissively.

Add a distinct compressed-release preparation function alongside `prepareVersionedRelease`; do not pass compressed objects through the existing entry-rewrite logic as if they were source files. Persist selected mode, settings, prepared artifact storage key, source digest, candidate/pack index identity and final manifest hash before approval. Planning, retry and execution load the same immutable final bytes and validate them. A strategy or byte change invalidates the plan and requires a new approval; it cannot reuse the previous signature.

Objects use a reserved namespace such as `objects/<sha256>.gz` or an explicitly encoded identity equivalent, with hash of stored bytes. Identical object paths are reusable only after on-chain verification; a conflicting path blocks publication. Each release has a complete immutable index rather than a dependency chain of historic patches. Reserve/control namespaces to prevent collision with user files.

Upload and verify all dependencies before switching the entry. Retain old referenced objects, index and loader to support rollback. Existing root-mode releases do not gain safe atomic rollback merely by enabling compression: compressed mode must use the new immutable strategy; old root behavior remains supported separately. No garbage collector in this milestone.

Quote complete physical plans with current fee estimation/simulation. Include entry, loader, fallback decoder, index, object metadata, bytes, transaction operations, already verified objects and any service charge. Offline chunk counts are not transaction counts or gas quotes. Show a pinned quote context and its validity rules, using existing reapproval/budget controls.

Cost selection applies only to compatible candidates. Auto mode can choose compression only if its complete estimated publication cost is strictly lower than original with the same quote context. If a full quote or runtime qualification is unavailable, remain original. Expected future updates are useful comparison information, not a hidden speculative charge in this rule.

## Stage D: product surface and optimization

After production gates pass, expose original/automatic/explicit supported compressed modes. Default existing projects to original. Plan review shows original/final size, selected strategy, uploaded/reused objects, transaction estimate, fee cap and compatibility result with reasons. Do not add a required new page to the user's normal deployment flow.

Then measure Brotli, Zopfli, finer grouping and cached encoding. Cache keys cover content, codec/options/tool version and grouping policy. Never run expensive recompression on every unrelated commit. No binary patch chains in the first release.

## Tests and evidence

Actual codec roundtrips and final bytes; deterministic same-input output; real successive builds; incompressible resources; malformed paths/index/limits; unknown format rejection; corrupted stored object and decoded file rejection; small entry limit; existing uncompressed release regression; same-object reuse; interrupted uploads/resume; stale approval rejection; rollback to retained dependencies; full browser fixture journeys.

Use package/repository test conventions and applicable instructions. Do not write tests duplicating the implementation. No new mainnet transactions are authorized by this design. Production write tests require an explicit target and fee authorization. Record local, fork, browser, gateway and mainnet evidence separately.

## Completion boundaries

Stage A delivers an analyzer, byte evidence and a loading-route decision. It is not a production compression launch. Stage B establishes functional feasibility. Stage C establishes secure publication and recovery. Stage D enables the user experience. Failure at a gate preserves existing publication; report the blocker and evidence rather than dropping application functionality.
