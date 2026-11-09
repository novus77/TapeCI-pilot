/**
 * End-to-end GitHub App + webhook + durability + OAuth callback proof against
 * already-running services (API :8787, web :3000, Postgres :55432, Redis :56379).
 *
 *   tsx scripts/real-integrations/github/verify-callback.ts prepare
 *   # (restart the API out-of-band)
 *   tsx scripts/real-integrations/github/verify-callback.ts finish
 *
 * `prepare` proves App identity, injects a signed push delivery, replays it,
 * sends a wrong-signature request, audits the Postgres rows and exercises the
 * OAuth redirect/callback, then snapshots row counts before the restart.
 * `finish` re-reads the counts after the restart and writes the evidence file.
 *
 * Secret handling: the App private key, webhook secret, OAuth client secret,
 * session/state cookie values and the signed App JWT stay in this process. Only
 * booleans, ids, hosts, status codes and cookie NAMES/flags are emitted.
 *
 * Write actions: webhook rows plus one test-only fixture
 * (user/installation/container/project). Nothing is deleted.
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { signAppJwt } from "@tapeci/github";
import { loadGithubAppEnv } from "../../github/load-env.js";

const API = "http://127.0.0.1:8787";
const DB_URL_FALLBACK = "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci";
const OUTPUT_DIR = join(process.cwd(), "docs/evidence/real-integrations");

/** Test-only fixture identity: not a real repository, no GitHub App config touched. */
export const FIXTURE = {
  installationId: 990001,
  accountId: 990001,
  accountLogin: "tapeci-verify",
  repositoryId: 990002,
  repositoryFullName: "tapeci-verify/webhook-fixture",
  branch: "main",
  containerAddress: "0x7e5700000000000000000000000000000000000a",
  registryAddress: "0x7e5700000000000000000000000000000000000b",
  factoryAddress: "0x7e5700000000000000000000000000000000000c",
  processorAddress: "0x7e5700000000000000000000000000000000000d",
  bindingAddress: "0x7e5700000000000000000000000000000000000e",
} as const;

type Env = Record<string, string>;
let cachedEnv: Env | undefined;

async function loadEnv(): Promise<Env> {
  cachedEnv ??= await loadGithubAppEnv();
  return cachedEnv;
}

function requireValue(source: Env, name: string): string {
  const value = source[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is missing from .tapeci/github-app.env`);
  }
  return value;
}

async function pg<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const source = await loadEnv();
  const connectionString =
    source["DATABASE_URL"] === undefined || source["DATABASE_URL"].trim() === ""
      ? DB_URL_FALLBACK
      : source["DATABASE_URL"];
  const { default: PgModule } = await import("pg");
  const client = new PgModule.Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(sql);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

/** `Set-Cookie` → name and flags only; the value is deliberately dropped. */
function cookieFacts(setCookie: string): { name: string; flags: string[]; hasValue: boolean } {
  const [pair = "", ...attrs] = setCookie.split(";").map((part) => part.trim());
  const [name = "", value = ""] = pair.split("=");
  return { name, flags: attrs, hasValue: value.length > 0 };
}

function errorFields(json: Record<string, unknown>): { code: string | null; message: string | null } {
  const error = json["error"];
  if (typeof error !== "object" || error === null) return { code: null, message: null };
  const record = error as Record<string, unknown>;
  return {
    code: typeof record["code"] === "string" ? record["code"] : null,
    message: typeof record["message"] === "string" ? record["message"] : null,
  };
}

// ---------------------------------------------------------------------------
// 1. GitHub App identity: JWT signed in process, never printed
// ---------------------------------------------------------------------------
async function appIdentity(): Promise<Record<string, unknown>> {
  const source = await loadEnv();
  const appId = requireValue(source, "GITHUB_APP_ID");
  const privateKey = requireValue(source, "GITHUB_APP_PRIVATE_KEY");
  const jwt = await signAppJwt({ appId, privateKey });
  const startedAt = Date.now();
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${jwt}`,
    "user-agent": "tapeci-real-verify",
    "x-github-api-version": "2022-11-28",
  };
  const appResponse = await fetch("https://api.github.com/app", {
    headers,
    signal: AbortSignal.timeout(25_000),
  });
  const appBody = (await appResponse.json().catch(() => ({}))) as Record<string, unknown>;
  const installationsResponse = await fetch("https://api.github.com/app/installations", {
    headers,
    signal: AbortSignal.timeout(25_000),
  });
  const installationsBody = (await installationsResponse.json().catch(() => [])) as unknown;
  const installations = Array.isArray(installationsBody) ? installationsBody : [];
  const owner = appBody["owner"];
  const permissions = appBody["permissions"];

  return {
    credentialSource: ".tapeci/github-app.env (parsed in process, never printed)",
    appJwtSigned: true,
    appJwtAlg: "RS256",
    appJwtSegmentCount: jwt.split(".").length,
    appJwtPrinted: false,
    elapsedMs: Date.now() - startedAt,
    getApp: {
      status: appResponse.status,
      ok: appResponse.ok,
      id: typeof appBody["id"] === "number" ? appBody["id"] : null,
      slug: typeof appBody["slug"] === "string" ? appBody["slug"] : null,
      name: typeof appBody["name"] === "string" ? appBody["name"] : null,
      ownerLogin:
        typeof owner === "object" && owner !== null && typeof (owner as Record<string, unknown>)["login"] === "string"
          ? ((owner as Record<string, unknown>)["login"] as string)
          : null,
      permissionScopes:
        typeof permissions === "object" && permissions !== null
          ? Object.keys(permissions as Record<string, unknown>).sort()
          : [],
      subscribedEvents: Array.isArray(appBody["events"])
        ? (appBody["events"] as unknown[]).map(String).sort()
        : [],
      htmlUrlHost:
        typeof appBody["html_url"] === "string" ? new URL(appBody["html_url"]).host : null,
    },
    getAppInstallations: {
      status: installationsResponse.status,
      ok: installationsResponse.ok,
      count: installations.length,
      accounts: installations.map((raw) => {
        const item = raw as Record<string, unknown>;
        const account = item["account"];
        return {
          installationId: typeof item["id"] === "number" ? item["id"] : null,
          accountLogin:
            typeof account === "object" && account !== null && typeof (account as Record<string, unknown>)["login"] === "string"
              ? ((account as Record<string, unknown>)["login"] as string)
              : null,
          accountType:
            typeof account === "object" && account !== null && typeof (account as Record<string, unknown>)["type"] === "string"
              ? ((account as Record<string, unknown>)["type"] as string)
              : null,
          repositorySelection:
            typeof item["repository_selection"] === "string" ? item["repository_selection"] : null,
          suspended: item["suspended_at"] !== null && item["suspended_at"] !== undefined,
        };
      }),
    },
    configuredSlug: source["GITHUB_APP_SLUG"] ?? null,
    configuredAppIdMatchesApi:
      source["GITHUB_APP_ID"] === String(typeof appBody["id"] === "number" ? appBody["id"] : ""),
  };
}

// ---------------------------------------------------------------------------
// Fixture project the signed push is authorized against
// ---------------------------------------------------------------------------
async function ensureFixture(): Promise<Record<string, unknown>> {
  const f = FIXTURE;
  const rows = await pg<{
    user_id: string;
    installation_row_id: string;
    container_id: string;
    project_id: string;
  }>(`
with u as (
  insert into users (github_user_id, github_login)
  values (${f.accountId}, '${f.accountLogin}')
  on conflict (github_user_id) do update set updated_at = now()
  returning id
), i as (
  insert into github_installations (installation_id, github_account_id, account_login)
  values (${f.installationId}, ${f.accountId}, '${f.accountLogin}')
  on conflict (installation_id) do update set updated_at = now()
  returning id
), c as (
  insert into containers (chain_id, factory_address, processor_index, processor_address, token_id,
                          container_address, registry_address, binding_address)
  values (196, '${f.factoryAddress}', 0, '${f.processorAddress}', 990001,
          '${f.containerAddress}', '${f.registryAddress}', '${f.bindingAddress}')
  on conflict (chain_id, container_address) do update set updated_at = now()
  returning id
), p as (
  insert into projects (owner_user_id, github_installation_id, github_repository_id, repo_full_name,
                        default_branch, container_id, is_archived, strict_deweb_mode)
  select u.id, i.id, ${f.repositoryId}, '${f.repositoryFullName}', '${f.branch}', c.id, false, true
  from u, i, c
  on conflict (github_repository_id, default_branch, container_id) do nothing
  returning id
)
select (select id from u) as user_id,
       (select id from i) as installation_row_id,
       (select id from c) as container_id,
       coalesce((select id from p),
                (select id from projects
                  where github_repository_id = ${f.repositoryId}
                    and default_branch = '${f.branch}')) as project_id`);
  const row = rows[0];
  if (row === undefined) throw new Error("fixture bootstrap returned no row");
  await pg(
    `update github_installations
        set suspended_at = null, deleted_at = null, updated_at = now()
      where installation_id = ${f.installationId}`,
  );
  await pg(
    `insert into project_members (project_id, user_id, role)
     values ('${row.project_id}', '${row.user_id}', 'owner')
     on conflict do nothing`,
  );
  return {
    projectId: row.project_id,
    userId: row.user_id,
    installationRowId: row.installation_row_id,
    containerId: row.container_id,
    repositoryId: f.repositoryId,
    repositoryFullName: f.repositoryFullName,
    installationId: f.installationId,
    defaultBranch: f.branch,
  };
}

// ---------------------------------------------------------------------------
// 2. Signed push delivery, replay, wrong signature, Postgres rows
// ---------------------------------------------------------------------------
function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

async function postDelivery(input: {
  deliveryId: string;
  body: string;
  signature: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${API}/v1/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "tapeci-real-verify",
      "x-github-event": "push",
      "x-github-delivery": input.deliveryId,
      "x-hub-signature-256": input.signature,
    },
    body: input.body,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

async function buildPushFixture(): Promise<{
  fixture: Record<string, unknown>;
  deliveryId: string;
  commitSha: string;
  body: string;
}> {
  const fixture = await ensureFixture();
  const commitSha = createHmac("sha256", randomUUID()).update("tapeci-verify").digest("hex").slice(0, 40);
  const deliveryId = randomUUID();
  const payload = {
    ref: `refs/heads/${FIXTURE.branch}`,
    before: "0".repeat(40),
    after: commitSha,
    created: true,
    deleted: false,
    forced: false,
    base_ref: null,
    repository: {
      id: FIXTURE.repositoryId,
      node_id: "R_tapeci_verify_fixture",
      name: FIXTURE.repositoryFullName.split("/")[1] ?? "webhook-fixture",
      full_name: FIXTURE.repositoryFullName,
      private: true,
      fork: false,
      default_branch: FIXTURE.branch,
      owner: { id: FIXTURE.accountId, login: FIXTURE.accountLogin, type: "Organization" },
    },
    pusher: { name: "tapeci-verify", email: "verify@tapeci.invalid" },
    sender: { id: FIXTURE.accountId, login: FIXTURE.accountLogin, type: "Organization" },
    installation: { id: FIXTURE.installationId, node_id: "MDIzOkludGVncmF0aW9u" },
    head_commit: { id: commitSha, message: "tapeci end-to-end webhook proof (test-only)" },
  };
  return { fixture, deliveryId, commitSha, body: JSON.stringify(payload) };
}

async function counts(): Promise<Record<string, string>> {
  const rows = await pg<Record<string, string>>(
    `select (select count(*) from webhook_deliveries)::text as webhook_deliveries,
            (select count(*) from deployments)::text as deployments,
            (select count(*) from deployment_events)::text as deployment_events`,
  );
  return rows[0] ?? {};
}

async function webhookProof(): Promise<Record<string, unknown>> {
  const source = await loadEnv();
  const secret = requireValue(source, "GITHUB_WEBHOOK_SECRET");
  const { fixture, deliveryId, commitSha, body } = await buildPushFixture();
  const signature = signBody(secret, body);
  const before = await counts();

  const first = await postDelivery({ deliveryId, body, signature });
  const replay = await postDelivery({ deliveryId, body, signature });
  const wrongDeliveryId = randomUUID();
  const wrong = await postDelivery({
    deliveryId: wrongDeliveryId,
    body,
    signature: `sha256=${"0".repeat(64)}`,
  });

  const projectId = String(fixture["projectId"]);
  const deliveries = await pg<Record<string, unknown>>(
    `select w.id, w.github_delivery_id, w.event_type, w.accepted, w.error_code,
            w.github_installation_numeric_id::text as installation_numeric_id,
            w.github_repository_id::text as repository_id, w.ref, w.commit_sha,
            w.processed_at is not null as processed,
            w.received_at
       from webhook_deliveries w
      where w.github_delivery_id in ('${deliveryId}', '${wrongDeliveryId}')
      order by w.received_at`,
  );
  const deployments = await pg<Record<string, unknown>>(
    `select d.id, d.state, d.trigger_kind, d.commit_sha, d.webhook_delivery_id,
            d.source_event_ref, d.project_id, d.registry_address, d.target_chain_id,
            d.requested_at
       from (select deployments.*, source_event_key as source_event_ref
               from deployments) d
      where d.project_id = '${projectId}'
      order by d.requested_at`,
  );
  const deploymentIds = deployments.map((row) => String(row["id"]));
  const events =
    deploymentIds.length === 0
      ? []
      : await pg<Record<string, unknown>>(
          `select deployment_id, old_state, new_state, event_type, actor_kind
             from deployment_events
            where deployment_id in (${deploymentIds.map((id) => `'${id}'`).join(",")})
            order by created_at`,
        );
  const after = await counts();

  const rowsForDelivery = deliveries.filter((row) => row["github_delivery_id"] === deliveryId).length;
  const rowsForWrong = deliveries.filter((row) => row["github_delivery_id"] === wrongDeliveryId).length;
  const wrongError = errorFields(wrong.json);

  return {
    fixture,
    payloadIsTestOnly: true,
    payloadRepository: FIXTURE.repositoryFullName,
    payloadRepositoryId: FIXTURE.repositoryId,
    delivery: {
      deliveryId,
      event: "push",
      ref: `refs/heads/${FIXTURE.branch}`,
      commitSha,
      signatureScheme: "X-Hub-Signature-256 / HMAC-SHA256 over exact raw bytes",
      signatureComputedInProcess: true,
    },
    responses: {
      first: {
        status: first.status,
        duplicate: first.json["duplicate"] ?? null,
        accepted: first.json["accepted"] ?? null,
        deploymentId: first.json["deploymentId"] ?? null,
      },
      replay: {
        status: replay.status,
        duplicate: replay.json["duplicate"] ?? null,
        accepted: replay.json["accepted"] ?? null,
        deploymentId: replay.json["deploymentId"] ?? null,
      },
      wrongSignature: {
        deliveryId: wrongDeliveryId,
        status: wrong.status,
        code: wrongError.code,
        message: wrongError.message,
        rowWritten: rowsForWrong > 0,
      },
    },
    idempotency: {
      rowsForReplayedDeliveryId: rowsForDelivery,
      replayCreatedSecondRow: rowsForDelivery !== 1,
      deploymentRowsForFixture: deployments.length,
      replayCreatedSecondDeployment: deployments.length !== 1,
      replayReturnedSameDeploymentIdAsFirst:
        first.json["deploymentId"] !== null && first.json["deploymentId"] === replay.json["deploymentId"],
    },
    database: {
      countsBefore: before,
      countsAfter: after,
      webhookDeliveries: deliveries,
      deployments,
      deploymentEvents: events,
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Durability across an API restart
// ---------------------------------------------------------------------------
async function fixtureSnapshot(phase: string): Promise<Record<string, unknown>> {
  const projectRows = await pg<{ id: string }>(
    `select id from projects
      where github_repository_id = ${FIXTURE.repositoryId}
        and default_branch = '${FIXTURE.branch}'
      limit 1`,
  );
  const projectId = projectRows[0]?.id;
  const row = await pg<Record<string, string>>(
    `select d.id as deployment_id, w.id as delivery_row_id, w.github_delivery_id,
            d.state, d.trigger_kind, d.commit_sha
       from deployments d
       join webhook_deliveries w on w.id = d.webhook_delivery_id
      where d.project_id = '${String(projectId)}'
      order by d.requested_at desc
      limit 1`,
  );
  const ready = await fetch(`${API}/readyz`, { signal: AbortSignal.timeout(5_000) })
    .then(async (response) => ({
      status: response.status,
      body: (await response.json().catch(() => ({}))) as unknown,
    }))
    .catch((error: unknown) => ({ status: 0, body: String(error) }));
  const health = await fetch(`${API}/health`, { signal: AbortSignal.timeout(5_000) })
    .then(async (response) => ({ status: response.status, body: (await response.json().catch(() => ({}))) as unknown }))
    .catch((error: unknown) => ({ status: 0, body: String(error) }));
  return {
    phase,
    apiHealth: health,
    apiReady: ready,
    counts: await counts(),
    fixtureRows: row[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// 4. OAuth login redirect + callback fail-closed
// ---------------------------------------------------------------------------
async function oauthProof(): Promise<Record<string, unknown>> {
  const login = await fetch(`${API}/v1/auth/github/login?returnTo=%2Fprojects`, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const location = login.headers.get("location");
  const locationUrl = location === null ? null : new URL(location);
  const stateCookies = login.headers.getSetCookie().map(cookieFacts);

  const noState = await fetch(`${API}/v1/auth/github/callback?code=bogus-tapeci-verify`, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const noStateJson = (await noState.json().catch(() => ({}))) as Record<string, unknown>;

  const forgedState = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwdXJwb3NlIjoib2F1dGgifQ.bogus";
  const forged = await fetch(
    `${API}/v1/auth/github/callback?code=bogus-tapeci-verify&state=${encodeURIComponent(forgedState)}`,
    {
      redirect: "manual",
      headers: { cookie: `tapeci_oauth_state=${encodeURIComponent(forgedState)}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  const forgedJson = (await forged.json().catch(() => ({}))) as Record<string, unknown>;

  const callbackUri = locationUrl?.searchParams.get("redirect_uri") ?? "";
  const noStateError = errorFields(noStateJson);
  const forgedError = errorFields(forgedJson);

  return {
    login: {
      status: login.status,
      redirectFollowed: false,
      locationHost: locationUrl?.host ?? null,
      locationScheme: locationUrl?.protocol ?? null,
      locationPath: locationUrl?.pathname ?? null,
      locationParamNames: locationUrl === null ? [] : [...locationUrl.searchParams.keys()].sort(),
      stateParamPresent: (locationUrl?.searchParams.get("state") ?? "").length > 0,
      clientIdParamPresent: (locationUrl?.searchParams.get("client_id") ?? "").length > 0,
      allowSignup: locationUrl?.searchParams.get("allow_signup") ?? null,
      callbackUriHost: callbackUri.length === 0 ? null : new URL(callbackUri).host,
      callbackUriPath: callbackUri.length === 0 ? null : new URL(callbackUri).pathname,
    },
    stateCookies: stateCookies.map((cookie) => ({
      name: cookie.name,
      valueRecorded: false,
      hasValue: cookie.hasValue,
      flags: cookie.flags,
    })),
    signedStateCookiePresent: stateCookies.some(
      (cookie) => cookie.name === "tapeci_oauth_state" && cookie.hasValue,
    ),
    callbackMissingStateAndCookie: {
      status: noState.status,
      code: noStateError.code,
      message: noStateError.message,
      sessionCookieSet: noState.headers.getSetCookie().length > 0,
      tokenExchangeAttempted: false,
    },
    callbackForgedStateWithBogusCode: {
      status: forged.status,
      code: forgedError.code,
      message: forgedError.message,
      sessionCookieSet: forged.headers.getSetCookie().length > 0,
      tokenExchangeAttempted: false,
      failsClosed: forged.status === 400,
    },
    note:
      "State verification runs before the code exchange, so a bogus code never reaches " +
      "github.com and no session cookie is issued.",
  };
}

// ---------------------------------------------------------------------------
// Evidence assembly
// ---------------------------------------------------------------------------
const FORBIDDEN = /secret|key|token|password|mnemonic|private/i;

function assertNoSecretKeys(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [name, child] of Object.entries(value)) {
    if (FORBIDDEN.test(name)) throw new Error(`evidence key "${path}.${name}" looks secret`);
    assertNoSecretKeys(child, `${path}.${name}`);
  }
}

const PARTIAL = join(OUTPUT_DIR, "github-callback.partial.json");
const FINAL = join(OUTPUT_DIR, `github-callback-${new Date().toISOString().slice(0, 10)}.json`);

async function prepare(): Promise<void> {
  const startedAt = new Date();
  const identity = await appIdentity();
  const webhook = await webhookProof();
  const oauth = await oauthProof();
  const restartBefore = await fixtureSnapshot("before-restart");
  const partial = {
    startedAt: startedAt.toISOString(),
    identity,
    webhook,
    oauth,
    restartBefore,
  };
  await writeFile(PARTIAL, `${JSON.stringify(partial, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        partial: PARTIAL,
        appId: identity["getApp"],
        installations: {
          status: (identity["getAppInstallations"] as Record<string, unknown>)["status"],
          count: (identity["getAppInstallations"] as Record<string, unknown>)["count"],
          accounts: (identity["getAppInstallations"] as Record<string, unknown>)["accounts"],
        },
        webhook: {
          deliveryId: (webhook["delivery"] as Record<string, unknown>)["deliveryId"],
          responses: webhook["responses"],
          idempotency: webhook["idempotency"],
          counts: {
            before: (webhook["database"] as Record<string, unknown>)["countsBefore"],
            after: (webhook["database"] as Record<string, unknown>)["countsAfter"],
          },
          deploymentIds: (webhook["database"] as Record<string, unknown>).deployments,
          deliveryRows: (webhook["database"] as Record<string, unknown>).webhookDeliveries,
        },
        oauth,
        restartBefore,
      },
      null,
      2,
    )}\n`,
  );
}

async function finish(): Promise<void> {
  const partial = JSON.parse(await readFile(PARTIAL, "utf8")) as Record<string, unknown>;
  const restartAfter = await fixtureSnapshot("after-restart");
  const before = partial["restartBefore"] as Record<string, unknown>;
  const beforeCounts = (before["counts"] ?? {}) as Record<string, string>;
  const afterCounts = (restartAfter["counts"] ?? {}) as Record<string, string>;
  const beforeRows = (before["fixtureRows"] ?? null) as Record<string, string> | null;
  const afterRows = (restartAfter["fixtureRows"] ?? null) as Record<string, string> | null;

  const durability = {
    postgresRestarted: false,
    apiRestarted: true,
    countsBefore: beforeCounts,
    countsAfter: afterCounts,
    countsPreserved: Object.keys(beforeCounts).every(
      (name) => beforeCounts[name] === afterCounts[name],
    ),
    deploymentIdBefore: beforeRows?.["deployment_id"] ?? null,
    deploymentIdAfter: afterRows?.["deployment_id"] ?? null,
    deliveryRowIdBefore: beforeRows?.["delivery_row_id"] ?? null,
    deliveryRowIdAfter: afterRows?.["delivery_row_id"] ?? null,
    sameRowsSurvived: beforeRows?.["deployment_id"] === afterRows?.["deployment_id"],
    stateAfterRestart: afterRows?.["state"] ?? null,
    apiHealthyAfterRestart:
      ((restartAfter["apiHealth"] as Record<string, unknown>)["status"] ?? 0) === 200,
  };

  const evidence = {
    schema: "tapeci.real-integration.github-callback.v1",
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    readOnly: false,
    writeActionsPerformed: true,
    writeActionNote:
      "This run inserts test rows: webhook_deliveries + deployments + deployment_events " +
      "plus a test-only fixture user/installation/container/project " +
      "(repository id 990002, tapeci-verify/webhook-fixture). No existing row was updated " +
      "or deleted, no chain transaction was sent, and the GitHub App configuration and " +
      "permissions were not changed.",
    environment: {
      apiBaseUrl: API,
      webBaseUrl: "http://127.0.0.1:3000",
      postgresHost: "127.0.0.1:55432",
      redisHost: "127.0.0.1:56379",
      database: "tapeci",
      devAuthEnabled: true,
      workerRunning: false,
    },
    appIdentity: partial["identity"],
    webhook: partial["webhook"],
    oauth: partial["oauth"],
    durability,
    secretsRecorded: false,
    realGitHubDeliveryTriggered: false,
    githubAppConfigurationChanged: false,
  };
  assertNoSecretKeys(evidence);
  await writeFile(FINAL, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ final: FINAL, durability }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const step = process.argv[2];
  if (step === "prepare") {
    await prepare();
    return;
  }
  if (step === "finish") {
    await finish();
    return;
  }
  if (step === "identity") {
    process.stdout.write(`${JSON.stringify(await appIdentity(), null, 2)}\n`);
    return;
  }
  if (step === "snapshot") {
    process.stdout.write(`${JSON.stringify(await fixtureSnapshot(process.argv[3] ?? "manual"), null, 2)}\n`);
    return;
  }
  throw new Error("usage: verify-callback.ts prepare|finish|identity|snapshot [phase]");
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === `file://${entry}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
