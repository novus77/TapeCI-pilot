# TapeCI user journey audit — 2026-10-27

## Scope and confidence

Reviewed the current checkout using browser walkthroughs of Overview, New project, Project,
Build failed, Awaiting approval and Container pages, plus the corresponding web components and API
routes. The previews used deterministic mock data. No real deployment, signature or transaction was
submitted. This is a UI and workflow audit, not a new acceptance of external integrations.

The original preview on port 3000 stopped responding during inspection. A separate mock preview
was started on port 3103. The cause of the original service exit was not investigated; it is not
classified as a product defect here. Settings, real-wallet behavior and recovery semantics below
are source-reviewed unless explicitly described as observed in the browser.

## Assessment

The console exposes useful release evidence and correctly distinguishes a historical deployment,
the current release and domain activation. The largest remaining problem is completing an operator
task: users can inspect many facts but must supply outside knowledge to start, recover or finish
a release. Preserve existing evidence and controls while moving the next useful action forward.

The target workflow is:

GitHub sign-in → installation/repository access → project configuration → readiness checks →
first build → review changes and cost → owner signature → execute → verify → activate site →
visit site → monitor, renew or recover.

## Prioritized findings

| ID | Priority | Evidence and user impact | Required change | Acceptance criterion |
| --- | --- | --- | --- | --- |
| J01 | P0 | Container activation has no wallet-connect control. `BindNameForm` reads account state but does not call `useConnect`; disconnected accounts disable activation. A user arriving directly cannot complete the owner-wallet path here. Its injected-provider gate also needs review for a connected WalletConnect account without `window.ethereum`. | Add connection, connector selection, account switching and network switching directly to activation, sharing existing wallet behavior where appropriate. | Starting disconnected, a user can connect on this page, see the expected owner and chain, inspect cost and reach the wallet confirmation. Verify injected and WalletConnect paths independently. |
| J02 | P0 | Build-failed page shows a short error and says to trigger another deployment, but has no job log, source-run link or retry action. Project page has no visible run-deployment control; inspected API deployment routes expose approve/execute, not a general build retry endpoint. | Add a build/job detail view, source GitHub Actions link where available, and an explicit trigger/retry workflow backed by the actual build system. | Given a missing-module build failure, the user finds the failing step, changes configuration or source, and starts a new traceable attempt without guessing a CLI command. |
| J03 | P1 | Creation requires an already-open container and defaults to `npm ci`, `npm run build`, `dist`. Root/versioned path policy is deferred to settings after creation even though the page says the first push starts a build. | Add prerequisite checks, container discovery or an external setup handoff, editable build presets, path-policy choice and a final configuration review before enabling the first build. | A new user knows how to obtain a container and can confirm repository access, container owner/open state, output mode and path policy before the first build. Avoid adding container-creation transactions without a separate product decision. |
| J04 | P1 | Real approval source fetches the EIP-712 payload then opens the wallet signing prompt. The action area is above cost and plan details; the desktop screenshot places the approval section near the bottom of the first viewport. There is no consolidated pre-sign review of the fetched payload. | Put a compact review beside the primary action: commit, changes, manifest, container, signer, network, estimate, authorization cap and expiry. Explain which account funds execution. | The displayed summary matches the payload that will be signed; account mismatch and stale approval produce a specific recovery action. |
| J05 | P1 | `formatWeiAsOkb` truncates every value to four decimal places. A positive amount below 0.0001 OKB renders as `0.0000 OKB`. The observed mock domain fee is actually zero, so that screenshot alone is not proof of a nonzero fee being hidden. | Use adaptive precision or a less-than label and expose the exact amount in the cost review. Budget inputs currently use raw wei; offer OKB input with exact wei disclosure. | Positive amounts never look free; unknown estimates remain unknown. Verify zero, one wei, small domain fees and normal deployment fees. |
| J06 | P1 | Project, deployment and container views intentionally split release and domain state, but a user must navigate through explanatory links to establish site availability. | Add a project-level publication summary: current release, activation, expiry, public URL and last gateway check. Keep chain verification and HTTP availability as distinct signals. | A user can see whether the site can be visited, what blocks access, and the next action from the project page. |
| J07 | P1 | Container page warns about expired sessions and recommends new approval or revocation, but its session table has no direct recovery action. Real deployment buttons are primarily selected from deployment state. | Add contextual links to the applicable approval and explain unsupported renewal/revocation paths. Define recovery for expired approvals, upload failure and verification failure with backend support. | Each blocking state identifies the responsible actor, recoverable action, any additional fee and whether existing writes will be reused. Do not promise automatic resume before its semantics are implemented. |
| J08 | P1 | GitHub setup has an installation picker, but repository-fetch failure offers an error without a local retry action. Webhook page is a flat list without a deployment link or delivery detail. | Add installation health, refresh/retry, permission repair links and a delivery-to-build-to-deployment trace. | If a push creates no build, the user can distinguish missing installation, wrong branch, rejected delivery and downstream build failure. |
| J09 | P2 | Failed deployment still renders domain handoff, four explanatory milestone cards, approval heading and an empty execution plan. Technical identifiers and repeated guidance compete with the task. | Use state-specific summaries; move full explanations and evidence behind the existing detail sections. Put failed job and recovery first on failure; review and sign first when awaiting approval. | At 1440×900 and narrow widths, the status, blocker and next action are visible without scrolling through unrelated sections. All existing evidence remains reachable. |
| J10 | P2 | Global navigation remains console-wide while project sections use a mixture of in-page anchors and page links. At the initially observed narrow layout, navigation became a horizontal strip as well as having a drawer trigger. | Establish a stable project context with explicit navigation for overview, deployments, releases, domain/container and settings. Make anchor behavior distinguishable from route navigation; consolidate narrow navigation presentation. | Users retain project context across detail screens, can return to the filtered deployment list and can reach every destination by keyboard and on mobile. |
| J11 | P2 | `LiveRefresh` reconnects SSE and shows connection state, but offers no last-update timestamp or explicit refresh action when the stream is unavailable. | Add freshness information and a manual refresh fallback; consider bounded polling only if needed. | A disconnected stream never leaves an old deployment state looking current; reconnect and refresh preserve the current detail section. |

P0 means a core workflow blocker or missing recovery capability. P1 completes reliable first release
and everyday operation. P2 improves navigation and information hierarchy after the workflow is usable.

## Existing capabilities to retain

- Build/upload/verification/live distinctions and the current-release versus historical-record distinction.
- Deployment plan, file and transaction evidence, event timeline and evidence export.
- Release comparison, project settings, budgets, approval policy, members, audit and notifications.
- Name activation, operator session information, wallet signing and manual signature fallback.
- Existing confirmation dialogs, filters, pagination, translations and responsive behavior.

Several older design notes list sorting, pagination, settings anchors and a mobile drawer as missing.
The current source already has implementations for these. Their presence should not be reported as
a new feature gap; validate their behavior rather than rebuilding them.

## Delivery order

1. Complete activation wallet connection and the build log/trigger/retry path (J01–J02).
2. Complete first-release setup, pre-sign review, exact costs, site availability and recovery
   (J03–J08).
3. Refine state-specific density, project navigation and live-data freshness (J09–J11).

Do not add a GitLab-sized feature set merely to match its appearance. Multiple environments,
preview deployments, secret storage, custom domains and automatic production promotion require
separate product and backend decisions. Static-build support and the current signing model remain
the boundaries for this iteration.

## Next verification scenarios

- First-time account with no installation, inaccessible repository or no opened container.
- Create project, configure path policy, push once and observe a real build/job correlation.
- Fail a build, inspect logs and create a fresh attempt without duplicating the old attempt.
- Connect directly from Container using an injected wallet and, separately, WalletConnect.
- Wrong owner, wrong network, signature rejection and expired approval.
- Approve and execute within a known fee cap; inspect receipts separately from estimates.
- Interrupt upload or verification and exercise the documented recovery behavior.
- Verify chain release, activate name, visit the public URL and inspect renewal status.
- Repeat the key paths at 390px and 1440px, keyboard-only, in both supported locales.

These are proposed acceptance scenarios, not tests claimed to have passed in this audit.

## Source references

- `apps/web/components/new-project-form.tsx`
- `apps/web/app/projects/[id]/page.tsx`
- `apps/web/app/projects/[id]/settings/page.tsx`
- `apps/web/app/deployments/[id]/page.tsx`
- `apps/web/components/wallet-actions.tsx`
- `apps/web/components/bind-name-form.tsx`
- `apps/web/app/containers/[address]/page.tsx`
- `apps/web/lib/format.ts`
- `apps/web/components/live-refresh.tsx`
- `apps/web/app/webhooks/page.tsx`
- `apps/api/src/routes/deployments.ts`
- `apps/api/src/routes/projects.ts`
