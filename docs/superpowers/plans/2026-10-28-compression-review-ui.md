# Compression Selection and Review Implementation Plan (C3)

> **For agentic workers:** Use executing-plans and test-driven-development; request independent final review.

**Goal:** Let maintainers explicitly request a new strategy plan and show preparation identity before approval without modifying approved deployments.
**Architecture:** Shared operator gateway configuration feeds API and Worker. An authenticated preparation read endpoint reports selection capability and frozen identity. A mutation creates an idempotent independent BUILT deployment referencing the same raw source and queues planning only; it copies neither pin, approval, plan nor journal. Existing signature/execution routes remain unchanged. The deployment page shows a localized preparation panel and server-action form.
**Tech Stack:** Existing Fastify, Drizzle, ObjectStore, BullMQ, Next.js, React, Vitest and Playwright. No new dependencies.
**Spec:** ../specs/2026-10-28-compression-development-spec.md sections 13–17 and C2 addendum.

## Constraints and decisions

- Original remains default. No automatic cheaper-mode claim or automatic execution.
- Operator gateway metadata is configuration, not live qualification proof. Default profiles empty; nonzero fees unsupported. API cannot accept gateway origins or adapter hashes from a user.
- Only maintainer/owner, nonarchived project, PLAN_READY/AWAITING_APPROVAL source, no rollback source, matching current container, and retained raw archive may request a strategy plan.
- A UUID request ID deduplicates retries per source; a reused ID with a different preparation is rejected. The original deployment remains independently reviewable; UI explains the new approval requirement.
- Missing configuration disables gzip choices and explains why. Retained approved snapshots remain usable even when no new plan can be prepared.
- Do not expose raw storage keys, secrets, or treat metadata presence as byte verification. Display snapshot digest as a recorded pin, not an independent storage audit.
- Production gateway installation, service fees and simulated automatic cost selection remain out of scope.
- Work in isolated compression-release checkout only. No commit/push, production migration or chain writes.

## Tasks

- [x] 1. RED configuration parsing tests; add strict opt-in gateway JSON parsing used by API and Worker.
- [x] 2. RED actual PostgreSQL API tests; add read/strategy-plan endpoints with authorization, immutable source, idempotency and planning-only queue behavior.
- [x] 3. Add localized review panel and server action; browser test original/default/disabled selection and mobile layout using actual Next page.
- [x] 4. Run focused regressions, canonical check and independent review; record exact limits and next gates.

## Results and rulings

Fresh: 257 focused tests, 20 disposable PostgreSQL tests, 1 demo Chrome and 2 actual-local-API Chrome cases passed. Canonical check passed; broad unit/ops 595 passed with 12 existing cwd-dependent failures. Final independent review found no remaining material issues after two RED/GREEN fixes (idempotent recovery and removed-gateway selection).

Ruling: creation eligibility applies to new strategy requests; matching retries recover the existing ID independently, while current gateway/target/project eligibility still controls requeue. This avoids losing an existing attempt after a response/queue failure without allowing revoked gateways to execute.

Ruling: the real-API browser fixture stops its queue after actual artifact preparation, without RPC quotes or transactions. It proves UI admission and prepared-byte integration; C2 fork evidence is not promoted to fresh C3 evidence.

Ruling: isolated browser builds use webpack because Turbopack rejects external third-party dependency links. Generated Next config additions were restored afterward.

See `docs/research/compression/stage-c3-2026-10-28.md` for reproduction and remaining production gates. No commit/push or production operations.
