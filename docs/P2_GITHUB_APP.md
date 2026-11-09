# GitHub App — live setup and verification

TapeCI uses one GitHub App for three things:

1. **OAuth login** — identifies the human account (`GITHUB_OAUTH_CLIENT_ID/SECRET`).
2. **Installation** — grants repository metadata, push webhooks and installation lifecycle events (`GITHUB_APP_ID/PRIVATE_KEY`). See `docs/P2_INSTALLATION_RECONCILE.md`.
3. **Actions OIDC** — the workflow uploads artifacts with a one-time TapeCI build token
   (no App permission is needed for this path).

No App credentials are committed. Until they are supplied, the API runs in dev-auth/mock mode
and all GitHub calls are tested with injected fake fetch implementations.

## 1. Create the App

GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.

| Setting | Value |
|---|---|
| Homepage URL | `https://<console-host>` (local: `http://127.0.0.1:3000`) |
| Callback URL | `https://<api-host>/v1/auth/github/callback` (local: `http://127.0.0.1:8787/v1/auth/github/callback`) |
| Setup URL | `https://<api-host>/v1/github/setup` — enable **Redirect on update** |
| Webhook URL | `https://<api-host>/v1/github/webhook` |
| Webhook secret | random 32+ byte value (`GITHUB_WEBHOOK_SECRET`) |
| Repository permissions | **Metadata: Read-only**; **Contents: Read-only** (recommended); **Actions: Read-only** (optional, for future run correlation) |
| Subscribe to events | **Push** and **Installation** |
| User authorization | Enable; no OAuth scopes are needed (the App's repository permissions apply) |
| Installable | Any account |

Generate a private key (PKCS#8 PEM) and store it only in the API/worker environment.

## 2. Environment

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
GITHUB_APP_SLUG=tapeci
GITHUB_OAUTH_CLIENT_ID=Iv1.xxxxxxxx
GITHUB_OAUTH_CLIENT_SECRET=...
GITHUB_WEBHOOK_SECRET=...
GITHUB_OIDC_AUDIENCE=tapeci-artifact-upload

TAPECI_PUBLIC_API_URL=https://api.example.com   # callback/setup URLs and Secure cookies
TAPECI_WEB_URL=https://console.example.com     # post-login redirects
# Only when API and console are sibling subdomains (cookie must reach both):
SESSION_COOKIE_DOMAIN=.example.com
TAPECI_DEV_AUTH=0
```

`TAPECI_PUBLIC_API_URL`/`TAPECI_WEB_URL` are also used locally
(`http://127.0.0.1:8787` / `http://127.0.0.1:3000`). Cookies are host-scoped: for
`api.example.com` + `console.example.com`, set `SESSION_COOKIE_DOMAIN=.example.com`
(or serve both behind one origin).

## 3. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/auth/github/login` | public | set signed OAuth state cookie; redirect to GitHub |
| GET | `/v1/auth/github/callback` | public + state | exchange code, fetch `/user`, set signed session cookie |
| POST | `/v1/auth/logout` | session | clear session |
| GET | `/v1/github/install` | session | redirect to the App installation page with signed state |
| GET | `/v1/github/setup` | public (App redirect) | sync installation via App JWT; redirect to `/projects/new` |
| GET | `/v1/github/installations` | session | installations known to TapeCI |
| GET | `/v1/github/installations/:id/repositories` | session | repositories via a cached installation token |

Sessions are stateless HS256 JWTs (`SESSION_SIGNING_SECRET`), `HttpOnly`, `SameSite=Lax`,
`Secure` when the public API URL is HTTPS. OAuth state is a separate signed JWT plus a
double-submit cookie; a mismatched/replayed state is rejected.

Installation tokens are cached in-process and refreshed 60 s before expiry. Tokens and App
private keys are never logged or returned in error details.

## 4. Console flow

1. `/login` → **Continue with GitHub** → API OAuth → back to the console. The top bar
   avatar shows the signed-in login and offers **Sign out** (proxied through `/logout`).
2. `/projects/new` → **Install on GitHub** when no installation exists, or select an existing
   installation; repositories load through a server action (the browser never sees the token).
3. Selecting a repository fills `repoFullName`/`defaultBranch` and submits
   `githubRepositoryId` to `POST /v1/projects`.

Mock mode (`NEXT_PUBLIC_TAPECI_MOCK=1`) keeps the deterministic fixtures and skips all GitHub
calls; the login page explains that the redirect requires a non-mock build.

## 5. Verification status (live, 2026-10-20)

Verified against a real GitHub App (`tapeci-local-12e350`, App id `5383055`) created through
the Manifest flow (`scripts/github/create-app.ts`):

- OAuth login → session cookie → `/v1/me` returns the GitHub login.
- Installation `173094654` (`novus77`) synced; installation token issued; **43 repositories**
  listed through the installation.
- Webhook via `smee.io` → local API: `installation.created` HMAC verified and stored; a real
  `push` returned 202 and created a deployment.
- **Real GitHub Actions OIDC** → `POST /v1/builds/token` (GitHub JWKS) → one-time build token
  → `POST /v1/builds/artifacts` → 200 → worker plan → **PLAN_READY**.

Evidence: [`docs/evidence/logs/p2-github-live.log`](./evidence/logs/p2-github-live.log)
(workflow run `39355070607`, commit `147c0d8`, no secrets).

Because Cloudflare quick tunnels were blocked by the local network, Actions ran on a
**self-hosted runner** (`tapeci-local`) so it could reach `http://127.0.0.1:8787`. A public
deployment can instead use an HTTPS API URL; no code change is required.

### Repository workflow

Copy [`docs/examples/tapeci-actions.yml`](./examples/tapeci-actions.yml) to
`.github/workflows/tapeci.yml`, set the repository variable `TAPECI_API_URL`, adjust
`BUILD_COMMAND`/`OUTPUT_DIR`, and push. The workflow requests an OIDC token with audience
`tapeci-artifact-upload`, retries until the push webhook has created the deployment, then
uploads the uncompressed tar. On macOS runners set `COPYFILE_DISABLE=1` when creating the tar
(AppleDouble `._*` files are rejected by the artifact scanner).

## 6. Multi-tenant access

`github_installation_users` links a user to the installations they installed. The setup callback
receives a signed state containing the user id and inserts the membership (role `owner`). The
installation list, repository picker and project creation require membership:
- `GET /v1/github/installations` joins the membership table.
- `GET /v1/github/installations/:id/repositories` returns 403 for non-members.
- `POST /v1/projects` rejects an installation the caller is not linked to (unless
  `TAPECI_DEV_AUTH=1`, which is a local/test-only bypass).

Installations created outside the console setup flow have no membership until claimed; a future
"claim installation" screen can add that. Installation deletion leaves membership rows for audit
and they stop matching the (filtered) installation list.

## 7. Known limitations

- The console shows a static avatar; it does not yet display the signed-in login/session state.
- Installation suspension/deletion is reflected from setup/webhook updates, but there is no
  background reconciler against GitHub.
- App creation itself must be done by a GitHub account/org admin; TapeCI cannot create it.
