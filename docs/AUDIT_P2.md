# P2 code + console audit (pre-mainnet RC)

Date: 2026-10-20
Scope: P2-01…P2-09 (API, GitHub App/OAuth, webhook, OIDC/build tokens, artifact ingest,
queue/worker/rollback, approvals, wallet, rate limit/audit, metrics, console).
Method: `requesting-code-review` + `verification-before-completion`, manual diff review of
`3027aca..HEAD`, route/auth walk-through, dependency audit (`pnpm audit --prod`), web build
and Playwright E2E. Two read-only/UI subagents were dispatched; both terminated without a
report, so the findings below are the Lead's own review.

## Fixed in this pass

| Severity | Finding | Fix |
|---|---|---|
| Important | No `trustProxy`: behind a reverse proxy every request shares the proxy IP, collapsing per-IP rate limits and corrupting audit IPs | `TAPECI_TRUST_PROXY` (true / hop count) wired into Fastify `trustProxy`; env test |
| Important | `TAPECI_DEV_AUTH=1` could be enabled in production, minting a dev user for anyone | `loadEnv` now refuses dev auth when `NODE_ENV=production`; env test |
| Important | Worker deploy trusted the stored approval owner; after an on-chain ownership transfer it could attempt writes as a non-owner | worker re-checks `plan.signerIsHolder` and fails with `NOT_CURRENT_OWNER` before any write |
| Minor | GitHub ingest/OIDC errors (`TAR_*`, `OIDC_*`, `BUILD_TOKEN_*`) were returned as `500 INTERNAL` | typed mapping to 413/422/401/409/502 (`apps/api/src/errors.ts`) + tests |
| Minor | No browser hardening headers | API `nosniff`/`DENY`/`no-referrer`/`no-store`; Next `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP |
| Minor | Console nav/search used ad-hoc unicode glyphs | `lucide-react` icons (nav + search), dependency added |
| Minor | User menu was a `<details>` element without keyboard menu semantics | Radix `DropdownMenu` (`user-menu.tsx`) with labels, separator and Sign out item |
| Minor | 7 axe serious/critical violations: low-contrast theme leftovers (`#d3e8f7`, `#fb7185`, links 4.32:1) and non-focusable scrollable tables | dark, readable tokens; `color: inherit` for dark-theme `code` leftovers; scrollable tables are labelled, focusable regions |
| Minor | No CSP for the console | nonce-based CSP middleware (`apps/web/middleware.ts`): strict-dynamic scripts, WalletConnect frame allowances, `object-src 'none'`, `frame-ancestors 'none'`; E2E asserts the header |
| UX | Dead global search input; no refresh for in-flight deployments; no copy/explorer links; execute/rollback had no confirmation; evidence not exportable | search now queries deployments (`?q=`), SSE live refresh, `CopyValue` + OKLink explorer links, Radix confirmation dialogs for execute/rollback, `/deployments/:id/evidence` JSON download |
| UX | No project settings/members, audit log, webhook delivery visibility, notifications or release comparison | added `/projects/:id/settings` (build config + members, owner-only mutations), `/audit`, `/webhooks`, notification bell, `/projects/:id/compare`; new operations API routes |
| UX | Notifications were derived only; no read state. Audit log had no admin view. Archived projects still accepted rollback requests. | migration `0006_notification_reads` + read/unread API/UI; `TAPECI_ADMIN_LOGINS` enables `scope=all` audit; archived projects reject rollback and show a banner (push already filtered) |
| Governance | No project budget, approval policy, or notification channels | migration `0007_governance`: monthly budget enforced at approve/execute, approval role/cap/TTL policy enforced, Slack/email channels with test delivery; settings UI |
| Governance | No organizations/roles, SMTP delivery, or worker lifecycle notifications | migration `0008_organizations`; org owner/admin/member API + console; real nodemailer SMTP delivery + Slack; worker terminal-state notifications (LIVE/failed) |
| Governance | Projects could not belong to an organization; org members had no project access; no org budget/audit | project `organizationId` assignment + inherited access (org owner→owner, admin→maintainer, member→member); migration `0009_organization_budgets`; org budget enforced at approve/execute; project page organization link |
| Audit | Audit rows were not attributable to a project/organization; org audit guessed from current member actors | migration `0010_audit_scope`: nullable `project_id`/`organization_id`, scope resolved from request path, `GET /v1/audit?projectId=` with membership check, org audit filters `organization_id`; in-flight audit writes drained on close |

Dependency audit: `pnpm audit --prod` → **no known vulnerabilities**.

## Reviewed and accepted as-is

- Webhook HMAC over raw bytes, delivery dedup transaction, 202 for push; installation events
  reconcile before DB writes.
- OIDC issuer/audience/JWKS verification, hashed one-time build tokens consumed atomically.
- Tar ingest rejects absolute/`..`/symlink/device entries and enforces size/count/UTF-8 limits
  (real Actions test rejected `./` and AppleDouble `._*` files as designed).
- Per-container queue lock, CAS state transitions, verify retries with fail-closed final state,
  rollback creates a new deployment rather than mutating history.
- Session JWT (HttpOnly/SameSite), OAuth state double-submit, `safeReturnTo` rejects open
  redirects; no `dangerouslySetInnerHTML`; no secrets in logs.
- Project/deployment/installation reads all require membership.

## Remaining gaps (not blockers for a canary, fix before broad production)

1. **WalletConnect relay** and **EIP-1271 with a live Safe** are unit-tested only.
2. **S3/R2** verified against a fake S3 endpoint, not a real bucket; KMS/secret manager not wired.
3. **Audit retention** and a query UI are not implemented; metrics are per-process (scrape with
   multiple replicas aggregated by Prometheus).
4. **Metrics endpoint** is public unless `TAPECI_METRICS_TOKEN` is set — set it in production.
5. **CSP** is nonce-based in production; the WalletConnect iframe/relay path was not exercised under CSP (mock console only).
7. **P2-10 mainnet** remains blocked on budget/container/operator authorization; no mainnet
   write has been made.

## Verification

| Command | Result |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test:unit` | PASS (266) |
| `pnpm test:p2` | PASS (199) |
| `pnpm --filter @tapeci/web build` | PASS |
| `pnpm test:e2e` | PASS (26: 13 console + 12 axe + 1 CSP) |
| `pnpm audit --prod` | no known vulnerabilities |
