import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { exportPKCS8, generateKeyPair } from "jose";
import { eq } from "drizzle-orm";
import {
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  githubInstallationUsers,
  githubInstallations,
  migrateUp,
  users,
  type Database,
} from "@tapeci/database";
import { buildApp } from "../../../apps/api/src/app.js";
import type { ApiDeps } from "../../../apps/api/src/deps.js";
import type { ApiEnv } from "../../../apps/api/src/env.js";
import { clearInstallationTokenCache } from "../../../apps/api/src/github-app.js";
import { signSession } from "../../../apps/api/src/session.js";

const available = await databaseAvailable();

function cookies(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers["set-cookie"];
  if (Array.isArray(raw)) return raw.map(String);
  return typeof raw === "string" ? [raw] : [];
}

function cookiePair(response: { headers: Record<string, unknown> }, name: string): string {
  const cookie = cookies(response).find((value) => value.startsWith(`${name}=`));
  if (cookie === undefined) throw new Error(`cookie ${name} not set`);
  return cookie.split(";")[0] as string;
}

describe.skipIf(!available)("P2-02 GitHub OAuth + installation flow", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let app: FastifyInstance;
  let env: ApiEnv;
  let tokenRequests = 0;
  let repoRequests = 0;

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrateUp(database.url);
    handle = createDatabase(database.url);
    db = handle.db;
    const pair = await generateKeyPair("RS256", { extractable: true });
    const privateKey = await exportPKCS8(pair.privateKey);
    env = {
      databaseUrl: database.url,
      redisUrl: "redis://127.0.0.1:56379",
      port: 0,
      host: "127.0.0.1",
      sessionSecret: "oauth-test-session-secret-123456",
      devAuth: false,
      objectStoreDir: ".tapeci/objects",
      artifactMaxBytes: 64 * 1024 * 1024,
      artifactTokenTtlSeconds: 900,
      githubAppId: "12345",
      githubAppPrivateKey: privateKey,
      githubWebhookSecret: "webhook-secret",
      githubOidcAudience: "tapeci-artifact-upload",
      githubOidcIssuer: "https://token.actions.githubusercontent.com",
      githubAppSlug: "tapeci-test",
      githubOAuthClientId: "client-id",
      githubOAuthClientSecret: "client-secret",
      githubOAuthBaseUrl: "https://github.test",
      githubApiBaseUrl: "https://api.github.test",
      publicApiUrl: "http://api.test",
      webUrl: "http://web.test",
      sessionTtlSeconds: 3600,
      operatorPrivateKey: null,
      writeRpcUrl: null,
      journalDir: ".tapeci/journal",
    };
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url === "https://github.test/login/oauth/access_token") {
        return Response.json({ access_token: "gho_test_token" });
      }
      if (url === "https://api.github.test/user") {
        return Response.json({ id: 4242, login: "alice", avatar_url: "https://avatar.test/a" });
      }
      if (url === "https://api.github.test/app/installations/9001") {
        return Response.json({
          id: 9001,
          account: { id: 77, login: "acme", type: "Organization" },
          suspended_at: null,
        });
      }
      if (url === "https://api.github.test/app/installations/9001/access_tokens") {
        tokenRequests += 1;
        return Response.json({
          token: "ghs_test_token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.startsWith("https://api.github.test/installation/repositories")) {
        repoRequests += 1;
        return Response.json({
          total_count: 2,
          repositories: [
            {
              id: 101,
              name: "site",
              full_name: "acme/site",
              private: false,
              default_branch: "main",
              archived: false,
            },
            {
              id: 102,
              name: "docs",
              full_name: "acme/docs",
              private: true,
              default_branch: "main",
              archived: false,
            },
          ],
        });
      }
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    };
    const deps: ApiDeps = {
      db,
      env,
      github: {
        fetch: fetch as typeof globalThis.fetch,
        oauthBaseUrl: "https://github.test",
        apiBaseUrl: "https://api.github.test",
      },
    };
    app = buildApp(deps);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    clearInstallationTokenCache();
    await app?.close();
    await handle?.pool.end();
    await database?.drop();
  }, 30_000);

  async function login(): Promise<string> {
    const start = await app.inject({ method: "GET", url: "/v1/auth/github/login" });
    expect(start.statusCode).toBe(302);
    const location = new URL(start.headers.location as string);
    const state = location.searchParams.get("state");
    if (state === null) throw new Error("missing oauth state");
    const stateCookie = cookiePair(start, "tapeci_oauth_state");
    const callback = await app.inject({
      method: "GET",
      url: `/v1/auth/github/callback?code=code-1&state=${encodeURIComponent(state)}`,
      headers: { cookie: stateCookie },
    });
    expect(callback.statusCode).toBe(302);
    return cookiePair(callback, "tapeci_session");
  }

  it("completes OAuth login, session auth and logout", async () => {
    const start = await app.inject({ method: "GET", url: "/v1/auth/github/login" });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toContain("https://github.test/login/oauth/authorize");
    expect(start.headers.location).toContain("client_id=client-id");
    expect(start.headers.location).toContain("redirect_uri=http%3A%2F%2Fapi.test%2Fv1%2Fauth%2Fgithub%2Fcallback");

    const session = await login();
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: session } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ githubLogin: "alice", githubUserId: 4242 });

    const noCookie = await app.inject({ method: "GET", url: "/v1/me" });
    expect(noCookie.statusCode).toBe(401);

    const tampered = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: "tapeci_session=not-a-jwt" },
    });
    expect(tampered.statusCode).toBe(401);

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: session },
    });
    expect(logout.statusCode).toBe(204);

    const [user] = await db.select().from(users).where(eq(users.githubUserId, 4242));
    expect(user?.githubLogin).toBe("alice");
    expect(user?.avatarUrl).toBe("https://avatar.test/a");
  });

  it("rejects a mismatched OAuth state", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/github/callback?code=code-1&state=wrong",
      headers: { cookie: "tapeci_oauth_state=other" },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe("INVALID_OAUTH_STATE");
  });

  it("installs, syncs and lists installation repositories with a cached token", async () => {
    const session = await login();
    const install = await app.inject({
      method: "GET",
      url: "/v1/github/install",
      headers: { cookie: session },
    });
    expect(install.statusCode).toBe(302);
    const location = new URL(install.headers.location as string);
    const state = location.searchParams.get("state");
    if (state === null) throw new Error("missing install state");
    const installCookie = cookiePair(install, "tapeci_install_state");

    const setup = await app.inject({
      method: "GET",
      url: `/v1/github/setup?installation_id=9001&setup_action=install&state=${encodeURIComponent(state)}`,
      headers: { cookie: installCookie },
    });
    expect(setup.statusCode).toBe(302);
    expect(setup.headers.location).toContain("http://web.test/projects/new?installationId=");
    const [installation] = await db.select().from(githubInstallations).limit(1);
    expect(installation?.installationId).toBe(9001);
    expect(installation?.accountLogin).toBe("acme");
    const memberships = await db.select().from(githubInstallationUsers);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.userId).toBe((await db.select().from(users).limit(1))[0]?.id);

    const repos = await app.inject({
      method: "GET",
      url: `/v1/github/installations/${installation?.id}/repositories`,
      headers: { cookie: session },
    });
    expect(repos.statusCode).toBe(200);
    expect((repos.json() as { repositories: Array<{ fullName: string }> }).repositories).toHaveLength(2);
    expect((repos.json() as { repositories: Array<{ fullName: string }> }).repositories[0]?.fullName).toBe(
      "acme/site",
    );
    expect(tokenRequests).toBe(1);
    const second = await app.inject({
      method: "GET",
      url: `/v1/github/installations/${installation?.id}/repositories`,
      headers: { cookie: session },
    });
    expect(second.statusCode).toBe(200);
    expect(tokenRequests).toBe(1);
    expect(repoRequests).toBe(2);
  });

  it("isolates installations and repositories between users", async () => {
    const aliceSession = await login();
    const [installation] = await db.select().from(githubInstallations).limit(1);
    if (installation === undefined) throw new Error("installation fixture missing");

    const [bob] = await db
      .insert(users)
      .values({ githubUserId: 5555, githubLogin: "bob" })
      .returning();
    if (bob === undefined) throw new Error("bob fixture failed");
    const bobSession = `tapeci_session=${await signSession(env, {
      userId: bob.id,
      githubUserId: bob.githubUserId,
      githubLogin: bob.githubLogin,
    })}`;

    const aliceList = await app.inject({
      method: "GET",
      url: "/v1/github/installations",
      headers: { cookie: aliceSession },
    });
    expect(aliceList.statusCode).toBe(200);
    expect((aliceList.json() as { installations: unknown[] }).installations).toHaveLength(1);

    const bobList = await app.inject({
      method: "GET",
      url: "/v1/github/installations",
      headers: { cookie: bobSession },
    });
    expect((bobList.json() as { installations: unknown[] }).installations).toHaveLength(0);

    const bobRepos = await app.inject({
      method: "GET",
      url: `/v1/github/installations/${installation.id}/repositories`,
      headers: { cookie: bobSession },
    });
    expect(bobRepos.statusCode).toBe(403);
    expect((bobRepos.json() as { error: { code: string } }).error.code).toBe(
      "REPOSITORY_NOT_AUTHORIZED",
    );

    const bobProject = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: bobSession, "content-type": "application/json" },
      payload: {
        repoFullName: "acme/site",
        githubRepositoryId: 101,
        defaultBranch: "main",
        containerAddress: "0x25b20d3ea6b207506340eab2eb0f45edc800f6b3",
        githubInstallationId: installation.id,
      },
    });
    expect(bobProject.statusCode).toBe(403);
  });
});
