import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { githubInstallations, users } from "@tapeci/database";
import { requireUser } from "../auth.js";
import type { ApiDeps } from "../deps.js";
import type { ApiEnv } from "../env.js";
import { ApiError } from "../errors.js";
import { syncInstallation } from "../github-app.js";
import { exchangeOAuthCode, fetchGithubUser } from "../github-oauth.js";
import {
  INSTALL_STATE_COOKIE,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  appendCookie,
  clearCookie,
  cookieOptions,
  readCookie,
  serializeCookie,
  signSession,
  signState,
  verifyState,
} from "../session.js";

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeReturnTo(value: unknown): string {
  const raw = queryString(value);
  if (raw === undefined) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function oauthConfig(env: ApiEnv): { clientId: string; clientSecret: string; callbackUrl: string } {
  if (env.githubOAuthClientId === null || env.githubOAuthClientSecret === null) {
    throw new ApiError(503, "GITHUB_OAUTH_NOT_CONFIGURED", "GitHub OAuth is not configured");
  }
  return {
    clientId: env.githubOAuthClientId,
    clientSecret: env.githubOAuthClientSecret,
    callbackUrl: `${env.publicApiUrl}/v1/auth/github/callback`,
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/v1/auth/github/login", async (request, reply: FastifyReply) => {
    const config = oauthConfig(deps.env);
    const state = await signState(deps.env, "oauth", safeReturnTo((request.query as Record<string, unknown>)["returnTo"]));
    appendCookie(
      reply,
      serializeCookie(OAUTH_STATE_COOKIE, state, cookieOptions(deps.env, 600)),
    );
    const url = new URL(`${deps.env.githubOAuthBaseUrl}/login/oauth/authorize`);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.callbackUrl);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    return reply.redirect(url.toString(), 302);
  });

  app.get("/v1/auth/github/callback", async (request, reply: FastifyReply) => {
    const config = oauthConfig(deps.env);
    const query = request.query as Record<string, unknown>;
    const code = queryString(query["code"]);
    const state = queryString(query["state"]);
    const stateCookie = readCookie(request, OAUTH_STATE_COOKIE);
    if (code === undefined || state === undefined || stateCookie === undefined || stateCookie !== state) {
      throw new ApiError(400, "INVALID_OAUTH_STATE", "OAuth state is missing or does not match");
    }
    const claims = await verifyState(deps.env, state, "oauth");
    if (claims === null) {
      throw new ApiError(400, "INVALID_OAUTH_STATE", "OAuth state is invalid or expired");
    }
    const accessToken = await exchangeOAuthCode({
      env: deps.env,
      code,
      redirectUri: config.callbackUrl,
      ...(deps.github?.fetch === undefined ? {} : { fetch: deps.github.fetch }),
      ...(deps.github?.oauthBaseUrl === undefined ? {} : { oauthBaseUrl: deps.github.oauthBaseUrl }),
    });
    const githubUser = await fetchGithubUser({
      env: deps.env,
      token: accessToken,
      ...(deps.github?.fetch === undefined ? {} : { fetch: deps.github.fetch }),
      ...(deps.github?.apiBaseUrl === undefined ? {} : { apiBaseUrl: deps.github.apiBaseUrl }),
    });
    const [user] = await deps.db
      .insert(users)
      .values({
        githubUserId: githubUser.id,
        githubLogin: githubUser.login,
        avatarUrl: githubUser.avatarUrl,
      })
      .onConflictDoUpdate({
        target: users.githubUserId,
        set: {
          githubLogin: githubUser.login,
          avatarUrl: githubUser.avatarUrl,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (user === undefined) throw new ApiError(500, "INTERNAL", "could not store GitHub user");
    const session = await signSession(deps.env, {
      userId: user.id,
      githubUserId: user.githubUserId,
      githubLogin: user.githubLogin,
    });
    appendCookie(
      reply,
      serializeCookie(SESSION_COOKIE, session, cookieOptions(deps.env, deps.env.sessionTtlSeconds)),
    );
    clearCookie(reply, deps.env, OAUTH_STATE_COOKIE);
    return reply.redirect(`${deps.env.webUrl}${claims.returnTo}`, 302);
  });

  app.post("/v1/auth/logout", async (request, reply: FastifyReply) => {
    requireUser(request);
    clearCookie(reply, deps.env, SESSION_COOKIE);
    return reply.code(204).send();
  });

  app.get("/v1/github/install", async (request, reply: FastifyReply) => {
    const user = requireUser(request);
    if (deps.env.githubAppSlug === null) {
      throw new ApiError(503, "GITHUB_APP_NOT_CONFIGURED", "GITHUB_APP_SLUG is not configured");
    }
    const state = await signState(deps.env, "install", "/projects/new", user.id);
    appendCookie(
      reply,
      serializeCookie(INSTALL_STATE_COOKIE, state, cookieOptions(deps.env, 600)),
    );
    const url = `${deps.env.githubOAuthBaseUrl}/apps/${encodeURIComponent(
      deps.env.githubAppSlug,
    )}/installations/new?state=${encodeURIComponent(state)}`;
    return reply.redirect(url, 302);
  });

  app.get("/v1/github/setup", async (request, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const installationRaw = queryString(query["installation_id"]);
    const setupAction = queryString(query["setup_action"]) ?? "install";
    const state = queryString(query["state"]);
    if (installationRaw === undefined || !/^[1-9][0-9]*$/.test(installationRaw)) {
      throw new ApiError(400, "INVALID_INSTALLATION", "installation_id is required");
    }
    let linkUserId: string | undefined;
    if (state !== undefined) {
      const stateCookie = readCookie(request, INSTALL_STATE_COOKIE);
      if (stateCookie !== state) {
        throw new ApiError(400, "INVALID_INSTALL_STATE", "installation state does not match");
      }
      const claims = await verifyState(deps.env, state, "install");
      if (claims === null) {
        throw new ApiError(400, "INVALID_INSTALL_STATE", "installation state is invalid or expired");
      }
      linkUserId = claims.userId;
    }
    const installationId = Number(installationRaw);
    if (setupAction === "delete") {
      await deps.db
        .update(githubInstallations)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(githubInstallations.installationId, installationId));
      clearCookie(reply, deps.env, INSTALL_STATE_COOKIE);
      return reply.redirect(`${deps.env.webUrl}/projects/new?installation=deleted`, 302);
    }
    const synced = await syncInstallation(
      deps.db,
      deps.env,
      deps,
      installationId,
      setupAction,
      linkUserId,
    );
    clearCookie(reply, deps.env, INSTALL_STATE_COOKIE);
    return reply.redirect(
      `${deps.env.webUrl}/projects/new?installationId=${synced.id}`,
      302,
    );
  });
}
