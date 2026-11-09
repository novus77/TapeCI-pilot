# Compression TapeKit Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task with test-driven-development and independent final review.

**Goal:** Prepare immutable compressed physical releases and integrate their verified reads with a pinned TapeKit gateway source copy.
**Architecture:** A small chain-verifiable index.html descriptor commits to an immutable pack index; the existing physical Manifest commits to descriptor/index/objects. An openPackedSite wrapper reads through the original same-snapshot TapeKit site handle, strictly verifies descriptor/index/object bytes, then returns logical files to the unchanged gateway response/CSP/purity path. A deterministic source overlay targets an exact official commit; no live installation or writes.
**Tech Stack:** Existing TypeScript, native Web APIs, Node tools, Bun browser bundling, Vitest, Playwright, pinned TapeKit source.
**Spec:** compression-development-spec.md and this C1 addendum.

## Global constraints

- Work on compression-release; preserve unrelated working changes; no commits/pushes/deployments/mainnet writes.
- Official source pin: 37c617e7e332787c8a32a81e4d7d05a28a06c156. Overlay refuses mismatched source files and existing output.
- Keep ordinary sites, reserved gateway paths, client/server distinction, CSP, upstream RPC/pin verification and decoded purity checks.
- Source authenticity: original TapeKit verified descriptor -> exact index hash -> verified stored object -> exact decoded file hash. No no-hash fallback for compressed content.
- index.html descriptor <=24,000 bytes, pack index <=4 MiB, existing file/object/decoded bounds retained.

## Review focus

- Never let the physical site's fallback satisfy missing immutable index/object requests.
- Require exact returned physical path, status ok, verified true, size and SHA; compute bytes hash independently.
- Separate source artifact digest from physical release digest used by existing planner/journal.
- A changed entry activates an entirely new same-snapshot wrapper; do not cache packs across site handles.
- Logical decoded HTML/CSS still flows through upstream purity scans and response headers.

## Contract and decisions

Descriptor format is exact ASCII HTML prefix plus one canonical JSON object and a fixed explanatory fallback page, schema tapeci.pack-entry.v1. Fields: schemaVersion, indexPath=tapeci-packs/<index-sha>.json, indexSha256, indexBytes, spaFallback. indexBytes is 1..4 MiB. Detection only recognizes the exact prefix; a recognized malformed descriptor fails closed. Physical switch path is index.html; C1 requires logical entryPath index.html. Other source entry modes remain supported by the original publisher, not silently transformed.

prepareCompressedRelease accepts a verified candidate and original release context, returns exact physical files, Manifest v1, manifest hash, entry bytes, release ID, sourceArtifactDigest and physical artifactDigest. Physical digest determines release ID together with commit; physical artifactDigest is computed from physical rows, matching existing planRelease. No new fields are added to Manifest v1. Reserved source sw.js/.tape/ paths are rejected for compressed qualification. All candidate bytes/index/id must verify first; no post-approval packing.

openPackedSite wraps one upstream site handle containing manifest.pathSet, get and other original fields. Ordinary sites pass through unchanged. Recognized packed sites require the original descriptor/index/object get to return an exact physical path in pathSet with status ok, verified true, matching size/hash. Missing declared physical paths must never resolve the upstream fallback. Returned logical file has ordinary file fields and additional transitive compression proof; upstream gateway CSP and decoded HTML/CSS scanning remain in use. get accepts optional {navigation,accept} context for signed opt-in extensionless SPA fallback.

Overlay writes a separate output tree from tracked pinned source files, includes the upstream license, bundles the browser-safe adapter, and changes only sw-gateway/sw.js, worker.js, serve.js, build.mjs, dev-server.mjs. It preserves existing reserved path dispatch and adds reserved /.tape/compression.js. Both client and server openSite calls are wrapped. Status file records include compression proof. PackIntegrityError receives a fail-closed 502 rather than application bytes. Original RPC errors and ordinary behavior remain unchanged as far as possible. No upstream fork/PR or deployed gateway is modified.

## Tasks

- [x] 1. Descriptor/parser + TapeKit site wrapper. RED tests: ordinary pass-through, valid packed reads, no-hash/incorrect path/missing object rejection, corrupt bytes, decoded proof and request-aware fallback. Implement browser-safe adapter.
- [x] 2. Physical release preparation. RED tests: exact Manifest bytes/digest, deterministic output, immutable cross-release paths, descriptor cap, stale candidate rejection and original release compatibility. No API worker enablement.
- [x] 3. Pinned source overlay and real-source tests. Build actual gateway source copy; test original fileResponse/CSP/GATEWAY_PATHS and installed wrapper path using source modules. Fixture site data is local, not live RPC evidence. Exercise client/browser wrapper with actual upstream response/purity modules and same logical app resources.
- [x] 4. Related tests, canonical checks, independent review, reproducible evidence and update remaining production gates.

## Completion boundary

This milestone can prove source integration, immutable preparation and local file trust chaining. It cannot prove live gateway deployment, independent production RPC outcomes, transaction fees, fork upload recovery or mainnet compression. Production automatic selection stays disabled until those gates pass.

Ruling: derive the compressed release ID from final physical artifact digest, not only source digest. The descriptor contains no release ID, so there is no cycle. Codec/fallback variations must have distinct release identities; sourceArtifactDigest remains separate.

## Outcome

Completed local C1 scope: descriptor + wrapper + physical preparation + pinned-source overlay. 248 focused cases and 21 real browser journeys passed; canonical check passed. Independent review findings were fixed and rechecked. Physical study: 362,383 source bytes -> 110,326 physical file bytes, including a 435-byte descriptor. No live gateway, RPC attestation, production worker enablement or fee/fork/mainnet claim. See docs/research/compression/stage-c1-2026-10-28.md.
