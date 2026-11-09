# TapeCI Be UI A01–A07 implementation

Date: 2026-10-30. User scope: A01–A07 only. No subagents, commits, pushes, deployment or chain transactions.

## Implemented scope

| Item | Implementation | Retained behavior |
| --- | --- | --- |
| A01 Lifecycle | Four compact connected nodes, localized labels, evidence count and native expandable definitions; old nested cards removed | Original `lifecycleRank`, `deploymentStage` and verification evidence determine completion; no fake percentages or manually completed stages |
| A02 Approval review | One review card with repository, container, chain, commit, manifest copy, estimated cost and approved cap above the actions; shared by demo and real-wallet branches | Original capability checks, blocked reasons, signature logic, owner checks, fee caps and execute/rollback confirmations |
| A03 Tabs | Motion underline on native links for deployment views and project section navigation | Deployment `?view=`, direct links, reload/history, native keyboard links and project hashes |
| A04 Badges | Small leaf Motion adapter for icon/text updates; unified status-chip presentation | Original state labels, symbols, tones and data attributes |
| A05 Buttons | Native-button adapter with restrained label transitions, busy indicator, disabled state and Server Action pending feedback; applied to approval/wallet actions, confirmations, retry, copy, project creation, compression preparation and project/organization save controls | Existing callbacks, field names, form submission, confirmation dialogs and disabled rules; no artificial success or timers replacing API completion |
| A06 Disclosures | Native details/summary with unified arrow and progressively enhanced height transition for lifecycle definitions, domain guidance, action eligibility and home state explanations | Keyboard interaction, native open state, find-in-page and visible blocked-action reasons |
| A07 Alerts | Consistent compact tone surfaces, Lucide status icons and cleaner title/body hierarchy; plan warnings use the shared risk notice | All risk text, persistent errors, `role=alert` for critical feedback and original action-result evidence |

These are original TapeCI adapters inspired by the public Be UI interaction patterns reviewed in `COMPONENT-MAPPING.md`. They are not unmodified Tailwind components copied into the app. No paid Pro component was installed.

## Architecture and dependency

- Existing Next.js 16.4.2 and React 19.3.1 remain in use.
- Added `motion` 14.8.0 (declared range `^14.8.0`) and its resolved lockfile entries.
- Existing ordinary CSS remains the styling system; no Tailwind migration.
- Motion is limited to leaf badge/button/tab components. Data loaders and lifecycle evidence remain server-rendered.
- Reduced-motion preferences remove positional transitions and spinner rotation. All controls retain a usable static state.
- CSS is isolated in `apps/web/app/release-review.css` and imported after existing theme/layout styles.

## Main files

New components: `motion-feedback.tsx`, `disclosure.tsx`, `review-tabs.tsx`, `approval-review.tsx`.

Updated components: lifecycle, stage badges, risk notices, demo/live deployment actions, action eligibility, confirmation/copy/retry controls, new-project and compression preparation forms, and plan warnings. Deployment/project pages and project/organization save forms compose these adapters without changing backend APIs.

## Verification

- Initial focused regressions: 4 failures before implementation, exposing non-localized lifecycle content, missing approval summary, missing tab indicator and missing native stage disclosure.
- Focused review/workflow regression: 25 passed, covering approval, execution confirmation, build failure, compression, deep links, history and mobile review.
- Final complete mock browser suite: **171 passed, 1 skipped, 0 failed** in 4.0 minutes. The pre-existing skipped case requires a remove-member control absent from the read-only mock organization.
- `pnpm run check`: passed (ESLint plus repository and web type checks).
- `git diff --check`: passed.
- Isolated production build: passed. Command: `TAPECI_NEXT_DIST_DIR=dist/beui-build NEXT_PUBLIC_TAPECI_MOCK=1 TAPECI_MOCK=1 pnpm --filter @tapeci/web build`.

## Limits

Verification uses deterministic demonstration data. The real-wallet branch is type-checked and compiled, but no real extension/hardware signature, mainnet write or fee was executed. The existing capability and signing functions were not changed. Production bundle size and real-device frame timing were not benchmarked; no performance percentage is claimed.

The dependency installer reported the pre-existing WalletConnect/unstorage ioredis peer mismatch; this iteration did not alter those dependencies.

## References

- [Be UI status badges](https://beui.dev/components/motion/animated-badge)
- [Be UI approval cards](https://beui.dev/components/agents/approval-card)
- [Be UI tabs](https://beui.dev/components/motion/tabs)
- [Be UI buttons](https://beui.dev/components/motion/button)
- [Be UI collapsibles](https://beui.dev/components/motion/collapsible)
- [Be UI alerts](https://beui.dev/components/motion/alert)

## Final visual evidence

The restored demonstration starts with 2 projects and the awaiting-approval release. The final Chinese lifecycle panel is 245.125px high at a 1440px viewport. At 390px the document client and scroll widths both measure 390px. Native disclosure opening and reduced-motion keyboard behavior passed the focused regression.

- [Lifecycle](screenshots/lifecycle-final.png)
- [Expanded stage definitions](screenshots/lifecycle-expanded.png)
- [Desktop review](screenshots/approval-desktop.png)
- [Mobile review](screenshots/approval-mobile.png)
