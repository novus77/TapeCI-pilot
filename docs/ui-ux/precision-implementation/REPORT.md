# Precision Console implementation

Date: 2026-10-29

## Scope

This iteration implements direction 02 in the actual Next.js application. It builds on the shell and workbench changes already present in the working directory. No subagents were used. No commits, pushes, deployments, signatures, or chain transactions were performed.

The shared shell now uses a 232px sidebar, a 66px context header, compact navigation, the selected TapeCI mark, a pathname-aware breadcrumb, and a global demonstration notice. Existing routes remain accessible. Search supports `/`, Cmd/Ctrl+K, and Escape. The navigation drawer remains available throughout the collapsed-sidebar width range.

The home page replaces the large KPI cards with compact linked counts, project selection, a deployment pipeline, recent deployments, pending approval, and a wallet resource rail. Pending approval precedes the history on mobile. The wallet summary reads the wallet provider rather than inventing owned resource counts. Selected-project release and latest-deployment queries are separate from the recent global snapshot; query failures are distinguished from empty results. Pipeline phases retain the distinction between uploaded, verified, and live.

Deployment detail retains its overview, files, transactions, verification, and events tabs. Approval controls and the fee summary sit beside the main content on desktop and stack on smaller screens. Domain guidance is collapsible. Compression preparation, plan details, metadata, eligibility checks, and guarded actions remain available.

Project, resource, organization, audit, webhook, and other pages inherit the shared shell and typography. This iteration does not claim that every inner page has been individually rebuilt to match all prototype frames.

## Validation

Tests run against the real Next.js development application at port 3100 with deterministic demonstration data. They do not establish real wallet, hardware, mainnet, GitHub callback, or PostgreSQL acceptance.

- `pnpm run check`: passed (repository ESLint and both configured type checks).
- Full Playwright suite: **159 passed, 1 skipped, 0 failed** in 3.3 minutes on a freshly started demonstration server. The existing skipped test requires a remove-member control that is absent from the read-only mock organization.
- The full run covers accessibility, both locales, four page-matrix viewport sizes, deployment evidence tabs, approval/execution guards, resource preparation and discovery, keyboard navigation, and a 19-width × 4-route header sweep.
- `git diff --check`: passed.
- New workbench checks cover desktop geometry, mobile approval priority, search focus, the tablet navigation boundary, and deployment review navigation.
- Existing shell tests now target the current shell and compact counts while retaining overflow, destination, and keyboard assertions.
- Resource selectors exclude hidden streamed fallback content so assertions evaluate the visible resource state.

## Screenshots

- [Desktop home](home-1440.png)
- [Mobile home](home-375.png)
- [Deployment review](deployment-1440.png)
- [Projects](projects-1440.png)
- [Resources](resources-1440.png)

These are screenshots of the actual application, not static prototype frames. The development indicator is not part of the production UI.

## Follow-up: remaining interiors

The subsequent implementation extends direction 02 to the remaining route interiors. See [Inner page coverage and verification](INNER-PAGES.md) for the updated scope; the first-iteration scope above is historical.
