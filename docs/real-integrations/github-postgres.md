# GitHub App and PostgreSQL Real Integration Verification

This harness separates local deterministic checks from external delivery and
destructive infrastructure checks. Every real test is skipped unless explicitly
enabled. Credential files are parsed in process; this harness never prints secret
values.

## Preconditions

- Node.js 22 or newer and pnpm 9.
- Docker Desktop with the `tapeci-postgres` service from
  `infra/docker-compose.p2.yml`, or `TAPECI_TEST_DATABASE_URL` and
  `TAPECI_ADMIN_DATABASE_URL` pointing to a disposable PostgreSQL instance.
- For GitHub App network checks, `.tapeci/github-app.env` in the format generated
  by `pnpm github:create-app`. The file must be mode `0600` and gitignored.
- For an end-to-end external webhook, a public HTTPS route to
  `/v1/github/webhook`, a GitHub App installation, and a disposable test
  repository.

The database tests create databases named `tapeci_test_<random>` and force-drop
them when finished. The restart test creates a random PostgreSQL container and a
random volume, then removes both in `finally`.

## Local checks

Run the safe, default test suite first:

```bash
pnpm test:real-integrations
```

Expected behavior without opt-in: every real test file is skipped. Unit-level
parser and safety tests may still run.

Inspect credential presence and the local GitHub App installation inventory
without printing any credential:

```bash
pnpm github:real:preflight
TAPECI_REAL_INTEGRATIONS=1 pnpm github:real:preflight --network
```

The network check makes only read requests:

- `GET /app/installations`

It prints booleans for required credentials, the App id, and installation count.
It does not exchange an installation token or change repository permissions.

Run the signed HTTP callback and PostgreSQL persistence tests:

```bash
TAPECI_REAL_INTEGRATIONS=1 pnpm vitest run \
  tests/real-integrations/github/webhook.test.ts \
  tests/real-integrations/database/persistence.test.ts
```

This validates:

- API-level HMAC-SHA256 verification over raw request bytes.
- Installation `created`, `suspend`, `unsuspend`, and `deleted` transitions.
- Invalid signatures rejected with `401` before a delivery row is written.
- Sequential and concurrent delivery replays deduplicated by PostgreSQL.
- A malformed or unauthorized push persisted with its stable rejection code.
- All 13 migrations applied exactly once and idempotently.
- Transaction rollback leaving no partial rows.
- Installation and organization memberships persisting across pool reconnection.
- Multi-user project access and outsider denial.

## Real PostgreSQL restart check

The following command starts and removes its own container and volume. It does
not restart the shared `tapeci-postgres` service:

```bash
TAPECI_REAL_INTEGRATIONS=1 TAPECI_REAL_DATABASE_RESTART=1 pnpm vitest run \
  tests/real-integrations/database/restart.test.ts
```

The test:

1. starts `postgres:16-alpine` on a random loopback port;
2. applies all migrations and inserts a random user marker;
3. stops and starts the container;
4. verifies the marker and migration ledger after restart;
5. force-removes the container and volume.

## Local webhook delivery

Start the API with a temporary database and the local App environment, then send
a signed request to loopback:

```bash
TAPECI_REAL_INTEGRATIONS=1 pnpm github:real:send \
  --target http://127.0.0.1:8787/v1/github/webhook \
  --event installation \
  --action created \
  --delivery-id "tapeci-local-$(date +%s)"
```

The sender requires `GITHUB_WEBHOOK_SECRET` in its environment. The preflight
loader reports key presence but does not export values into a shell.

## External GitHub App delivery

External delivery is a separate action and requires approval before execution.
The exact approval request must include:

| Item | Required value |
| --- | --- |
| GitHub App | App name, slug, and numeric id |
| Test repository | `owner/repo` and default branch |
| Webhook target | Public HTTPS URL ending in `/v1/github/webhook` |
| Event | `push` or `installation` plus action |
| Expected side effect | Installation row, webhook delivery row, and at most one deployment |
| Rollback | Delete test repository/installation link, revoke App access, stop tunnel |

The sender requires a second flag for a public host:

```bash
TAPECI_REAL_INTEGRATIONS=1 pnpm github:real:send \
  --target https://example-tunnel.invalid/v1/github/webhook \
  --allow-external \
  --event installation \
  --action created \
  --delivery-id "tapeci-external-<random>"
```

This command is a signed local HTTP request. It does not prove that GitHub itself
can reach the route. True GitHub-originated delivery must be triggered through
GitHub App settings or a test repository action after the App webhook is pointed
at the public route.

For a GitHub-originated push:

1. Confirm the App is installed on one disposable repository.
2. Confirm the App has `contents: read` and subscribes to `push`.
3. Start the API and public HTTPS tunnel.
4. Push a uniquely named commit to the repository's default branch.
5. Record the `X-GitHub-Delivery` id from App delivery logs.
6. Verify the delivery row and deployment count in the test database.
7. Replay the same delivery through the App's redelivery control.
8. Verify one delivery row and at most one deployment.
9. Remove the tunnel and test App installation, then delete the test repository.

For an installation callback:

1. Install the App on the disposable repository.
2. Verify the `created` delivery and installation row.
3. Suspend, unsuspend, and remove the installation through GitHub settings.
4. Verify each transition and then replay one delivery.
5. Confirm replays return the existing outcome without duplicating rows.

## Evidence format

Record commands and outcomes without secrets:

| Field | Example |
| --- | --- |
| App | `slug=<slug> id=<id>` |
| Delivery | `X-GitHub-Delivery=<uuid>` |
| Event | `installation.created` |
| HTTP | `202`, then replay `200 duplicate=true` |
| Database | `webhook_deliveries=1`, `deployments<=1` |
| Cleanup | Installation removed, tunnel stopped, temp DB dropped |

## Current limitations

- A local signed request does not verify GitHub's outbound networking or App
  webhook configuration.
- The harness does not create, suspend, or delete GitHub App installations.
- The restart test uses Docker and a one-off local volume; it does not validate a
  managed production PostgreSQL service, replication, backups, or DNS failover.
- Passing these checks is integration evidence, not a production security review.

## Verification record: 2026-10-26

| Check | Result |
| --- | --- |
| Default `pnpm test:real-integrations` | 49 passed, 14 opt-in/external checks skipped |
| GitHub App read-only preflight | App id and installation inventory read successfully; 1 installation visible |
| GitHub webhook HTTP + PostgreSQL | 7 passed |
| Migration, transaction, authorization persistence | 4 passed |
| Isolated PostgreSQL stop/start | 1 passed; temporary container and volume removed |
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed |
| `git diff --check` | Passed |

No GitHub App webhook URL was changed, no installation permission was modified,
and no GitHub-originated external event was sent during this record.
