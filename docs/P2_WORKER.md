# P2-06 worker process

Long-running BullMQ worker that turns a stored artifact into a verifiable Live
release. Run with `corepack pnpm worker:dev`.

```
GitHub webhook ─► deployment RECEIVED
Actions OIDC ──► build token ─► tar artifact ─► BUILT (+ plan job)
plan worker ───► artifact tar → prepareVersionedRelease → planRelease → PLAN_READY
owner approval ─► APPROVED (+ operator session)
execute API ───► deploy job
deploy worker ─► executeRelease (assets first, entry last) → VERIFYING_RELEASE (+ verify job)
verify worker ─► verifyRelease (chain bytes + journal) → LIVE only if releaseMatch

rollback API ──► deployment PLAN_READY (target release + artifact key)
approval ─────► APPROVED
deploy worker ─► switchEntryToRelease(target assets verified) → VERIFYING_RELEASE
verify worker ─► chain-only verification → target release isCurrent=true
```

## Files

| File | Purpose |
|---|---|
| `apps/api/src/worker.ts` | process entrypoint: env → DB → runtime → `startWorkers` |
| `apps/api/src/worker/runtime.ts` | real `plan` / `deploy` / `verify` handlers |
| `packages/queue/src/workers.ts` | queue mechanics, retries, per-container Redis lock |
| `tests/fork/p2-pipeline.test.ts` | API + BullMQ + Anvil-fork end-to-end test |
| `apps/web/playwright.live.config.ts` + `e2e-live/` | live-mode console smoke (real API, no mock) |
| `scripts/p2/live-console-server.ts` | ephemeral DB + seeded Fastify API for the live smoke |

## Runtime / environment

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL 16 |
| `REDIS_URL` | yes | BullMQ/Redis (`redis://127.0.0.1:56379` locally) |
| `SESSION_SIGNING_SECRET` | yes | sessions/build tokens |
| `TAPECI_OPERATOR_PRIVATE_KEY` | for deploy/verify writes | operator key; never committed |
| `TAPECI_WRITE_RPC_URL` | no | write RPC (defaults to first configured X Layer operator) |
| `TAPECI_JOURNAL_DIR` | no | journal directory (`.tapeci/journal`) |
| `OBJECT_STORE_DIR` | no | content-addressed artifact store (`.tapeci/objects`) |
| `TAPECI_RPC_OKX` / `TAPECI_RPC_DRPC` | no | operator endpoint overrides (fork/live tests) |

Without a key, `plan` and `verify` still run; `deploy` fails closed with
`INVALID_CONFIG`. The worker never signs with a browser wallet and never falls
back to a different container/chain.

## Handler semantics

- **plan**: accepts `BUILT`/`VALIDATING`; re-extracts the stored tar with the same
  path/symlink/size/entry limits as ingest, regenerates the deterministic
  manifest, pins a block, stores `plan_json` + `release_files`, and transitions
  `BUILT → VALIDATING → PLAN_READY` (or `PLAN_REJECTED` with reasons).
- **deploy**: only `APPROVED`/`UPLOADING_ASSETS`/`SWITCHING_ENTRY`; checks an
  active approval and operator session, re-plans against the same manifest,
  enforces the approved cost cap, executes the journaled release (assets first,
  entry last) and advances to `VERIFYING_RELEASE`. A crash resumes the same
  journal; completed journals replay without duplicate transactions.
- **verify**: only `VERIFYING_RELEASE`; reads chain bytes through the configured
  operators and cross-checks the journal. `LIVE` is written only when
  `verifyRelease(...).releaseMatch === true`. A mismatch is retried within the
  BullMQ attempt budget (transient RPC reads); only the final attempt moves the
  deployment to `VERIFY_FAILED`, so a genuine mismatch still fails closed.
- **rollback**: a deployment with `trigger_kind=rollback` starts at `PLAN_READY`
  with the target release's artifact key copied from its original deployment. It
  re-prepares the deterministic manifest, checks the approval/operator session,
  verifies the target assets on chain via `switchEntryToRelease`, writes the entry
  last, then verifies and marks the stored release current again.
- All handlers skip terminal/other states, and the queue layer owns retries +
  the one-writer-per-container Redis lock.

## Run locally

```bash
export COREPACK_HOME=$PWD/.corepack
export PATH="$HOME/.npm-global/bin:$PATH"

corepack pnpm db:up
DATABASE_URL=postgres://tapeci:tapeci@127.0.0.1:55432/tapeci corepack pnpm db:migrate
corepack pnpm api:dev      # terminal 1
corepack pnpm worker:dev   # terminal 2 (needs TAPECI_OPERATOR_PRIVATE_KEY for writes)
corepack pnpm web:dev      # terminal 3, without NEXT_PUBLIC_TAPECI_MOCK
```

## Verification commands

```bash
corepack pnpm test:p2:fork   # Anvil fork: API + BullMQ plan/deploy/verify → LIVE, then rollback
corepack pnpm test:e2e:live  # real API + seeded DB + Next console (no mock fixtures)
```

The fork test injects an impersonated fork owner wallet (the container owner is a
real NFT holder on the fork, so no private key exists) and seeds the approval row
directly. The EIP-712 approval route itself is covered by
`tests/p2/api/flows.test.ts`. The fork uses one operator (`allowSingleOperator`)
because a local node is not two independent RPC providers; production verification
keeps the two-operator requirement.

## Known limits

- The worker does not maintain a live RPC health loop; a chain reorg pauses the
  next job through the normal fail-closed state mapping.
- Fork/live smoke tests are local/evidence runs (they need Docker + Anvil +
  network); the CI `p2-integration` job intentionally runs only DB/API/GitHub/queue.
- **P2-10 (mainnet) remains blocked on budget authorization.** No mainnet writes
  were made by this work.
