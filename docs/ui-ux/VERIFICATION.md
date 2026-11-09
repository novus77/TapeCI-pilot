# Independent UI/UX acceptance report

Date: 2026-10-26  
Repository: `novus77/TapeCI`  
Branch: `codex/gitlab-ui-ux`  
Baseline: `6be8715`  
Reviewed state: uncommitted working tree  
QA server: `http://127.0.0.1:3103`  
Production port `3000`: not used or changed

## Verdict

**Accepted for the local, deterministic scope.** After the supervisor's three
findings were fixed, a fresh production build and a fresh mock server passed all
84 browser tests. This includes the original functional suite, the 25-page
deployment accessibility matrix, EN/ZH page matrices, browser-error checks,
keyboard navigation, four viewports and 130 regenerated screenshots.

The earlier independent run found a serious milestone contrast failure, incorrect
Projects link copy and a hard-coded mock project count. Those defects are resolved
and covered by the final green run.

This acceptance does not establish real wallet, hardware-wallet, mainnet,
gateway/DNS/TLS or persistent PostgreSQL behavior. Those limits are listed below.

## What changed

The uncommitted change replaces the former dark console treatment with a
GitLab/Pajamas-inspired hierarchy:

- Dark product header, light content surface, persistent left navigation, compact
  tables, 4px component radii and purple primary actions.
- A project-first overview with KPI cards, project summaries, a bounded recent
  deployment table and a discoverable four-state legend.
- A new `/projects` list route and shared project presentation.
- URL-backed deployment views for Overview, Files, Transactions, Verification and
  Events.
- State-specific action presentation, while retaining blocked reasons, manual
  signature fallback and all existing server-side safety checks.
- EN/ZH copy for the revised shell, overview, projects and deployment surfaces.
- Responsive navigation, a compact mobile locale switch, focusable table scroll
  regions and a localized route loading state.

The implementation inventory and feature-preservation mapping are in
[`IMPLEMENTATION.md`](./IMPLEMENTATION.md) and
[`FEATURE_PARITY.md`](./FEATURE_PARITY.md).

## Final implementation corrections

The independent supervisor's first complete run reported 63 passes and 21 failures.
All 21 were traced to three deterministic findings, then corrected:

1. An obsolete `.milestone { opacity: 0.7; }` rule composited milestone text to
   `#8d8c91` on white, only 3.33:1. The obsolete opacity was removed. The light
   warning list's inherited dark-theme yellow was also changed to `#7d5400`.
2. The overview Projects section linked to `/projects` but used deployment copy.
   It now uses separate EN/ZH `View all projects` copy, while the recent deployment
   section retains `View all deployments`.
3. The mock notice hard-coded two projects. It now interpolates the rendered
   project and deployment counts, so the disclosure remains accurate after mock
   creation.

The supervisor also observed an intermittent missing-title axe snapshot during
deployment navigation. Page readiness previously accepted the first non-empty
title but did not verify that it remained stable. `waitForPageReady` now requires a
stable non-empty title before axe runs. The previously failing
`deployment 04 events` case passed in isolation, and the complete suite passed on a
fresh server.

## Build and static checks

The final production build was run from `apps/web` with an isolated output
directory:

```bash
cd apps/web
TAPECI_NEXT_DIST_DIR=dist/codex-gitlab-ui \
NEXT_PUBLIC_TAPECI_MOCK=1 TAPECI_MOCK=1 NEXT_TELEMETRY_DISABLED=1 \
node node_modules/next/dist/bin/next build
```

Result: **PASS**. Next.js `16.4.2` compiled TypeScript, generated all 18 existing
routes plus `/projects`, and produced server output. The only framework notice was
the deprecated middleware convention warning.

The isolated production server was then started without a build step:

```bash
cd apps/web
TAPECI_NEXT_DIST_DIR=dist/codex-gitlab-ui \
NEXT_PUBLIC_TAPECI_MOCK=1 TAPECI_MOCK=1 NEXT_TELEMETRY_DISABLED=1 \
node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3103
```

Both `/` and `/projects` returned HTTP 200 before browser acceptance. A fresh
server process was used for the final 84-test run to avoid the in-memory mock
store retaining the project created by an earlier suite.

Additional checks:

| Check | Result |
|---|---|
| Focused unit/i18n tests | PASS, 13/13 |
| Focused ESLint | PASS |
| TypeScript with isolated dist excluded | PASS |
| `git diff --check` | PASS |
| Existing Playwright functional suite | PASS within the 84-test run |

`apps/web/tsconfig.json` retains `dist/qa-*` in `exclude` so external QA artifacts
cannot poison normal type checking. The build-generated `next-env.d.ts` reference
was restored to the repository's normal `dist/types/*` paths after testing.

## Independent browser acceptance

Command:

```bash
cd apps/web
node ../../node_modules/@playwright/test/cli.js test \
  --config e2e/playwright.supervisor.config.ts \
  --reporter=line
```

Final fresh-server result: **84 passed (84 total), 1.6 minutes**.

The suite covers:

- Five deployment fixtures × five URL-backed views.
- WCAG 2.0/2.1 A and AA axe analysis for the desktop route matrix, all 25
  deployment fixture/view pages and organization detail.
- EN and ZH page matrices across 18 key routes, with title, language,
  navigation, raw-translation-key and page-overflow checks.
- 1440×900, 1280×800, 768×1024 and 390×844 key-page screenshots and overflow.
- All five fixtures × five views at 1440×900 and 390×844.
- Keyboard access to the skip link, primary navigation, action eligibility and
  deployment section links.
- Mobile locale visibility and switching.
- Mobile table minimum width and scroll-region behavior.
- Fresh and post-create mock count consistency.
- Overview section-link labels and destinations.

The original functional suite inside this run covers navigation, deployment
filtering, project detail, live/verified/failed states, container ownership and
TTL, demo approval, project creation, audit filters, search, evidence export,
settings/organization navigation, locale persistence and CSP.

## Responsive and visual review

The final screenshot set contains 130 PNG files:

- 52 screenshots for the 13 key-page groups across four viewports.
- 50 screenshots covering all five deployment fixtures × five views at 1440px.
- 50 corresponding mobile fixture/view screenshots at 390px.
- 8 legacy screenshots retained from earlier implementation iterations.

The latest screenshots were manually inspected at desktop and mobile sizes:

- Home and Projects show real page content, project cards, current release and
  latest deployment without a loading placeholder.
- The build-failed deployment shows its outcome, recovery guidance, milestone
  truth, demo boundary, URL sections and technical details.
- At 390px, the locale control remains visible, navigation stays operable and the
  page itself has no horizontal overflow.
- Wide tables retain readable columns inside a focusable horizontal scroll region.
- Live, Verified, Uploaded, Approval and Build failed remain visually distinct.

Representative artifacts:

- [`1440x900-home.png`](./screenshots/1440x900-home.png)
- [`390x844-home.png`](./screenshots/390x844-home.png)
- [`1440x900-deployment-build-failed-overview.png`](./screenshots/1440x900-deployment-build-failed-overview.png)
- [`390x844-deployment-live-files.png`](./screenshots/390x844-deployment-live-files.png)
- [`390x844-organization-detail.png`](./screenshots/390x844-organization-detail.png)

## Remaining observations

- At 390px the top navigation is horizontally scrollable and clips its trailing
  labels at the viewport edge. The page itself does not overflow; all primary
  entries remain reachable, and the compact language switch is independently
  verified.
- Organization detail uses a header-only Members table at 390px. It is operable
  and passes accessibility checks, but a future compact empty state would read
  more intentionally.
- The desktop sidebar has a fixed width, matching the intended GitLab-like
  information architecture. It did not cause page-level overflow in tested sizes.

These observations do not block the current local UI/UX acceptance.

## Limitations

- Tests run in deterministic mock mode.
- No injected browser wallet, hardware wallet or real signature was tested.
- No transaction was sent to X Layer or any mainnet.
- No gateway, DNS, TLS or domain propagation behavior was verified.
- No persistent PostgreSQL-backed mutation or restart behavior was verified.
- Screenshot review covers the specified four widths and key routes; it is not a
  full cross-browser or assistive-technology certification.
- The isolated Next build is not a substitute for CI execution.

## Acceptance checklist

| Area | Status | Evidence |
|---|---|---|
| Full browser suite | PASS | 84/84 on a fresh server |
| Existing functional Playwright coverage | PASS | included in 84/84 |
| Production build and HTTP smoke | PASS | isolated build; `/` and `/projects` HTTP 200 |
| Desktop route axe matrix | PASS | 18/18 |
| Deployment axe matrix | PASS | 25/25 |
| Organization detail axe | PASS | no serious or critical findings |
| EN/ZH key-page matrix | PASS | 2/2, 18 routes each |
| Four-viewport screenshots and overflow | PASS | 4/4 |
| Five fixture × five view visual capture | PASS | 2/2 matrix tests, 50 pages |
| Mobile locale switch | PASS | 1/1 |
| Mobile tables | PASS | 1/1 |
| Keyboard navigation | PASS | skip, nav, disclosure, section links |
| Overview destination/count consistency | PASS | fresh and post-create assertions |
