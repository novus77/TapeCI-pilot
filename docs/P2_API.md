# P2 API / worker contract

Base URL: `http://127.0.0.1:8787` (`TAPECI_API_PORT`). All JSON, UTC ISO timestamps.

## Auth model (dev)
Production auth is GitHub OAuth: `GET /v1/auth/github/login` sets a signed state cookie and
redirects to GitHub; the callback sets an `HttpOnly` session cookie (`tapeci_session`, HS256
JWT). The console forwards that cookie server-side. `TAPECI_DEV_AUTH=1` remains a local/test
fallback using `x-tapeci-github-login` + optional `x-tapeci-github-user-id`; a present-but-invalid
session cookie is always rejected. GitHub App setup: see `docs/P2_GITHUB_APP.md`.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/me` | current user `{id, githubLogin, githubUserId}` |
| POST | `/v1/auth/wallet/challenge` | body `{address}` (chainId fixed to 196) → `{nonce, message, expiresAt}` |
| POST | `/v1/auth/wallet/verify` | body `{address, signature, nonce?}` → `{ok, wallet}`; challenge is consumed once |
| GET | `/v1/github/installations` | installations linked to the current user `{id, installationId, accountLogin}` |
| GET | `/v1/github/installations/:id/repositories` | member-only repositories via cached installation token; `{repositories:[{id,fullName,defaultBranch,private,archived}]}` |
| GET | `/v1/auth/github/login` | OAuth start (state cookie + GitHub redirect) |
| GET | `/v1/auth/github/callback` | OAuth callback (session cookie) |
| POST | `/v1/auth/logout` | clear session |
| GET | `/v1/github/install` | App install redirect with signed state |
| GET | `/v1/github/setup` | App setup redirect; syncs installation |
| POST | `/v1/github/webhook` | raw GitHub webhook; headers `x-hub-signature-256`, `x-github-delivery`, `x-github-event`; handles `push` and `installation` events |
| POST | `/v1/builds/token` | OIDC bearer → `{token, expiresAt, deploymentId}` (one-time) |
| POST | `/v1/builds/artifacts` | `Authorization: Bearer <build token>`, body `application/x-tar` → `{deploymentId, artifactSha256, files, planQueued}` |
| GET | `/v1/projects` | list projects |
| POST | `/v1/projects` | body `{githubRepositoryId, repoFullName, defaultBranch, containerAddress, githubInstallationId?, buildCommand?, installCommand?, outputDirectory?}`; container is resolved read-only on X Layer |
| GET | `/v1/projects/:id` | project detail incl. container/installations |
| GET | `/v1/projects/:id/releases` | stored releases |
| POST | `/v1/projects/:id/rollback` | body `{releaseId}` → creates a `PLAN_READY` rollback deployment (idempotent per release) bound to the target release + artifact key; approval/execute then run through the deploy worker |
| GET | `/v1/deployments` | `?projectId=&state=&sort=&dir=&page=&pageSize=` (legacy `limit` still accepted) → `{deployments, page, pageSize, total, totalPages}`; see below |
| GET | `/v1/deployments/:id` | deployment + `releaseFiles[]` + `chainTransactions[]` + plan summary |
| GET | `/v1/deployments/:id/events` | `?after=` ordered timeline |
| GET | `/v1/deployments/:id/plan` | stored plan JSON |
| POST | `/v1/deployments/:id/approve` | body `{signature, approval}` (EIP-712) → stores approval + operator session |
| POST | `/v1/deployments/:id/execute` | enqueues a deploy job (requires approved state) |
| GET | `/v1/deployments/:id/verification` | verification report JSON |
| GET | `/v1/containers/:address` | container settings: owner/factory/opener/registry/operator sessions |

### `GET /v1/deployments` — paging and sorting

| Param | Values | Default | Notes |
|---|---|---|---|
| `projectId` | uuid | — | unchanged |
| `state` | deployment state enum | — | unchanged |
| `sort` | `requestedAt` \| `state` \| `project` | `requestedAt` | an unknown key is `400 INVALID_QUERY` |
| `dir` | `asc` \| `desc` | `desc` | any other value is `400 INVALID_QUERY` |
| `page` | integer >= 1 | `1` | a page past the end returns `deployments: []`, not 404 |
| `pageSize` | 1..200 | `50` | clamped, not rejected |
| `limit` | 1..200 | — | **legacy**: used as `pageSize` only when `pageSize` is absent |

`sort` is mapped through an allowlist to a Drizzle column and applied with `asc()`/`desc()`;
the query string never reaches SQL as raw text. `total` is a real `COUNT(*)` over the same
`FROM`/`JOIN`/`WHERE` as the page query (membership join included), never `items.length`, so
`totalPages` describes the whole result set rather than the page returned.

Response: `{ deployments, page, pageSize, total, totalPages }`. `totalPages` is at least 1.

## Error body
`{ error: { code, message, retryable, details }, requestId }` with HTTP 400/401/403/404/409/422/500.

## Worker contract (`@tapeci/queue`)
- Queues: `plan`, `deploy`, `verify`; job id = deployment id; attempts 3 with exponential backoff.
- Per-container chain writes are serialized by a Redis lock key
  `tapeci:container:<lowercase-address>:lock` (SET NX PX, token-checked release).
- State transitions are CAS updates on `deployments.state_version`, appending a
  `deployment_events` row in the same transaction. Invalid transitions fail with `PLAN_STALE`
  or `UPLOAD_CONFLICT` style codes.
- Planning worker: consume artifact upload → safe extract → validator scan → versioned release
  preparation → plan → persist `plan_json`, `release_files`, state `PLAN_READY`.
- Deployment worker: requires approval + operator session + budget cap; executes with the P1-06
  journal; never marks LIVE on receipt alone (verification worker decides).
- Verification worker: `verifyRelease` → persist `releases` + state `LIVE` only when
  `releaseMatch` is true.

## Environment
See [`.env.example`](../.env.example). Never commit real secrets or main-wallet keys.

## Governance, audit and operations routes (added after P2-09)

All require a session cookie unless noted. Mutating routes are owner/role-gated as noted.

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/me` | current user; includes `isAdmin` when `TAPECI_ADMIN_LOGINS` matches |
| GET | `/v1/projects/:id/members` | direct + inherited members with effective `role`, `source` (`direct`/`inherited`), `directRole` (nullable), scoped `lastActivityAt` (ISO or null), `canManage`, `protectedUserId` |
| POST | `/v1/projects/:id/members` | body `{githubLogin, role}`; project owner only; cannot demote the designated owner via upsert (409 `LAST_OWNER`) |
| PATCH | `/v1/projects/:id/members/:userId` | body `{role}` (`owner`\|`member`); project owner only; 409 `LAST_OWNER`; audit `project.member.role` |
| DELETE | `/v1/projects/:id/members/:userId` | project owner only; project owner cannot be removed |
| PATCH | `/v1/projects/:id` | build/install/output/archive + `organizationId`; project owner only; org assignment requires org owner/admin |
| GET/PATCH | `/v1/projects/:id/budget` | monthly cap (wei) + estimated spend; PATCH owner only |
| GET/PATCH | `/v1/projects/:id/approval-policy` | required role, max cost cap, approval TTL; PATCH owner only |
| GET/POST | `/v1/projects/:id/notification-channels` | Slack/email channels; POST owner only |
| DELETE | `/v1/projects/:id/notification-channels/:channelId` | owner only |
| POST | `/v1/projects/:id/notification-channels/test` | sends a test through enabled channels |
| GET | `/v1/projects/:id/releases/compare?base=&target=` | file-level release diff |
| GET | `/v1/audit?projectId=&status=&scope=` | own mutations; `scope=all` admin-only; projectId requires membership |
| GET | `/v1/github/webhook-deliveries` | deliveries for the user's installations |
| GET | `/v1/notifications` | attention inbox with `readAt`/`unread` |
| POST | `/v1/notifications/read` | body `{deploymentIds?: string[]}`; empty = mark all visible |
| GET/POST | `/v1/organizations` | list/create organizations |
| GET | `/v1/organizations/:id` | members (with `lastActivityAt`), projects, `canManage` |
| POST | `/v1/organizations/:id/members` | body `{githubLogin, role}`; org owner/admin; designated owner cannot be overwritten (409 `LAST_OWNER`) |
| PATCH | `/v1/organizations/:id/members/:userId` | body `{role}` (`owner`\|`admin`\|`member`); org owner/admin (403 `ORG_ROLE_REQUIRED`); 409 `LAST_OWNER`; 404 `MEMBER_NOT_FOUND`; idempotent; audit `organization.member.role` |
| DELETE | `/v1/organizations/:id/members/:userId` | org owner/admin; org owner cannot be removed |
| GET/PATCH | `/v1/organizations/:id/budget` | aggregated monthly cap/spend; PATCH owner/admin |
| GET | `/v1/organizations/:id/audit` | events scoped by `organization_id`; owner/admin |

Authorization inheritance: effective project role = max(explicit `project_members.role`, organization role
mapped owner→owner, admin→maintainer, member→member). Settings/members/budget/policy require owner;
rollback requires maintainer+.

Web-only routes (Next.js, same origin): `GET /api/events` (SSE deployment snapshot),
`GET /api/notifications`, `POST /api/notifications/read`, and
`GET /deployments/:id/evidence` (JSON export).
