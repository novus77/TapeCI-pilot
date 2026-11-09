# Installation events and reconciliation

GitHub is authoritative for installation lifecycle. TapeCI consumes `installation`
webhooks for immediate changes and runs a periodic reconciler as a backstop.

## Webhook events

Subscribe the GitHub App to **Installation** events (in addition to **Push**).

| `action` | TapeCI effect |
|---|---|
| `created` | upsert installation (clears deleted/suspended state); membership is added by the setup callback |
| `suspend` | set `suspended_at`; plan/deploy/verify refuse with `AUTH_REVOKED` |
| `unsuspend` | clear `suspended_at` |
| `deleted` | set `deleted_at` (soft delete); worker refuses with `AUTH_REVOKED` |
| `new_permissions_accepted` | clear stale suspension, accepted (no other change) |
| unknown | persist delivery with `UNSUPPORTED_INSTALLATION_ACTION`, return 422 |

Delivery handling:

- HMAC is verified over the exact raw body before any write (bad signature → 401, no row).
- `x-github-delivery` is unique in `webhook_deliveries`; replays return `{duplicate:true}` and
  do not re-apply state.
- State changes are applied in one transaction with the delivery audit row.
- Membership rows are **never deleted** by these events; a deleted installation simply stops
  being usable. This keeps audit history and lets a reinstall (same installation id) recover.

The API route is `POST /v1/github/webhook`; the event header selects push vs installation
handling. Push handling is unchanged.

## Reconciler

```
corepack pnpm reconcile:installations
```

The worker also runs it on startup and every `TAPECI_RECONCILE_INTERVAL_SECONDS`
(default 900 s, minimum 60 s) when App credentials are configured:

```
TAPECI_RECONCILE_ENABLED=1
TAPECI_RECONCILE_INTERVAL_SECONDS=900
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=...
```

Semantics:

1. `GET /app/installations` (App JWT, paginated, max 10×100) — any non-2xx aborts the run
   without touching the database.
2. Every listed installation is upserted (account id/login, `suspended_at`, clears
   `deleted_at`).
3. Installations present in the database but absent from GitHub are **soft-deleted**
   (`deleted_at`); rows already soft-deleted are left alone.
4. Result is logged as one JSON line, e.g.
   `{"event":"reconcile","listed":2,"created":0,"updated":2,"markedDeleted":1,"suspended":0}`.
5. Failures are logged (`reconcile_failed`) and retried on the next interval; no partial write.

A GitHub outage can therefore never mark all installations deleted (the list call fails
before the transaction). An intentionally empty list (App uninstalled everywhere) does mark
all local installations deleted, which is the correct mirror.

## Worker guard

Before reading the artifact, the worker resolves the project's installation and refuses
`suspended`/`deleted` rows with `AUTH_REVOKED` (mapped to the `AUTH_REVOKED` deployment
state). This is independent of webhook delivery: even if an event is missed, the scheduled
reconcile flips the row and the next job fails closed.

## Operational notes

- Keep the App's **Installation** event subscription enabled; the reconciler is a backstop, not
  a replacement for immediate suspension handling.
- The reconciler updates installations only. Project access is derived from the installation
  row at job time; no project rows are rewritten.
- Membership cleanup on uninstall is intentionally manual/audit-preserving.
- `installation_repositories` events are not consumed; the repo picker always reads live
  installation repositories, so removed repositories disappear from the picker immediately.
- Run `reconcile:installations` after rotating App credentials or changing the App's
  permissions to re-sync account metadata.

## Verification

```bash
corepack pnpm test:p2 -- tests/p2/api/installation-events.test.ts
corepack pnpm test:p2 -- tests/p2/api/reconcile.test.ts
corepack pnpm test:p2 -- tests/p2/worker/installation-guard.test.ts
```

The tests use an ephemeral Postgres database and injected GitHub fetch responses; no real App
credentials are needed.
