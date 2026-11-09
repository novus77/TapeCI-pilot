/** GitHub App installation sync, token cache and repository listing. */
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  InstallationTokenCache,
  getInstallation,
  listInstallationRepositories,
  type GitHubFetch,
  type GitHubRepositorySummary,
} from "@tapeci/github";
import {
  githubInstallationUsers,
  githubInstallations,
  type Database,
} from "@tapeci/database";
import type { ApiDeps } from "./deps.js";
import type { ApiEnv } from "./env.js";
import { ApiError } from "./errors.js";

export interface GithubAppRuntimeConfig {
  readonly appId: string;
  readonly privateKey: string;
  readonly apiBaseUrl: string;
  readonly fetch?: GitHubFetch;
  readonly now?: () => Date;
}

interface CacheEntry {
  readonly key: string;
  readonly cache: InstallationTokenCache;
}

let sharedCache: CacheEntry | null = null;

export function requireGithubAppConfig(
  env: ApiEnv,
  github?: ApiDeps["github"],
): GithubAppRuntimeConfig {
  if (env.githubAppId === null || env.githubAppPrivateKey === null) {
    throw new ApiError(503, "GITHUB_APP_NOT_CONFIGURED", "GitHub App credentials are not configured");
  }
  return {
    appId: env.githubAppId,
    privateKey: env.githubAppPrivateKey,
    apiBaseUrl: github?.apiBaseUrl ?? env.githubApiBaseUrl,
    ...(github?.fetch === undefined ? {} : { fetch: github.fetch }),
    ...(github?.now === undefined ? {} : { now: github.now }),
  };
}

function tokenCache(env: ApiEnv, deps: ApiDeps): InstallationTokenCache {
  const config = requireGithubAppConfig(env, deps.github);
  const key = `${config.appId}|${config.apiBaseUrl}`;
  if (sharedCache === null || sharedCache.key !== key) {
    sharedCache = {
      key,
      cache: new InstallationTokenCache({
        appId: config.appId,
        privateKey: config.privateKey,
        apiBaseUrl: config.apiBaseUrl,
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
        ...(config.now === undefined ? {} : { now: config.now }),
      }),
    };
  }
  return sharedCache.cache;
}

export async function installationToken(
  env: ApiEnv,
  deps: ApiDeps,
  installationId: number,
): Promise<string> {
  return (await tokenCache(env, deps).get(installationId)).token;
}

export interface SyncedInstallation {
  readonly id: string;
  readonly installationId: number;
  readonly accountLogin: string;
}

export async function syncInstallation(
  db: Database,
  env: ApiEnv,
  deps: ApiDeps,
  installationId: number,
  setupAction?: string,
  linkUserId?: string,
): Promise<SyncedInstallation> {
  const config = requireGithubAppConfig(env, deps.github);
  const details = await getInstallation({
    appId: config.appId,
    privateKey: config.privateKey,
    apiBaseUrl: config.apiBaseUrl,
    installationId,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(config.now === undefined ? {} : { now: config.now }),
  });
  const deleted = setupAction === "delete";
  const [row] = await db
    .insert(githubInstallations)
    .values({
      installationId: details.id,
      githubAccountId: details.account.id,
      accountLogin: details.account.login,
      suspendedAt: details.suspendedAt,
      deletedAt: deleted ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: githubInstallations.installationId,
      set: {
        githubAccountId: details.account.id,
        accountLogin: details.account.login,
        suspendedAt: details.suspendedAt,
        deletedAt: deleted ? new Date() : null,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (row === undefined) throw new ApiError(500, "INTERNAL", "could not store installation");
  if (!deleted && linkUserId !== undefined) {
    await db
      .insert(githubInstallationUsers)
      .values({ installationId: row.id, userId: linkUserId, role: "owner" })
      .onConflictDoNothing();
  }
  return { id: row.id, installationId: row.installationId, accountLogin: row.accountLogin };
}

export async function listInstallationsForUser(
  db: Database,
  userId: string,
): Promise<ReadonlyArray<typeof githubInstallations.$inferSelect>> {
  const rows = await db
    .select({ installation: githubInstallations })
    .from(githubInstallations)
    .innerJoin(
      githubInstallationUsers,
      eq(githubInstallationUsers.installationId, githubInstallations.id),
    )
    .where(and(eq(githubInstallationUsers.userId, userId), isNull(githubInstallations.deletedAt)))
    .orderBy(desc(githubInstallations.createdAt));
  return rows.map((row) => row.installation);
}

export async function assertInstallationAccess(
  db: Database,
  userId: string,
  installationDatabaseId: string,
  allowDevBypass: boolean,
): Promise<void> {
  if (allowDevBypass) return;
  const [row] = await db
    .select({ id: githubInstallationUsers.id })
    .from(githubInstallationUsers)
    .where(
      and(
        eq(githubInstallationUsers.installationId, installationDatabaseId),
        eq(githubInstallationUsers.userId, userId),
      ),
    )
    .limit(1);
  if (row === undefined) {
    throw new ApiError(
      403,
      "REPOSITORY_NOT_AUTHORIZED",
      "this GitHub installation is not linked to your account",
    );
  }
}

export async function installationRepositories(
  db: Database,
  env: ApiEnv,
  deps: ApiDeps,
  databaseId: string,
  userId: string,
): Promise<readonly GitHubRepositorySummary[]> {
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, databaseId))
    .limit(1);
  if (row === undefined) throw new ApiError(404, "INSTALLATION_NOT_FOUND", "installation not found");
  await assertInstallationAccess(db, userId, row.id, false);
  if (row.deletedAt !== null) {
    throw new ApiError(409, "AUTH_REVOKED", "installation was deleted");
  }
  if (row.suspendedAt !== null) {
    throw new ApiError(409, "AUTH_REVOKED", "installation is suspended");
  }
  const token = await installationToken(env, deps, row.installationId);
  return listInstallationRepositories({
    token,
    apiBaseUrl: deps.github?.apiBaseUrl ?? env.githubApiBaseUrl,
    ...(deps.github?.fetch === undefined ? {} : { fetch: deps.github.fetch }),
  });
}

/** Test helper: drop the process-level token cache. */
export function clearInstallationTokenCache(): void {
  sharedCache?.cache.clear();
  sharedCache = null;
}
