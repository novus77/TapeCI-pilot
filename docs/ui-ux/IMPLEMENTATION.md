# GitLab-aligned console implementation

Date: 2026-10-25  
Base: `6be8715`  
Branch: `codex/gitlab-ui-ux`  
Status: implementation complete; independent browser and visual acceptance recorded
in [`VERIFICATION.md`](./VERIFICATION.md)

## Scope

The console now uses a restrained GitLab/Pajamas visual language while retaining the
existing Next.js application, API contracts, routes, permissions, release state
machine and chain safety checks.

The visual baseline is a dark top bar, light content surface, persistent left
navigation, 14px body copy, compact metadata, 4px component radii, purple primary
actions and semantic status colors. The implementation follows GitLab's product
hierarchy and Pajamas component semantics. It does not claim pixel parity with a
specific GitLab release.

## Information architecture

- `/` is project-first. It shows project summaries, current release, latest
  deployment, scoped counters and a bounded recent-deployment snapshot.
- `/projects` is a discoverable list of every project returned by the existing API.
- `/projects/:id` separates the current release from the latest deployment.
- `/deployments/:id` exposes URL-backed sections for Overview, Files, Transactions,
  Verification and Events.
- The four release milestones remain available in an accessible disclosure on the
  overview and are always visible on deployment detail.
- Secondary pages use the same application shell and component hierarchy.

## Feature preservation

| Existing capability | Current entry | Preserved behavior |
|---|---|---|
| GitHub repository selection and project creation | `/projects/new` | Existing fields, validation, installation picker and retained input |
| Build and path configuration | `/projects/:id/settings` | Existing settings, archive state, path mode and Root safety copy |
| Deployment filtering and search | `/deployments` | Raw state, project and query filters; fetched-record scope is explicit |
| Plan, cost cap and blocked reasons | Deployment Overview | Full plan data and action eligibility reasons remain available |
| Wallet approval | Deployment detail | Connect, chain switch, EIP-712 signing and owner checks |
| Manual approval fallback | Deployment detail | Existing EIP-712 payload copy and signature submission |
| Execute | Deployment detail | Shown only when state is `APPROVED`; server checks remain authoritative |
| Rollback | Deployment detail | Shown only for `LIVE`; existing independent approval flow remains |
| Files, transactions, verification and events | Deployment section links | Every table, report and raw state remains accessible by direct URL |
| Evidence export | Deployment header | Existing JSON download route unchanged |
| Container, ownership, roles and operator TTL | `/containers/:address` | Existing read and domain-activation operations unchanged |
| Organizations, members and budgets | `/organizations` | Existing role gates and mutations unchanged |
| Settings, policy, members and notifications | `/projects/:id/settings` | Existing forms and success/error feedback unchanged |
| Compare, audit and webhooks | Existing routes | Existing query parameters and evidence unchanged |
| Login, logout, notifications and locale | Global shell | Existing routes, cookies and read state unchanged |

Moving content behind a section link or disclosure does not remove its route, data
or action conditions. The inventory and acceptance mapping are recorded in
[`FEATURE_PARITY.md`](./FEATURE_PARITY.md).

## Correctness decisions

- `current release` means the release with `isCurrent === true`.
- `latest deployment` means the newest returned deployment record. A failed latest
  deployment does not erase the current release.
- Domain activation is shown as a separate container concern. A release marked Live
  does not fabricate a healthy gateway or active domain.
- Overview counters and linked views use the same fetched deployment snapshot and
  the same scope predicates. Search is explicitly limited to fetched records.
- Wallet controls render only when the current state can approve. Completed releases
  therefore show rollback without irrelevant wallet-connect or disabled-approval UI.
- Presentation state gates do not replace server-side ownership, budget, expiry,
  concurrency or authorization checks.
- The create-project contract has no path-mode field. Creation retains its existing
  fields and links to Settings rather than extending the API speculatively.

## Main files

- `apps/web/app/globals.css`: consolidated GitLab-aligned visual layer and responsive
  behavior.
- `apps/web/app/page.tsx`: project-first overview and bounded deployment snapshot.
- `apps/web/app/projects/page.tsx`: new project list route.
- `apps/web/components/project-list.tsx`: shared project summaries.
- `apps/web/app/deployments/[id]/page.tsx`: deployment hierarchy and section views.
- `apps/web/lib/console-views.ts`: view parsing, snapshot filtering and action context.
- `apps/web/components/action-eligibility.tsx`: discoverable action conditions.
- `apps/web/components/wallet-actions.tsx`: state-conditional wallet and manual-signature
  paths.
- `apps/web/app/loading.tsx`: localized, non-blocking loading state.
- `apps/web/lib/i18n.ts`: EN/ZH copy for touched UI.
- `apps/web/e2e/console.spec.ts`, `apps/web/e2e/accessibility.spec.ts` and
  `apps/web/e2e/supervisor.spec.ts`: functional, accessibility and independent
  browser coverage.

The CSS file was reduced from 5,346 lines at the visual-polish baseline to about
3,500 lines while replacing overlapping dark-theme and component override layers.

## Verification completed

These commands were run against the current implementation:

```bash
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
node node_modules/eslint/bin/eslint.js apps/web/app apps/web/components apps/web/lib apps/web/e2e tests/unit/web-console-views.test.ts
node node_modules/vitest/vitest.mjs run tests/unit tests/ops
git diff --check
NEXT_PUBLIC_TAPECI_MOCK=1 TAPECI_MOCK=1 NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next build
```

Results:

- TypeScript: pass.
- Focused ESLint: pass.
- Offline unit and ops suite: 20 files, 358 tests passed on the final working
  tree; the focused console and i18n suites pass 13/13.
- Production build: pass. All existing routes and `/projects` are in the route list.
- `git diff --check`: pass.

The QA build exposed a TypeScript configuration hazard: Next adds a symlink under
`apps/web/dist` for an external isolated build, and the generated validator resolves
paths from the wrong root. `dist/qa-*` is excluded so local and CI type checks remain
stable. Normal `next build` uses `apps/web/dist` and does not require the exclusion.

## Browser acceptance

The independent supervisor runs a fresh production build on port `3103`; the real
console on port `3000` is untouched. The matrix covers all key routes in EN and ZH,
five deployment fixtures, five URL-backed views, axe, browser errors, keyboard
navigation, page overflow and screenshots at 1440x900, 1280x800, 768x1024 and
390x844. Exact final results are recorded in [`VERIFICATION.md`](./VERIFICATION.md).

The final mobile correction keeps the compact locale switch in the top bar,
keeps 660px table columns inside a focusable scroll region, hides the redundant
top-bar New project button because the mobile navigation retains it, and localizes
the route loading state.

Mock verification cannot establish correctness for a real injected wallet, hardware
device, mainnet transaction, gateway/DNS state or persistent PostgreSQL API behavior.
