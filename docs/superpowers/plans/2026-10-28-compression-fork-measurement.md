# Same-State Compression Fork Measurement Plan (C4)

> **For agentic workers:** Use executing-plans, test-driven-development and one independent final review.

**Goal:** Measure original and all gzip strategies from an identical local chain baseline, and read the actual published bytes through pinned TapeKit chain-reader/adapter/response modules.
**Architecture:** A standalone opt-in local benchmark starts its own Anvil fork, opens one fixture container, snapshots/reverts before every candidate, executes the existing publisher and records every release receipt. It prepares a separate pinned TapeKit source overlay, reads physical files through its real chain kernel at the postpublish block, and validates decoded logical responses. A pure receipt summarizer reports measured gas, mined fees and cost normalized to a common quoted gas price without enabling production strategy selection.
**Tech Stack:** Existing Anvil, Viem, TapeKit pinned source overlay, release/deployer/validator packages, Vitest. No new dependencies.
**Spec:** ../specs/2026-10-28-compression-development-spec.md sections 12–17.

## Constraints

- Only a newly started loopback Anvil process receives writes; no operator keys, mainnet transactions, live DNS/gateway changes or paid CI.
- All candidates share source digest, initial target state/block/hash and common quote gas price. Actual mined fees remain separate from normalized gas costs.
- Setup/opening/funding are outside per-release receipt costs and are explicitly excluded.
- Actual TapeKit chain reads use one local RPC, quorum 1, and direct known fixture container. No claim of independent operators, paid-name resolution, deployed HTTP/Cloudflare behavior or production qualification.
- Fixture source identity is synthetic. Source is scanned with the existing scanner before preparation. Existing publisher remains unchanged.
- Evidence report is written exclusively only after all candidate byte/response checks pass. Automatic selection stays original; no production fee quote or L2-specific fee claim.

## Tasks

- [x] 1. RED receipt accounting tests; implement complete successful unique receipt totals and normalized-cost accounting.
- [x] 2. Implement safe isolated benchmark and opt-in fork acceptance test with same-baseline restoration and all-strategy gateway byte equality.
- [x] 3. Run actual fork/source tests, relevant regression and canonical checks; independent review and durable results/limitations.

## Results and rulings

All four strategies passed same-baseline isolated execution and actual TapeKit chain-reader/adapter/response validation. The final acceptance run passed after a RED/GREEN response-header correction; 260 focused tests and canonical check passed. Independent review found no remaining material issues.

Ruling: direct known fixture container with quorum1 tests actual manifest/read/hash behavior, not identity, paid names or independent operators. Response functions run in Node, not a deployed Worker or browser. These scope limits are present in evidence/report.

Ruling: normalize measured gas to the common baseline quote price while preserving actual mined fees separately. Setup and L2-specific fees are excluded. Automatic production selection stays original and the gas model is unchanged.

See `docs/research/compression/stage-c4-2026-10-28.md` and adjacent evidence JSON. No production operation or commit/push.
