# GitLab-aligned UI/UX Implementation Plan

> **For agentic workers:** Use subagent-driven-development for implementation and independent verification. Track completion with checkboxes. Do not commit or push; the user has authorized local implementation and testing only.

**Goal:** Improve TapeCI's complete console toward GitLab/Pajamas while preserving every existing feature, permission, recovery path, and chain safety invariant.

**Architecture:** Keep Next.js/React, current backend APIs, and the release state machine. Consolidate visual behavior in an explicit token/component layer, adapt existing pages without removing data, and use URL-backed views where needed. No new UI framework or dependencies are required.

**Tech Stack:** Next.js 16, React 19, TypeScript strict, pnpm, existing Radix/Lucide, Vitest, Playwright and axe.

**Spec:** `/Users/a77/Documents/ChatGPT/okx tapeout 黑客松/docs/reports/TapeCI-GitLab-UI-UX-优化报告-2026-10-25.md`

## Global Constraints

- GitLab and official Pajamas are the design benchmark, not a new design direction.
- Preserve every existing feature; moving or collapsing content must leave discoverable accessible entry points and all data/actions available under their original valid conditions.
- Preserve all existing routes, technical evidence, raw state access, manual-signature fallback, budget/ownership/expiry checks, live/demo distinction, domain binding and rollback approval.
- No chain writes, secrets inspection, live financial actions, dependency installation, commits, pushes or deployment.
- Communicate in Chinese; code, comments, identifiers, new technical documents and test descriptions in English. Existing dictionary locales retain their own language.
- Work only in `/Users/a77/Desktop/tapeout` on branch `codex/gitlab-ui-ux`; do not touch the user's existing server on port 3000.
- User explicitly authorized immediate subagent execution; proceed without a second plan-approval round. Keep plan/progress and feature-preservation evidence in files.
- Existing installed dependencies may be reused. Tests must use deterministic mock/fork-free data; no mainnet transactions.

## Review Focus

- Multiple historical LIVE releases must not be misrepresented as multiple currently online sites.
- Failed latest deployment must not erase the current release; domain activation is separate from release verification.
- State-conditional wallet UI must retain manual approval, error recovery and all originally valid actions.
- URL view/filter state, direct links, localization and keyboard navigation must survive layout changes.
- Narrow viewports, long addresses/repository names and all existing secondary pages must remain operable.

### Task 1: Implement the cohesive GitLab-aligned console update

**Files:**
- Modify: `apps/web/app/layout.tsx`, `app/globals.css`, `app/page.tsx`, `app/deployments/page.tsx`, `app/deployments/[id]/page.tsx`, `app/projects/[id]/page.tsx`, `app/projects/[id]/settings/page.tsx`, `app/projects/new/page.tsx`, relevant container/secondary pages when needed.
- Modify/create focused components under `apps/web/components/`, dictionary/type/query helpers under `apps/web/lib/`.
- Create: `apps/web/app/projects/page.tsx` for discoverable existing project listing.
- Create: `docs/ui-ux/FEATURE_PARITY.md` and `docs/ui-ux/IMPLEMENTATION.md`.
- Test: relevant `apps/web/e2e/*.spec.ts`, `tests/unit/*web*.test.ts` or focused existing test locations.

**Interfaces:**
- Consume current typed API functions, Project/Deployment/Release/Binding models, state mapping and action capabilities. Read actual types before implementing.
- Keep current public API contracts and routes. Add query/view helpers with typed inputs and tests if needed. Avoid backend migration or permissions changes.
- Preserve current `data-testid` where feasible; when changed layout affects tests, update navigation/assertions to prove retained functionality, never weaken assertions or silently delete tests.

- [x] Read the full spec and existing web implementation; record a page/feature/action/state inventory before modifying UI.
- [x] Add meaningful failing regression tests for the behavioral changes: accurate scope/attention filtering, Projects navigation, retained detail content through views, conditional action safety and bilingual copy. Run targeted tests to observe relevant failures. Pure styling needs visual verification rather than mirrored tests.
- [x] Implement a coherent restrained GitLab/Pajamas app shell, hierarchy, typography, forms, tables, badges and feedback. Keep the existing purple direction; no decorative Uiverse effects. Prefer editing/consolidating existing layers rather than blindly adding another override wall. Do not claim official pixel values or download fonts unnecessarily.
- [x] Provide discoverable Projects navigation, project-first overview while preserving the four-stage explanation in accessible help, compact project context, and clear current release versus latest deployment.
- [x] Fix misleading snapshot counters and attention links using the same set/filter semantics. Scope counts honestly. Preserve raw-state filtering. State clearly when search matches only fetched records; do not claim full-history search without a supported API.
- [x] Improve deployment detail hierarchy: outcome/context, lifecycle and relevant actions first; keep all metadata, plan, files, transactions, verification, events, export and recovery paths. Use accessible URL-backed section navigation or tabs with real preserved content. Keep known blocked-action reasons discoverable. Show domain status or safe link to container activation without fabricating availability.
- [x] Make wallet warnings contextual so a completed release does not show irrelevant missing-wallet warnings; retain manual-signature fallback and rollback under the existing capability/safety model. Check both real-wallet and demo components.
- [x] Expose existing path-mode configuration in project creation only if current create contracts support it; otherwise retain full existing creation and provide a clear settings handoff. Do not expand backend behavior speculatively or weaken Root/versioned safety caveats.
- [x] Apply consistent shell/shared components to organizations, settings, audit, webhooks, compare, login, errors and containers; retain all operations. Finish EN/ZH of touched user-facing text, including actionable errors and labels.
- [x] Run `pnpm typecheck:web`, `pnpm lint`, focused unit tests and `pnpm web:build`; report exact results. Playwright full browser verification belongs to independent Task 2 unless needed for TDD or debugging; do not run build concurrently with the QA agent.
- [x] Update feature inventory with old/new entry points, state/role conditions and verification coverage; record implemented/deferred items honestly. Write task report. Do not commit.

### Task 2: Independent functional, visual and test supervision

**Files:**
- Read all Task 1 diff, inventory and reports.
- May add focused tests under `apps/web/e2e/` after implementer handoff; no uncoordinated product edits.
- Create: `docs/ui-ux/VERIFICATION.md` and screenshots in `docs/ui-ux/screenshots/`.

**Interfaces:**
- Consume Task 1's uncommitted diff package and report, and the feature inventory.
- Produce spec-compliance verdict, code-quality verdict, exact checks/results, screenshots and actionable findings with file/line references.

- [x] Before implementation finishes, independently inventory existing feature routes/test coverage; preserve a baseline. Do not run build/E2E concurrently with implementer.
- [x] After handoff, inspect diff for feature loss, fabricated state, weakened tests, inaccessible hidden content, stale URL navigation and failure-path regressions.
- [x] Run full deterministic Playwright + axe suite using installed Chrome; use a separate mock server on a free port with isolated Next build directory if necessary. Keep the real port-3000 server untouched.
- [x] Check overview, projects, new project, project detail/settings/compare, all deployment fixture states, container/binding, organizations, audit, webhooks and login in EN/ZH. Check 1440x900 and 390x844, plus 1280x800 and 768x1024 for key layouts. Inspect console/runtime errors and overflow.
- [x] Verify behavior rather than appearance alone: filters and search scope, URL-backed navigation, access to evidence/files/transactions/raw state, creation/configuration, contextual actions and manual fallback, existing rollback gates, localization and keyboard navigation.
- [x] Capture and inspect screenshots; write independent report with exact passed/failed/skipped checks and limitations. Do not claim real wallet/device/mainnet validation from mocks.
- [x] Send findings to controller for implementer fixes, then perform scoped re-review and covering regression checks. Finish only after important findings resolved or explicitly reported as unresolved.

## Controller Ledger

- Task overlap: Task 1 owns product code and initial regression tests; Task 2 owns independent review after handoff. No simultaneous edits to shared product files.
- Task consistency: Existing CSS/layout and behavior tests may need coordinated changes; feature parity and accessible entry points are the authority, not obsolete element placement.
- Execution decision: Use a dedicated feature branch in the clean existing checkout, reusing installed dependencies. No new worktree is needed; do not create one without a user preference. Existing server remains running.
- Baseline pending: web typecheck and offline unit suite started before implementation.
