# Approved Prepared Artifacts Implementation Plan (C2)

> **For agentic workers:** REQUIRED SUB-SKILL: executing-plans, test-driven-development, independent requesting-code-review.

**Goal:** Persist final release bytes before approval and reuse them across plan/deploy/verify/reapproval/rollback, compare complete same-snapshot physical plans, and run isolated fork upload/resume/cutover/rollback tests.
**Architecture:** A content-addressed deterministic prepared tar contains metadata plus numbered binary file payloads. A deployment references its immutable key; stored manifest/context/digests are verified on every load. Original mode remains default; explicit compressed requests require a trusted runtime target-gateway qualification. Existing plan/cap/journal logic remains in charge. Comparison is labeled the existing gas-model estimate, not simulated production pricing; no automatic compression selection is enabled.
**Tech Stack:** Existing tar/ObjectStore/ingest validator, Drizzle/PostgreSQL, TypeScript, Vitest, Anvil fork.
**Spec:** compression-development-spec.md plus this C2 contract.

## Constraints and contracts

- New deployment columns: preparation_request jsonb nullable, prepared_artifact_key text nullable. All old records default null and remain readable.
- PreparationRequest schema tapeci.preparation.v1, mode original|gzip-individual|gzip-whole|gzip-grouped, spaFallback boolean, gatewayId required for gzip. No public API compression toggle this milestone.
- Trusted gateway profiles are supplied to createWorkerRuntime by the operator, not request data: id/origin/chainId/registry/container/adapter hash/service fee. Default none; no production gateway is implicitly qualified. Validate target match and origin, fail closed when compressed request lacks qualification. Recheck on resume so removal revokes execution eligibility.
- Snapshot context: project/repository/commit/chain/registry/container + raw source archive key/hash + normalized preparation request and selected gateway profile metadata. No deployment ID, allowing an identical reapproval continuation to adopt it.
- Schema tapeci.prepared-artifact.v1: context, manifest, original artifactDigest, sourceArtifactDigest where applicable and preparation metadata. Metadata <=4 MiB; payload uses manifest target-path sort order and fixed files/<zero-padded-index>.bin names. A fixed inert index.html exists only for safe archive ingestion. No source-file path is extracted directly from metadata.
- Archive uses portable deterministic tar with no timestamps. Existing sha256/<hash>.tar ObjectStore contract retained. Snapshot hash must match its key, strict manifest/hash/row byte coverage and expected context. No recompression on load; corrupted/missing snapshot fails, never falls back to source.
- Save snapshot to ObjectStore before CAS-binding its key to deployment. Concurrent preparation must reproduce the same key; existing key wins only after equality/manifest checks. Snapshot pin exists before PLAN_READY/approval. Legacy records without a pin can recreate original artifacts only; legacy compressed requests with an existing approval/manifest and no pin fail.
- Reapproval and rollback copy prepared artifact key/request from source deployment; no renewed build or compression required. Installation/authorization checks still run before reading frozen bytes.
- Existing PreparedRelease shape reconstructed from frozen bytes; references/entryHtml are derived, not independent stored facts. Final bytes remain owned by the snapshot reader.
- Cost comparison only accepts plans with identical chain, registry, container, pinned block/hash, operators and gas price. Add explicit nonnegative service fees; reject blocked plans and mismatched contexts. Report model-estimate, physical writes/reuse/bytes/chunks and total fees. Automatic selection stays original pending actual simulation and qualified production target.
- No mainnet writes, production migration execution, paid CI, commits or pushes. Tests create disposable databases and independent Anvil forks only.

## Review focus

- Corruption/missing frozen data must not cause a rebuild after approval.
- Changing source key, target, commit or preparation request must invalidate the snapshot.
- Recovery/rollback must retain the exact pin while preserving their original journal semantics.
- Archive numbering must not permit missing/extra/duplicate payloads or path extraction outside workspace.
- Quote comparisons must never mix prices or states, or hide service fees/model limitations.

## Tasks

- [x] 1. RED snapshot codec/storage tests; implement deterministic tar and strict context/byte validation.
- [x] 2. Migration/schema + worker pin/load integration; disposable PostgreSQL tests prove no rebuild after source removal, stale/tampered context rejection and gateway qualification.
- [x] 3. Copy pins through continuation/rollback; regression tests using actual database/recovery flow.
- [x] 4. RED complete plan comparison tests, implement and verify explicit estimates and fees.
- [x] 5. Isolated fork compressed physical assets, repeat/resume, atomic entry switch, second release and rollback; record actual local receipts/fees with no mainnet claim.
- [x] 6. Related suites, canonical check, independent review and durable evidence/remaining gates.

## Validation and handoff

Implemented and reviewed in isolated checkout `/private/tmp/tapeci-compression-worktree-20261028`, branch `compression-release`, after concurrent branch changes in the original checkout. Original checkout remains untouched by the isolation step.

Final verification: 256 focused tests, 17 PostgreSQL tests and 3 isolated fork tests passed; `bun run check` passed. Broad unit/ops: 594 passed, 12 existing cwd-dependent path failures; not a clean full suite. Independent final review found no remaining material issues. Deterministic tar file modes are explicitly 0644 and tested under umask 077/022. JSON array modes fail strict parsing. Nonzero gateway service fees remain blocked pending separate approval support.

Durable evidence and remaining gates: `docs/research/compression/stage-c2-2026-10-28.md` and adjacent fork JSON. Production migrations, actual gateway qualification, public UI selection and production fee simulations remain open. No external publication or mainnet writes performed.
