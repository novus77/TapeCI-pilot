import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import type { Database } from "@tapeci/database";
import { users } from "@tapeci/database";
import type { ApiEnv } from "./env.js";
import { ApiError } from "./errors.js";
import { SESSION_COOKIE, readCookie, verifySession } from "./session.js";

export interface AuthUser {
  readonly id: string;
  readonly githubUserId: number;
  readonly githubLogin: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

async function userById(db: Database, userId: string): Promise<AuthUser> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (row === undefined) {
    throw new ApiError(401, "AUTH_REQUIRED", "session user no longer exists");
  }
  return { id: row.id, githubUserId: row.githubUserId, githubLogin: row.githubLogin };
}

/**
 * Resolve the request user from the signed session cookie. When
 * `TAPECI_DEV_AUTH=1` and no cookie is present, the dev headers are accepted so
 * local tests and the mock console keep working. A present-but-invalid cookie is
 * always rejected instead of falling back to dev headers.
 */
export async function resolveUser(
  db: Database,
  env: ApiEnv,
  request: FastifyRequest,
): Promise<AuthUser> {
  const sessionToken = readCookie(request, SESSION_COOKIE);
  if (sessionToken !== undefined && sessionToken !== "") {
    const claims = await verifySession(env, sessionToken);
    if (claims === null) {
      throw new ApiError(401, "AUTH_REQUIRED", "session cookie is invalid or expired");
    }
    return userById(db, claims.userId);
  }
  if (!env.devAuth) {
    throw new ApiError(401, "AUTH_REQUIRED", "GitHub login is required");
  }
  const rawId = header(request, "x-tapeci-github-user-id") ?? "1";
  const githubUserId = Number(rawId);
  if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0) {
    throw new ApiError(401, "AUTH_REQUIRED", "invalid dev user id");
  }
  const githubLogin = header(request, "x-tapeci-github-login") ?? "dev-user";
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.githubUserId, githubUserId))
    .limit(1);
  if (existing !== undefined) {
    return { id: existing.id, githubUserId: existing.githubUserId, githubLogin: existing.githubLogin };
  }
  const [created] = await db
    .insert(users)
    .values({ githubUserId, githubLogin })
    .onConflictDoUpdate({
      target: users.githubUserId,
      set: { githubLogin, updatedAt: new Date() },
    })
    .returning();
  if (created === undefined) throw new ApiError(500, "INTERNAL", "could not create dev user");
  return { id: created.id, githubUserId: created.githubUserId, githubLogin: created.githubLogin };
}

export function requireUser(request: FastifyRequest): AuthUser {
  if (request.user === undefined) throw new ApiError(401, "AUTH_REQUIRED", "not authenticated");
  return request.user;
}
