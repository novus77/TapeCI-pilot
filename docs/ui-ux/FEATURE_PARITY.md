# Feature parity inventory

Baseline: branch `codex/gitlab-ui-ux`, before product edits on 2026-10-25. Existing API contracts and chain safety checks remain authoritative.

| Feature | Existing entry | Planned entry | Conditions and preserved evidence |
|---|---|---|---|
| Overview and four release milestones | `/`, permanent legend | Project-first overview, accessible disclosure; always visible on deployment detail | Build, upload, verify and live remain distinct |
| Existing projects | Overview cards | `/projects`, sidebar and overview | All accessible projects, including archived projects |
| Project releases/configuration | `/projects/:id` | Same route, current release/latest deployment summary | `Release.isCurrent` alone identifies current release; failed latest deployment does not remove it |
| Creation/GitHub repository picker | `/projects/new` | Same wizard, explicit settings handoff | Existing fields, installation selection, branch autofill, validation and retained input |
| Path mode | `/projects/:id/settings` | Same settings; linked after creation | Create contract has no pathMode; no speculative API extension; root safety warning retained |
| Deployment filtering/search | `/deployments?state=&projectId=&q=&limit=` | Same, plus scoped attention/completed views | Raw states preserved; fetched-record search explicitly bounded; overview and links use the same latest-ten snapshot |
| Plan/fees/blocked reasons | Deployment detail | Overview plan plus action eligibility disclosure | Budget, ownership, expiry and conflicts remain blocking |
| Wallet approval | Deployment detail | Relevant state actions | PLAN_READY/AWAITING_APPROVAL; connect, switch chain, EIP-712 and manual fallback |
| Execute | Deployment detail | APPROVED action | Existing server action and safety checks unchanged |
| Rollback | Deployment detail | LIVE action | Existing new-deployment flow and independent approval remain |
| Metadata/raw states/hashes | Deployment detail | Overview technical details | Complete values, copy buttons and explorer links retained |
| Files/transactions/verification/events | Deployment detail | URL-backed section navigation | Full tables and reports remain reachable; absent data is not claimed empty |
| Evidence export | `/deployments/:id/evidence` | Same download action | Existing JSON route unchanged |
| Container/binding/operator TTL | `/containers/:address` | Same plus deployment activation handoff | Domain binding is independent of release LIVE; wallet/operator operations unchanged |
| Organizations/members/budgets | `/organizations`, `/organizations/:id` | Same shared shell | Existing role and policy gates unchanged |
| Settings/notifications/member policy | `/projects/:id/settings` | Same shared shell | Save, archive, member and budget operations retained |
| Compare/audit/webhooks | Existing routes | Same routes, shared shell | Query parameters and all evidence retained |
| Login/logout/notifications/locale | Global shell and `/login` | Same shell | Auth routes, read notifications and EN/ZH cookies retained |

## Verification mapping

| Surface | Automated coverage |
|---|---|
| Project-first overview and all four milestones | `apps/web/e2e/console.spec.ts`, `tests/unit/web-console-views.test.ts` |
| Projects navigation and project list | `apps/web/e2e/console.spec.ts`, axe `/projects` |
| Scoped snapshot counters and fetched-record search | `tests/unit/web-console-views.test.ts`, overview attention-link E2E |
| Deployment section URLs and retained evidence | deployment section E2E, reload/history E2E, axe for all five views |
| Contextual action eligibility | `tests/unit/web-console-views.test.ts`, failed-build and Live E2E |
| Demo approval path | demo approval E2E |
| Manual EIP-712 fallback | existing approval component tests; real wallet/device path not covered by mock E2E |
| Evidence export | downloadable-evidence E2E |
| Settings and organization redirect feedback | success-navigation E2E for project settings and organization creation; organization detail read-only role gate |
| EN/ZH key coverage | `tests/unit/i18n.test.ts`; browser-level language matrix in independent QA |
| Accessibility | axe page matrix for desktop routes, all deployment views and organization detail; keyboard review in independent QA |
| Responsive behavior | mobile locale access, table scroll region and page-overflow regression; four-viewport visual review in independent QA |

The independent supervisor owns final browser, visual, keyboard, localization and
responsive acceptance. Any failed or deferred item must be listed in
`docs/ui-ux/VERIFICATION.md`; absence of an automated mock check is not proof of real
wallet, device, mainnet, gateway or persistence behavior.
