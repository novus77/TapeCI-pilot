# TapeCI — GitHub push → Verifiable DeWEB on X Layer

TapeCI builds a static site from a fixed Git commit, generates a deterministic release
manifest, uploads the files to TapeOut's on-chain `SiteRegistry` in 24,000-byte chunks,
verifies the bytes against the chain through **two independent RPC operators at one
pinned block**, and switches the `index.html` entry in a single final transaction.

This repository implements the delivery package `TapeCI_PRD_Technical_Design.md` in the
mandated order: **P0 (chain verification) first**, then P1 (CLI/deploy engine), then P2
(GitHub App + web console). No mainnet transaction is sent without explicit user approval.

## What the TapeOut ecosystem actually is

- A **processor** is a `Circuits` ERC-721 contract registered in the factory
  (`factory.cpuAt(i)`, append-only, index starts at 0).
- A **circuit** is an NFT (`#ID`) on a processor. Every processor numbers its IDs from 1.
- A **container** is the ERC-6551 account derived from `(chainId, processor, #ID)` via
  `opener.accountOf(...)`. The container holder controls the site; a container must be
  opened with `opener.open(...)` before files can be written.
- A **site** is the set of `(container, path)` entries in `SiteRegistry`. Each file
  records size, content type, a **raw SHA-256** of the bytes, and a chunk count.
- Files use `putFile` (chunk 0, replaces the whole file) + `appendChunk(expectIndex)`
  (24,000 bytes each, max 350 chunks / 8,400,000 bytes).
- Readers pin one block and require two RPC operators to return exactly the same bytes;
  disagreement is rejection, never a majority vote (TapeKit SPEC §4).
- X Layer is chainId **196**, area code **2**, so names look like `2.2.0.tape`
  (`#2 @ processor 0`). BNB has no area code.

## P0 status — complete, GO for P1 (2026-10-19)

P0-01 … P0-06 are executed and evidenced; **P0-07 (real-money mainnet smoke test) is not run**
and requires explicit user authorization with a fee cap. Verdict and the full pass/fail matrix:
[`docs/P0_DECISION.md`](docs/P0_DECISION.md). Evidence index:
[`docs/evidence/README.md`](docs/evidence/README.md).

Result in one line: **GO for P1** (CLI/deploy engine, no real-money writes), **NO-GO for real
publishing** until P0-07 conditions are met. `corepack pnpm test` → 77/77 tests, `pnpm lint` and
`pnpm typecheck` clean.

## P1 status — complete (P1-01…P1-09)

Offline, reproducible foundations for the CLI are in place: CI workflows, strict `.tapeci.json`
config, safe static artifact scanning (traversal/symlink/size/off-chain-reference policy) and
deterministic release manifests, a read-only chain-diff/fee planner (`pnpm plan`), and
crash-tolerant journaled execution with a serialized nonce lock, and release-aware
verification reports (chain bytes + journal vs manifest), single-transaction entry
cutover/rollback with a local release store, and an end-to-end CLI
(`init/build/validate/plan/deploy/verify/rollback`). Unit suite: **266 tests**.
Full status/APIs: [`docs/P1_STATUS.md`](docs/P1_STATUS.md); planning:
[`docs/P1_PLAN.md`](docs/P1_PLAN.md); journal/resume: [`docs/P1_JOURNAL.md`](docs/P1_JOURNAL.md);
release verification: [`docs/P1_RELEASE_VERIFICATION.md`](docs/P1_RELEASE_VERIFICATION.md);
cutover/rollback: [`docs/P1_ENTRY_CUTOVER.md`](docs/P1_ENTRY_CUTOVER.md); CLI:
[`docs/P1_CLI.md`](docs/P1_CLI.md). No mainnet writes have been made; P0-07 still needs a budget
authorization.

## P2 status — GitHub App, OIDC artifacts, DB, queues, console (P2-01…P2-09)

Backend, worker and console are implemented: PostgreSQL/Drizzle schema + migrations, GitHub App
auth and HMAC/dedup webhooks, GitHub Actions OIDC build tokens, safe tar artifact ingest + object
store, the PRD state machine with BullMQ queues and a per-container Redis lock, a long-running
worker with real plan/deploy/verify/rollback handlers (proven on an Anvil fork end-to-end), wallet
challenges, EIP-712 approvals with temporary operator sessions, and a six-page Next.js console
(GitLab Pajamas-inspired light theme) with mock-mode and live-mode Playwright E2E; governance
(organizations/roles, budgets, approval policy, notification channels), audit scope/backfill,
webhook deliveries, release comparison, SSE and evidence export. Test evidence: **266** P0/P1 unit tests, **199** P2 tests (DB/API/GitHub/queue/OAuth/env/metrics/S3/installation-reconcile/contract-approval/rate-limit/audit), web
production build and browser E2E. P2-10 (real mainnet deploy/rollback) remains **blocked on an opened X Layer container and budget
authorization**. Current snapshot: [`docs/STATUS.md`](docs/STATUS.md). Full matrix and gaps: [`docs/P2_STATUS.md`](docs/P2_STATUS.md); API contract:
[`docs/P2_API.md`](docs/P2_API.md); GitHub App setup:
[`docs/P2_GITHUB_APP.md`](docs/P2_GITHUB_APP.md); P2-10 budget:
[`docs/P2-10_BUDGET.md`](docs/P2-10_BUDGET.md); worker health/metrics:
[`docs/P2_OPERATIONS.md`](docs/P2_OPERATIONS.md); object storage:
[`docs/P2_OBJECT_STORE.md`](docs/P2_OBJECT_STORE.md); installation lifecycle:
[`docs/P2_INSTALLATION_RECONCILE.md`](docs/P2_INSTALLATION_RECONCILE.md); browser wallet approval:
[`docs/P2_WALLET_APPROVAL.md`](docs/P2_WALLET_APPROVAL.md). No mainnet writes were made.

## Repository layout

```
packages/shared      hashing (raw SHA-256), canonical paths, chunking, deterministic JSON
packages/config      X Layer chain config, pinned implementations, RPC operators, TapeKit pin,
                     .tapeci.json schema/loaders
packages/validator   safe static artifact scanning (paths, symlinks, sizes, off-chain refs)
packages/artifact    deterministic release manifest v1 (artifactDigest, releaseManifestHash)
packages/chain       ABIs, viem clients, ERC-1967 pinning, container identity, registry reads
packages/deployer    chunk upload engine (putFile/appendChunk), prefix reconciliation, verification
packages/verifier    multi-operator pinned-block verification reports
packages/release     versioned entry rewrite, release store, cutover and rollback
packages/cli         tapeci init/build/validate/plan/deploy/verify/rollback
packages/database    PostgreSQL schema (Drizzle) + SQL migrations + ephemeral-DB test helpers
packages/github      GitHub App JWT, webhook HMAC/dedup, OIDC/build tokens, safe tar ingest
packages/queue       PRD state machine, Redis container lock, BullMQ queues/workers,
                     wallet challenges, EIP-712 approvals + operator sessions
apps/api             Fastify P2 API (projects, deployments, approvals, webhook, artifacts)
apps/web             Next.js console (dashboard, wizard, projects, deployments, containers)
scripts/probe        P0-01/02/03 evidence collector
scripts/fork         P0-04/05 Anvil-fork authorization and upload matrix
scripts/verify       P0-06 multi-operator verification evidence
tests/unit           offline tests
tests/mainnet        read-only mainnet tests
tests/fork           Anvil-fork tests
tests/p2             PostgreSQL/API/GitHub/queue integration tests
infra                docker-compose for PostgreSQL 16 + Redis 7
tests/fixtures       static-site fixture for the scan → manifest pipeline
docs/evidence        machine-readable and human-readable P0 evidence
```

## Toolchain

Node.js ≥ 22, pnpm 9.15.4 (via Corepack), TypeScript strict, Vitest, viem 2.x, Anvil/Forge
1.7.x. Everything in this repo is ESM.

```bash
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"
corepack pnpm install
corepack pnpm test          # P0/P1 unit + mainnet + fork tests
corepack pnpm lint
corepack pnpm typecheck

# P2 local services
corepack pnpm db:up         # PostgreSQL :55432, Redis :56379
DATABASE_URL=postgres://tapeci:tapeci@127.0.0.1:55432/tapeci corepack pnpm db:migrate
corepack pnpm test:p2       # DB/API/GitHub/queue (161 tests)
corepack pnpm --filter @tapeci/web build
corepack pnpm test:e2e      # Playwright (system Chrome)
corepack pnpm api:dev       # Fastify on :8787 (TAPECI_DEV_AUTH=1)
corepack pnpm worker:dev    # BullMQ worker (plan/deploy/verify)
corepack pnpm web:dev       # Next console on :3000
corepack pnpm test:p2:fork  # Anvil fork full pipeline → LIVE
corepack pnpm test:e2e:live # live API + console smoke
corepack pnpm budget:p2     # read-only P2-10 budget snapshot
```

RPC endpoints default to the public X Layer set in `packages/config`; override with
`TAPECI_RPC_OKX` / `TAPECI_RPC_DRPC`. Fork tests start a local Anvil fork of X Layer and
never broadcast to a public chain.

## Security red lines (from the delivery package)

- Never store a user's main-wallet private key, and never commit secrets.
- Never call a normal GitHub Actions build a "cryptographically provable build".
- Never mark a site LIVE because a receipt succeeded; verify bytes at a pinned block.
- Fail closed on implementation drift, RPC disagreement, ownership change, revoked
  permission, or fee-budget overflow.
- Do not import BNB Chain addresses/fees/API assumptions into X Layer.
- Never fabricate on-chain evidence. A mock passing is not a mainnet pass.
- One in-flight chain-writing deployment per container; duplicate webhooks must be idempotent.

## Pinned sources

- TapeKit `SPEC.md` v0.2 and `kernel/src/config.js` at commit
  `40994bd65baedbda4df72cb0985031a5f082f606` (2026-10-11).
- X Layer addresses and implementation allowlist are in `packages/config`; every run
  re-reads the ERC-1967 slot and refuses to write if it is not on the allowlist.
