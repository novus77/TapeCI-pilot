# Compression Analyzer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver Stage A's offline deterministic compression analyzer, persisted candidates, CLI and evidence.
**Architecture:** Scan source bytes, generate four independent candidate layouts, validate/decode each, then persist final bytes and an explicit non-production analysis report. Production preparation and worker code remain unchanged.
**Tech Stack:** Existing TypeScript, Node zlib, pnpm, Vitest, tsx, shared canonicalization/hash and validator.
**Spec:** docs/superpowers/specs/2026-10-28-compression-development-spec.md

## Global Constraints

- 4,096 files, 64 MiB decoded total, 8,400,000 bytes per source file/stored object.
- Original, gzip-individual, gzip-whole, gzip-grouped; gzip level 9; identity fallback.
- No production fee/compatibility claims, no writes to mainnet/Actions/DNS.
- No unrelated edits, dependency upgrades, commits or pushes.

## Review Focus

- Empty/identical resources must remain addressable and deduplicated.
- Untrusted index ranges and decompression bounds must reject corrupt content.
- Real filesystem output must never overwrite a prior report or contaminate source.
- Historical reports must not be accepted as verified chain state.
- Reordered files must not change immutable candidate identity.

### Task 1: Candidate encoder and typed contract

Files: packages/compression/package.json, src/types.ts, src/analyze.ts, src/index.ts; tests/unit/compression.test.ts.
Interfaces: analyzeCompression(files: readonly ScannedFile[], options?: AnalyzeOptions): CompressionAnalysis. Analysis carries report and available candidates with canonical index bytes and stored objects.

- [x] Write tests for real codec bytes, source preservation, stable candidate IDs, identity fallback, duplicate/invalid inputs, object dedup and group update reuse.
- [x] Run tests from packages/compression: ../../node_modules/.bin/vitest run --root ../.. tests/unit/compression.test.ts; observe missing implementation failure.
- [x] Implement types and encoder using built-in zlib, content hashes and stable grouping.
- [x] Run focused tests; PASS with no network.

### Task 2: Verified decode

Files: src/decode.ts; tests/unit/compression.test.ts.
Interface: decodeCandidate(index: unknown, objectBytes: ReadonlyMap<string, Uint8Array>): ScannedFile[].

- [x] Add tests for roundtrip, missing/corrupt/extra objects, invalid metadata/ranges, unsupported format and bounded output.
- [x] Observe RED, implement boundary parsing and integrity verification, then GREEN.
- [x] Run all compression tests.

### Task 3: Persistence and CLI

Files: src/storage.ts, src/cli.ts; tests/unit/compression-cli.test.ts; pnpm-lock.yaml only for new workspace importer if necessary.
Interfaces: writeAnalysis(directory: string, analysis: CompressionAnalysis): Promise<void>; parsePreviousAnalysis(input: unknown): PreviousAnalysis. CLI flags defined by spec section 9.

- [x] Write actual filesystem and subprocess tests for fresh output, index/object decode, no overwrite, invalid previous input and unsafe directory nesting.
- [x] Observe RED, implement storage/CLI without overwriting input or existing directories, then GREEN.
- [x] Register only the new workspace importer with existing versions; do not upgrade dependencies.

### Task 4: Evidence, checks and review

Files: docs/research/compression/stage-a-2026-10-28.md and small evidence JSON where useful.

- [x] Run real local Vite/static/media analyses and record exact commands and limitations.
- [x] Check availability of two real commit builds and TapeKit runtime source; record any unfulfilled gate honestly.
- [x] Run focused tests and offline regression suite from package directory, then bun run check at repository root.
- [x] Have a fresh agent review only this feature, fix actionable issues with regression tests, and record outcomes.
- [x] Update plan checkboxes/evidence and provide handoff without committing/pushing.

## Execution rulings and status

User explicitly authorized both documentation and implementation in this turn; executed inline on the requested existing branch without a further approval pause. No commits/pushes performed. Added input.ts for bounded source metadata preflight after independent review. Default library scan policy is unknown/null without explicit scan context. Physical aliases may overlap when every mapped slice hash verifies and all decoded bytes are covered. Task 4 validation ran, but the broad pre-existing unit/ops suite is not fully green under package cwd; exact failures and remaining production gates are recorded in the evidence report.
