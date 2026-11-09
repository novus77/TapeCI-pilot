# Precision Console Inner Pages Implementation Plan

**Goal:** Apply the approved direction 02 to the remaining application interiors while preserving all existing behavior.
**Execution:** Direct implementation by the primary agent, per user request; no subagents and no commit/push.
**Architecture:** Keep the existing Next.js server pages, data loaders, client wallet flows and server actions. Add explicit page-level layout classes and refine shared presentation. Retain anchored settings sections rather than hiding unsaved forms behind tabs.
**Tech Stack:** Existing Next.js 16 / React 19 / CSS / Playwright; no new runtime dependencies.

- [x] Projects: compact repository rows, identity mark and aligned release/resource facts; preserve every project/container link.
- [x] Settings: 180px section navigation plus one readable content column; remove 99-row grid expansion; expose notification channels in the navigation; keep every form and permission check.
- [x] Project/container details and comparison: explicit overview/evidence layouts, compact tab rail and consistent metadata/tables.
- [x] Resources: wallet discovery first, manual address lookup second, resource state and manual circuit inspection retained; mint/prepare/progress get consistent workflow layout.
- [x] Operations: organization list/create split, member and budget areas, audit/webhook data surfaces.
- [x] Entry/support: dedicated login composition, wallet acceptance, error/loading/not-found surfaces. Exactly one main landmark.
- [x] Validate: focused browser assertions for settings spacing/navigation, project rows, resource ordering, and mint landmarks; then existing complete browser suite plus lint/type checks. Capture actual page screenshots and record verified limits.
