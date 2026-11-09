# API/worker health and metrics

Both processes expose a small HTTP surface for liveness, readiness and Prometheus
scraping. No external agent or metrics SDK is required.

| Process | Endpoints | Default |
|---|---|---|
| worker | `/healthz`, `/readyz`, `/metrics` | `127.0.0.1:8788` |
| API | `/health`, `/readyz`, `/metrics` | API port (8787) |

The API `/metrics` endpoint is public by default for loopback/sidecar deployments; set
`TAPECI_METRICS_TOKEN` to require `Authorization: Bearer <token>` when the API is exposed more
broadly. The worker binds loopback and should also be scraped through an internal sidecar.

```
TAPECI_WORKER_HOST=127.0.0.1   # default loopback
TAPECI_WORKER_PORT=8788        # default
corepack pnpm worker:dev
```

| Endpoint | Purpose | Status codes |
|---|---|---|
| `GET /healthz` | process liveness only (does not touch DB/Redis) | 200 |
| `GET /readyz` | Postgres `SELECT 1`, Redis `PING`, BullMQ job counts | 200 ready / 503 not ready |
| `GET /metrics` | Prometheus text exposition | 200 (gauges show dependency state) |

Readiness checks are wrapped in a 2 s timeout so a hung dependency cannot hang the
probe. `/healthz` is intentionally dependency-free: a Redis outage should take the
worker out of rotation, not restart-loop it.

## Rate limiting and audit

- `TAPECI_RATE_LIMIT_PER_MINUTE` (default **600**, per IP + route, fixed 60 s window) and
  `TAPECI_RATE_LIMIT_DISABLED=1` for local load tests. Health/readiness/metrics and the GitHub
  webhook are exempt so probes and deliveries are never dropped. A rejected request returns
  `429 RATE_LIMITED` with `Retry-After`. The limiter is in-process; put a shared limiter at the
  edge for multi-instance deployments.
- `TAPECI_RATE_LIMIT_BACKEND=redis` shares one fixed window across API instances using a
  single Lua script (`INCR` + `PEXPIRE`). On Redis errors it falls back to the in-process
  limiter, logs `rate_limit_redis_fallback`, and keeps serving (per-instance protection
  during an outage). Default backend is `memory` for tests/single-node.
- Mutating requests (`POST/PUT/PATCH/DELETE`) emit one JSON line to stdout **and** write a row
  to `audit_events`:
  `{"audit":{"event":"http_mutation","requestId":…,"method":…,"route":…,"status":…,"actorUserId":…,"githubLogin":…,"ip":…,"userAgent":…}}`.
  Bodies, query strings, cookies, tokens and signatures are never logged. Disable with
  `TAPECI_AUDIT_LOG=0`; ship stdout to your log store/SIEM. `/v1/github/webhook` posts are
  included (actor is null).
- `audit_events` is append-only with indexes on `created_at` and `(actor_user_id, created_at)`.
  There is no automatic retention: configure a periodic delete/partition policy (e.g. keep
  90 days) in your database operations. Inserts are best-effort: a DB failure logs
  `audit_persist_failed` and never fails the API request.

## Worker metrics

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `tapeci_worker_up` | gauge | — | process running (1) |
| `tapeci_worker_start_time_seconds` | gauge | — | process start time |
| `tapeci_worker_uptime_seconds` | gauge | — | uptime |
| `tapeci_worker_ready` | gauge | — | all readiness checks pass |
| `tapeci_worker_dependency_ready` | gauge | `dependency=postgres\|redis` | per-dependency readiness |
| `tapeci_worker_jobs_total` | counter | `queue`, `status=started\|completed\|failed` | jobs observed by this process |
| `tapeci_worker_job_duration_seconds_sum` | counter | `queue` | total handling time |
| `tapeci_worker_job_duration_seconds_count` | counter | `queue` | completed jobs (duration count) |
| `tapeci_worker_job_failures_total` | counter | `queue`, `code` | failures by `TapeCiError` code |
| `tapeci_worker_last_job_timestamp_seconds` | counter | `queue` | last finished job (unix) |
| `tapeci_queue_jobs` | gauge | `queue`, `state=waiting\|active\|completed\|failed\|delayed\|paused` | BullMQ counts |
| `tapeci_worker_reconcile_runs_total` | counter | — | installation reconciliation runs |
| `tapeci_worker_reconcile_failures_total` | counter | — | failed reconciliation runs |
| `tapeci_worker_reconcile_last_success_timestamp_seconds` | gauge | — | last successful run |
| `tapeci_worker_reconcile_last_duration_seconds` | gauge | — | duration of the last run |
| `tapeci_worker_reconcile_last_listed` / `_created` / `_updated` / `_marked_deleted` / `_suspended` | gauge | — | last reconcile result counts |

## API metrics

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `tapeci_api_up` | gauge | — | API process running |
| `tapeci_api_start_time_seconds` / `tapeci_api_uptime_seconds` | gauge | — | process lifetime |
| `tapeci_api_ready` | gauge | — | DB + Redis readiness |
| `tapeci_api_dependency_ready` | gauge | `dependency=postgres\|redis` | per dependency |
| `tapeci_api_http_in_flight` | gauge | — | requests being handled |
| `tapeci_api_http_requests_total` | counter | `method`, `route`, `status` | requests by Route pattern |
| `tapeci_api_http_request_duration_seconds_sum` / `_count` | counter | `method`, `route` | request latency |

Health/readiness/metrics requests are excluded from request counters to avoid self-noise.
Route labels are Fastify route patterns (e.g. `/v1/deployments/:id`), not raw URLs, so
cardinality stays bounded. `/readyz` performs a 2 s bounded DB `select 1` and Redis `PING`.

Counters are **process-local** and reset on restart; use `rate()`/`increase()` and a
long-lived scrape target. The queue gauges are read from BullMQ at scrape time, so
they reflect the shared Redis state (including jobs created by other instances).

## Suggested alerts

```promql
# page: worker or API cannot reach dependencies
tapeci_worker_ready == 0 or tapeci_api_ready == 0

# page: reconciliation has been failing
increase(tapeci_worker_reconcile_failures_total[30m]) > 0

# page: API 5xx rate
sum(rate(tapeci_api_http_requests_total{status=~"5.."}[5m])) > 0.1

# page: failures within the last 10 minutes
sum by (queue, code) (increase(tapeci_worker_job_failures_total[10m])) > 0

# page: queue backing up
sum by (queue) (tapeci_queue_jobs{state="waiting"}) > 50

# ticket: no job finished for 6h while jobs are waiting
(time() - max by (queue) (tapeci_worker_last_job_timestamp_seconds)) > 21600
and on(queue) sum by (queue) (tapeci_queue_jobs{state="waiting"}) > 0

# ticket: failed jobs are not being retried/cleared
sum by (queue) (tapeci_queue_jobs{state="failed"}) > 10
```

Do not alert on `tapeci_worker_jobs_total{status="started"}` alone: at-least-once delivery
means a retried job increments it more than once by design.

## Operational notes

- `TAPECI_WORKER_PORT` collision fails startup on purpose; the orchestrator should surface
  the crash rather than run a worker with no health endpoint.
- On `SIGTERM`/`SIGINT` the process closes the health server first, then BullMQ queues,
  workers and the Postgres pool. In-flight jobs are allowed to finish through BullMQ's
  `close()`; the container runtime should grant a termination grace period longer than the
  longest deploy job.
- Keep the endpoint on loopback or behind an authenticated sidecar; `/metrics` contains
  queue/error labels but no secrets, tokens or private keys.
- Readiness is per process. With multiple workers, scrape each instance and alert if the
  **fleet** has no ready instance.
- The API has its own `/health` endpoint; this document covers the worker only.

## Verification

```bash
corepack pnpm test:p2 -- tests/p2/worker   # worker health/metrics
corepack pnpm test:p2 -- tests/p2/api/metrics.test.ts  # API metrics/readiness
corepack pnpm test:p2 -- tests/p2/api/rate-limit.test.ts
corepack pnpm test:p2 -- tests/p2/api/audit.test.ts
```

## Audit retention

`audit_events` is the release evidence trail and has no automatic pruning.

```bash
pnpm audit:retention -- --days 90            # dry run (default)
pnpm audit:retention -- --days 90 --apply    # delete rows older than 90 days
```

The script refuses `--days < 30` unless `--force`, deletes in batches of 1,000 and reports the
eligible/deleted counts. Run it from a scheduled job after the release evidence has been
exported to long-term storage.

## Audit scope backfill

Audit rows written before migration `0011_audit_path` have no concrete request path, so their
project/organization cannot be reconstructed safely. Rows written after 0011 carry `path` (query
strings are stripped); if scope resolution failed (for example a transient DB error), they can be
repaired without guessing:

```bash
pnpm audit:backfill              # dry run: scanned / updated / unresolved / historicalWithoutPath
pnpm audit:backfill -- --apply   # update rows whose path resolves to a project/org
```

`tapeci_audit_scope_resolve_failures_total` on `/metrics` counts resolver failures; alert on it.
Historical rows stay `NULL` unless an operator supplies an external mapping — the script never
invents a scope.

## Audit backfill scheduling and alerts

Two supported schedules:

1. **In-process worker** — set `TAPECI_AUDIT_BACKFILL_INTERVAL_MS=3600000` (minimum 60000).
   The worker runs `backfillAuditScopes({apply:true})` at startup and then on the interval; runs
   never overlap and the timer is cleared on SIGTERM.
2. **System cron/systemd** — `ops/systemd/tapeci-audit-backfill.{service,timer}` runs hourly with
   `--apply --fail-on-unresolved --textfile /var/lib/node_exporter/textfile/tapeci-audit-backfill.prom`.
   A plain cron equivalent:

   ```cron
   17 * * * * cd /opt/tapeci && pnpm audit:backfill -- --apply --fail-on-unresolved --textfile /var/lib/node_exporter/textfile/tapeci-audit-backfill.prom
   ```

Load `ops/prometheus/tapeci-alerts.yml` into Prometheus; it alerts on resolver failures,
unresolved/stale backfills, API/worker down, 5xx ratio and worker job failures. The
`tapeci_audit_backfill_*` metrics come from the textfile collector; the resolver counter comes from
the API `/metrics` endpoint.

## Production deployment baseline (Docker/Kubernetes)

- **Images**: `infra/Dockerfile.{api,worker,web}` (non-root `node`, healthchecks). Build from repo root:
  `docker build -f infra/Dockerfile.api -t tapeci-api:0.1.0 .` (same for worker/web).
- **Compose**: copy `infra/env.prod.example` to `infra/env.prod`, fill secrets (never commit), then
  `docker compose --env-file infra/env.prod -f infra/docker-compose.prod.yml up -d`
  (`--env-file` supplies real values for interpolation and the Postgres container; the file
itself is not committed. `docker compose -f infra/docker-compose.prod.yml config` passes with
placeholders, which is only a syntax check.) API 127.0.0.1:8787, worker health 8788,
  web 3000, Prometheus 9090, Grafana 3001; Postgres/Redis/MinIO stay internal.
- **Kubernetes**: `ops/k8s/*.yaml` (namespace, placeholder Secret, configmap, three Deployments
  with probes/resources/non-root, Services, Ingress, PDBs, NetworkPolicies). Replace the Secret with
  External Secrets/KMS; use managed Postgres/Redis/S3.
- **MinIO image**: the public `minio/minio` image and `dl.min.io` binaries are no longer publicly
  available (Docker Hub 404 / dl.min.io 410). The baseline pins the third-party
  `pgsty/minio@sha256:b6bfe…` build that was pulled and health-checked here. For production, build
  an image from your licensed MinIO binary or private registry and replace the pinned digest.
- **Backfill metrics**: `tapeci_audit_backfill_*` come from the textfile collector. Compose mounts
  `${TAPECI_TEXTFILE_DIR:-../.tapeci/textfile}` into `node-exporter`; the systemd unit writes to
  `/var/lib/tapeout/textfile/tapeci-audit-backfill.prom`, so set `TAPECI_TEXTFILE_DIR=/var/lib/tapeout/textfile`
  on the host (or change the unit path to match). The worker can also run the backfill in-process via
  `TAPECI_AUDIT_BACKFILL_INTERVAL_MS` (already set in `env.prod.example` and the K8s ConfigMap).
- **Observability**: `ops/prometheus/prometheus.yml` scrapes API/worker and loads
  `ops/prometheus/tapeci-alerts.yml`; `ops/grafana/tapeci-dashboard.json` is provisioned by
  `ops/grafana/provisioning/`.

## Real S3-compatible object-store test

`tests/p2/storage/s3-minio.test.ts` starts an S3-protocol server (`s3rver`), signs requests with the
real AWS SDK, and exercises `S3ObjectStore.put/get/delete` (hash verification included):

```bash
pnpm test:s3
```

The same test targets a real S3-compatible endpoint when these are set (MinIO/R2/AWS):

```bash
docker compose -f infra/docker-compose.test.yml up -d
S3_ENDPOINT=http://127.0.0.1:59000 S3_BUCKET=tapeci-artifacts \
S3_ACCESS_KEY_ID=tapeci S3_SECRET_ACCESS_KEY=tapeci-test-secret pnpm test:s3
pnpm s3:check   # same env: put/has/get/delete round-trip, prints status only
```

Without `S3_ENDPOINT` the test starts an in-process `s3rver` (no network/credentials). s3rver
implements the S3 HTTP surface but **does not verify SigV4**; signature correctness is only proven
against a real endpoint. The bucket must already exist for an external endpoint.

## WalletConnect verification

`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` adds the optional WalletConnect connector; blank/absent keeps
injected-only (unit-tested in `tests/p2/web/wallet-connectors.test.ts`). A real relay/QR/device test
requires a WalletConnect Cloud project id and a physical wallet — set the env, rebuild the web app,
open `/deployments/:id` and confirm the connector list; no fake relay is used in CI.

`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is a **build-time** Next.js variable. Docker builds take it
as a build arg (`docker compose ... build --build-arg NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...` or
via `infra/env.prod`); changing it at runtime has no effect. `pnpm walletconnect:check -- --require`
fails when it is missing; without `--require` it reports the connector list.

## Security CI gates

`.github/workflows/security.yml` runs secret scanning (gitleaks), SPDX SBOM, dependency review on
pull requests, and CodeQL. **CodeQL is skipped on private repositories without GitHub Advanced
Security** (it fails with a configuration error otherwise); enable GHAS or make the repository
public to turn it on. The other gates are active.

## Backup and restore drill

```bash
# Postgres custom-format dump + local object-store tarball
scripts/ops/backup-restore.sh backup --database-url "$DATABASE_URL" --out /backups --object-dir "$TAPECI_OBJECT_STORE_DIR"

# Restore into a throwaway database and print row counts (no production touch)
scripts/ops/backup-restore.sh verify --database-url "$DATABASE_URL" --dump /backups/tapeci-<ts>.dump

# Overwrite a database only with an explicit --yes
scripts/ops/backup-restore.sh restore --database-url "$DATABASE_URL" --dump ... --yes
```

S3/R2 buckets are not copied by this script; use bucket versioning/replication or
`aws s3 sync`/`rclone` in the runbook. Test the restore path before every release window.

## Installing the backfill timer

```bash
sudo scripts/ops/install-audit-backfill-timer.sh
# uninstall
sudo scripts/ops/install-audit-backfill-timer.sh --uninstall
```

The unit expects `/opt/tapeci`, `/etc/tapeci/tapeci.env`, a `tapeci` user and
`/var/lib/tapeout/textfile` (created by the installer). It is a oneshot + hourly timer.

## K8s server-side dry-run

```bash
KUBECONFIG=~/.kube/config scripts/ops/k8s-server-dry-run.sh
```

This renders `ops/k8s` with kustomize and asks the API server for a server-side dry-run. It never
applies. Without a cluster it exits 2; CI only runs the schema/kustomize validation.
