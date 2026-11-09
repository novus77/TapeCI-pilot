# Compression Browser Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Verify Stage B browser loading with an integrity-checked pack resolver and an isolated gateway-adapter prototype.
**Architecture:** Share pack-index boundary validation between Node and browser. A Web API resolver verifies an explicitly pinned index, lazily decodes bounded gzip/identity objects and serves logical files at original URLs. A loopback-only preview worker on its own fresh loopback origin demonstrates the adapter integration point; it never replaces a live TapeKit worker.
**Tech Stack:** Existing TypeScript/Node, native Web Crypto/DecompressionStream, Bun CLI for browser bundle, Playwright.
**Spec:** docs/superpowers/specs/2026-10-28-compression-development-spec.md, Stage B addendum below.

## Global constraints

- Keep Stage A output format and tests compatible. Reuse existing path/schema checks; no server modules in browser bundle.
- Pin expected index hash independently of the fetched index. Signature/chain trust anchoring remains Stage C.
- Respect 4,096 files, 64 MiB decoded data, 8,400,000 stored bytes/object; index transport cap 4 MiB for this prototype.
- Missing native gzip capability fails explicitly; no unmeasured decoder or CDN fallback is added.
- No production gateway registration, mainnet writes, deployment or raw-file fallback on integrity failure.

## Review focus

1. Index authentication must happen before executing any file bytes.
2. A corrupt object/hash/range must fail closed, including after cached concurrent requests.
3. Relative assets, lazy imports and route navigation must retain their original URL semantics.
4. Missing JSON/images/scripts must not receive SPA fallback HTML.
5. Local preview must bind loopback and keep its worker scope isolated.

## Tasks

- [x] Task 1: RED tests for browser resolver integrity, actual gzip/identity decode and bounded output; extract pack-index.ts from existing decode.ts; implement browser.ts with pinned index hash, source digest and lazy per-object verification.
- [x] Task 2: RED tests for gateway GET/HEAD, scope/path handling, missing assets, navigation-only SPA fallback and error propagation; implement gateway.ts and browser-entry.ts.
- [x] Task 3: Add loopback preview server with explicit candidateDir/index hash, compiled local browser module and worker scope / on a fresh loopback origin. Add real browser fixture journeys for CSS/images, dynamic import, fetch, Worker, WASM, deep-route refresh, integrity failures and strict local CSP. Use original URLs without rewriting app code.
- [x] Task 4: Run existing/new unit tests and browser tests, canonical check, independent review and record per-engine evidence plus production limitations.

## Stage B addendum and decisions

The inspected TapeKit source has no pack resolver and owns the root worker. This milestone chooses an explicit gateway resolver hook prototype. It is not a standalone universally deployable bootstrap. The local preview worker only simulates the hook on a fresh loopback origin, on its own fresh loopback origin. Actual TapeKit client/server integration remains an unfulfilled gate and must not be called verified.

The gateway adapter accepts a verified pack runtime, request and explicit scope URL, plus optional SPA fallback. Original file MIME and bytes are served; query strings do not change logical file identity, directory requests resolve index.html. GET/HEAD only. SPA fallback is opt-in, navigation-only, HTML-accepting and extensionless; missing assets retain 404. Invalid paths return 400, out-of-scope URLs 404 and methods 405. Integrity failures throw and the preview returns 502, never original/unverified bytes.

Packed browser loading is qualified only when the index hash is pinned by a trusted caller. The local preview's CLI argument supplies a local pin; it does not claim EIP-712 approval or chain verification. Objects are verified before decompression; bounded stream reads and declared output length limit resource expansion. File metadata, source digest and full per-object mapping coverage are checked before returning bytes. Concurrent requests reuse the same verified object promise.

The preview uses a simple strict local CSP to expose URL-loading problems; it is not a replacement for every TapeKit response-header policy. Browser engines must be listed individually with actual execution results. No hardware Safari claim follows from WebKit automation. Unsupported application capabilities remain unsupported until exercised.

Ruling: preview uses scope / only on a newly allocated loopback origin, because a /site/ prefix would break unchanged applications that use root-relative URLs. All preview transport/boot routes are reserved under /__tapeci_preview/. No existing TapeKit origin or worker is modified.

## Validation outcome

34 compression unit tests and 197 related original tests passed (231 total). Chrome, Firefox and WebKit each passed six real browser journeys (18 total), including the opt-in historical Vite build. Canonical lint/type checks passed. Independent review found an encoded-extension SPA fallback bug; reproduced RED and corrected to GREEN, and reviewer rechecked the fix and retry behavior. Actual TapeKit integration, signing, complete fee plans and mainnet compression remain unverified. See docs/research/compression/stage-b-2026-10-28.md.
