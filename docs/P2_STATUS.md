# P2 status — GitHub App, OIDC artifacts, database, workers, console

**Date:** 2026-10-19
**Scope:** P2-01 … P2-09. **P2-10 (real mainnet deploy/rollback) is NOT executed** — it needs
explicit budget authorization and a funded operator wallet.
No real GitHub App credentials, no secrets, no mainnet writes.

---

## 1. Matrix

| Task | Status | Evidence |
|---|---|---|
| P2-01 PostgreSQL schema + Drizzle | **Implemented** | 15 DB tests: fresh migrations, idempotent up, 0002 down preserves baseline audit rows, refusal on missing down file, Drizzle CRUD/JSONB/numeric/enum/check, partial unique indexes (one chain writer, one current release), information_schema↔Drizzle parity for 17 tables |
| P2-02 GitHub App OAuth/installation | **Implemented (code + mocked E2E)** | OAuth login with signed session cookie, logout, signed OAuth/install state double-submit, App JWT + **cached installation tokens**, installation setup sync, **multi-tenant installation membership** (setup links user → installation; list/repo picker/project creation enforce it), console `/login` and wizard repo picker; **installation lifecycle webhooks** (`created/suspend/unsuspend/delete`) with delivery dedup and a **periodic reconciler** against `GET /app/installations` (`reconcile:installations`, worker timer); worker refuses suspended/deleted installations with `AUTH_REVOKED`. Covered by OAuth (4), installation-event (2), reconcile (2) and worker-guard (2) tests. **Live-verified 2026-10-20** with a real App (`tapeci-local-12e350`): OAuth login, installation sync, 43 repositories, webhook HMAC, and real GitHub Actions OIDC → build token → artifact upload → PLAN_READY (self-hosted runner due blocked tunnels). See `docs/P2_GITHUB_APP.md` and `docs/evidence/logs/p2-github-live.log` |
| P2-03 Webhook HMAC + dedup | **Implemented** | HMAC-SHA256 timing-safe verification; 10 replays → 1 deployment (delivery-id unique + source_event_key); unauthorized repo/suspended installation rejected; API returns 202/200/401/422 |
| P2-04 Actions OIDC artifact report | **Implemented + live-verified** | OIDC issuer/audience/expiry/claim checks with injectable JWKS; one-time HS256 build token with atomic consume/replay rejection; API `/v1/builds/token` + `/v1/builds/artifacts` |
| P2-05 Artifact ingest + storage | **Implemented** | Safe tar ingest rejects absolute/`..`/symlink/hardlink/FIFO/device/duplicates, >8.4 MB per file, >64 MiB total, >5000 entries; content-addressed object store with **local filesystem or S3-compatible (AWS S3/R2/MinIO)** backends, SHA-256 verified on put/get; DB rows + `BUILT` transition + plan job enqueue |
| P2-06 BullMQ state machine + worker | **Implemented** | PRD §6.2 transition map with CAS + events, per-container Redis lock, plan/deploy/verify queues (jobId=deploymentId), retry→state mapping, **long-running worker process with real plan/deploy/verify handlers** (`apps/api/src/worker.ts`, `worker/runtime.ts`), and an **Anvil-fork full-stack test** (webhook → OIDC artifact → plan → execute → verify → LIVE) plus **rollback to a stored release** through the deploy worker. 44 queue tests + 2 fork pipeline tests; worker health/metrics endpoints (`/healthz`, `/readyz`, `/metrics`) with Prometheus counters and queue gauges (see [`P2_OPERATIONS.md`](./P2_OPERATIONS.md)) |
| P2-07 Wallet challenge / container binding | **Implemented (API-level)** | Challenge message + signature verification + one-shot consume; wallet row binding; container binding resolves live chain owner/opened state through two operators; UI shows TTL/ownership risk. No browser wallet connector |
| P2-08 Temporary operator + approval | **Implemented** | EIP-712 Approval struct incl. deployment/manifest/container/cost cap/nonce/expiry; digest/scope/cap/expiry/signature validation; approval persistence + operator session TTL/revoke/owner-change checks; API approve → APPROVED, execute → queued (202); rollback deployments require the same approval + operator session; **browser wallet approval** (Wagmi injected + optional WalletConnect, EIP-712 signing, owner/expiry/cap checks, **EIP-1271 contract-owner/multisig** fallback) with API-issued payload; live E2E injects an EIP-1193 provider and signs a real payload |
| P2-09 Console (six pages) | **Implemented** | Next.js 16 App Router with a GitLab Pajamas-inspired light theme (dark top bar, left navigation, purple primary actions, GitLab badges/tables/cards): `/`, `/projects/new`, `/projects/[id]`, `/deployments`, `/deployments/[id]`, `/containers/[address]`; four distinct states (Build Success / Uploaded / Verified / Live); mock mode (E2E 11/11) and **live API mode smoke** against a real Fastify/Postgres backend (4/4, including signed-in user menu + logout); top bar shows the real session user |
| P2-10 Mainnet E2E + RC | **CANARY + RC + ROLLBACK EXECUTED 2026-10-25** | Real X Layer canary on container `0xC0B4…B814`: 2 putFile txs, actual fee 0.00001088 OKB (cap 0.0000158), two-operator verification at pinned block 74093811, state LIVE. Evidence: `docs/evidence/p2-10-mainnet-canary.json`, `p2-10-rollback-drill.json`. RC (commit d695898) reached LIVE, then rolled back to canary; rollback tx recorded and dual-RPC VERIFIED at 74096788. | No mainnet write. Read-only budget plan with current gas price, scenario costs, hard caps and gas-price guard: [`P2-10_BUDGET.md`](./P2-10_BUDGET.md). Awaiting tier/cap/wallet authorization |

## 2. Architecture added

```
apps/api        Fastify service: dev auth, projects, deployments/events/plan, approvals/execute,
                wallet challenges, GitHub webhook, OIDC build tokens, artifact ingest, containers
apps/web        Next.js console (mock mode for E2E, typed API client for real mode)
packages/database  Drizzle schema + SQL migrations + ephemeral-DB test helpers
packages/github    GitHub App JWT/installation tokens, webhook HMAC+dedup, OIDC/build tokens,
                   safe tar ingest + local object store
packages/queue     PRD state machine (CAS + events), Redis container lock, BullMQ queues/workers,
                   wallet challenge auth, EIP-712 approval + operator sessions
infra/docker-compose.p2.yml   PostgreSQL 16 + Redis 7 for local tests
```

API contract: [P2_API.md](./P2_API.md). Local env: [.env.example](../.env.example).
Observability: API and worker expose Prometheus metrics/readiness; see
[P2_OPERATIONS.md](./P2_OPERATIONS.md).

## 3. Verification

```bash
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"

corepack pnpm db:up            # docker compose: Postgres 55432, Redis 56379
corepack pnpm db:migrate       # DATABASE_URL=postgres://tapeci:tapeci@127.0.0.1:55432/tapeci
corepack pnpm seed:p2          # demo user/project/deployments for the console
corepack pnpm typecheck        # PASS
corepack pnpm lint             # PASS
corepack pnpm test:unit        # PASS 266/266 (P0/P1)
corepack pnpm test:p2          # PASS 161/161 (DB/API/GitHub/queue)
corepack pnpm --filter @tapeci/web build  # PASS (Next 16 production build)
corepack pnpm test:e2e         # Playwright 11/11 (mock fixtures, chrome channel)
corepack pnpm test:p2:fork     # Anvil fork: API + BullMQ workers → LIVE + rollback
corepack pnpm test:e2e:live    # live API/console smoke 3/3 (no mock)
corepack pnpm typecheck:web    # web tsconfig typecheck
```

Screenshots: [`console-overview.png`](./evidence/screenshots/console-overview.png),
[`console-deployments.png`](./evidence/screenshots/console-deployments.png) and
[`console-deployment-live.png`](./evidence/screenshots/console-deployment-live.png).

Evidence log: `docs/evidence/logs/p2-checks.log` (all checks exit 0). Local services are Docker
containers; tests create and drop ephemeral databases; no leftover keys/queues. CI has a
`p2-integration` job with PostgreSQL + Redis services (`.github/workflows/ci.yml`).

## 4. Security notes

- Dev auth (`TAPECI_DEV_AUTH=1`) is explicitly labelled; production must implement GitHub OAuth.
- Webhook signatures are verified over the raw bytes before any DB write; unauthenticated
  deliveries persist nothing.
- OIDC tokens are checked against GitHub issuer/audience/JWKS before issuing a one-time build
  token; artifact bodies are size/entry/path validated before extraction, then re-scanned.
- Approvals bind deployment + manifest + container + cost cap + nonce + expiry; operator sessions
  are TTL/revocation checked; chain writes are serialized per container by a Redis lock and a DB
  partial unique index.
- No private keys are stored; dev wallet flows use test-generated keys. Mainnet signing is not
  enabled by this round.

## 5. Known gaps / next

1. **Live GitHub App**: no App credentials in this environment, so install/OAuth, the real
   installations API and a repo-picker are unit-tested only.
3. **Object store**: local filesystem adapter only; S3/R2 adapter is a deployment decision.
4. **Console wallet**: the browser console does not hold keys; real approvals use the CLI or
   wallet integration. A Wagmi connector is follow-up work. The create-project wizard cannot derive
   `githubRepositoryId` without a repo-picker endpoint (P2-02 live GitHub App).
5. **P2-10**: blocked on budget authorization. Nothing in this round marked a real release LIVE.

## 4. Update 2026-10-24 — governance, audit, deployment baseline

- Organizations/roles with inherited project access, project budgets and approval policies,
  Slack/email notification channels, notification read state, audit scope binding
  (`project_id`/`organization_id`, migration 0011 `path` + backfill), webhook delivery view,
  release comparison, SSE live refresh and JSON evidence export.
- Operations: scheduled audit backfill (worker interval + systemd timer), Prometheus alerts,
  Docker/K8s/Grafana baseline, kustomize/kubeconform CI, gitleaks + SBOM + dependency review
  (CodeQL skipped on this private repo without GHAS).
- X Layer factory implementation changed on the 2026-10-22 freeze: TapeCI now allowlists both
  `0xb41c1e…293d` (current) and `0x7495…d17b` (previous). Mainnet read-only 20/20 and fork 43/45
  (2 skipped) pass; see `docs/evidence/implementation-update-2026-10-22.md`.
- Still blocked: P2-10 needs an opened X Layer container, budget tier, owner/operator wallets,
  execution window and rollback target. No mainnet write has been made.
