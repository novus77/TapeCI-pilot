/**
 * Periodic reconciliation of `github_installations` against GitHub.
 *
 * GitHub is authoritative: an installation missing from `GET /app/installations`
 * is soft-deleted, and `suspended_at` is mirrored. A failed/partial GitHub
 * response aborts the run without changing the database.
 */
import { eq, isNull, notInArray } from "drizzle-orm";
import { listAppInstallations } from "@tapeci/github";
import { githubInstallations, type Database } from "@tapeci/database";
import type { ApiEnv } from "./env.js";
import { requireGithubAppConfig, type GithubAppRuntimeConfig } from "./github-app.js";

export interface ReconcileInstallationsOptions {
  readonly db: Database;
  readonly env: ApiEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly apiBaseUrl?: string;
  readonly now?: () => Date;
}

export interface ReconcileInstallationsResult {
  readonly listed: number;
  readonly created: number;
  readonly updated: number;
  readonly markedDeleted: number;
  readonly suspended: number;
}

export async function reconcileInstallations(
  options: ReconcileInstallationsOptions,
): Promise<ReconcileInstallationsResult> {
  const config: GithubAppRuntimeConfig = requireGithubAppConfig(options.env, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.apiBaseUrl === undefined ? {} : { apiBaseUrl: options.apiBaseUrl }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const listed = await listAppInstallations({
    appId: config.appId,
    privateKey: config.privateKey,
    apiBaseUrl: config.apiBaseUrl,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(config.now === undefined ? {} : { now: config.now }),
  });
  const now = options.now?.() ?? new Date();
  const existing = await options.db
    .select({
      installationId: githubInstallations.installationId,
      deletedAt: githubInstallations.deletedAt,
    })
    .from(githubInstallations);
  const existingIds = new Set(existing.map((row) => row.installationId));
  const listedIds = listed.map((row) => row.id);
  const listedSet = new Set(listedIds);
  const markedDeleted = existing.filter(
    (row) => row.deletedAt === null && !listedSet.has(row.installationId),
  ).length;

  let created = 0;
  let updated = 0;
  await options.db.transaction(async (tx) => {
    for (const installation of listed) {
      const isNew = !existingIds.has(installation.id);
      await tx
        .insert(githubInstallations)
        .values({
          installationId: installation.id,
          githubAccountId: installation.account.id,
          accountLogin: installation.account.login,
          suspendedAt: installation.suspendedAt,
          deletedAt: null,
        })
        .onConflictDoUpdate({
          target: githubInstallations.installationId,
          set: {
            githubAccountId: installation.account.id,
            accountLogin: installation.account.login,
            suspendedAt: installation.suspendedAt,
            deletedAt: null,
            updatedAt: now,
          },
        });
      if (isNew) created += 1;
      else updated += 1;
    }
    if (listedIds.length === 0) {
      await tx
        .update(githubInstallations)
        .set({ deletedAt: now, updatedAt: now })
        .where(isNull(githubInstallations.deletedAt));
    } else {
      await tx
        .update(githubInstallations)
        .set({ deletedAt: now, updatedAt: now })
        .where(
          notInArray(githubInstallations.installationId, listedIds),
        );
    }
  });

  const suspended = listed.filter((row) => row.suspendedAt !== null).length;
  return {
    listed: listed.length,
    created,
    updated,
    markedDeleted,
    suspended,
  };
}

export async function reconcileInstallationsIfConfigured(
  options: ReconcileInstallationsOptions,
): Promise<ReconcileInstallationsResult | null> {
  if (options.env.githubAppId === null || options.env.githubAppPrivateKey === null) return null;
  return reconcileInstallations(options);
}

/** Used by tests/operators to assert one row without exposing a generic query helper. */
export async function installationRowByNumericId(
  db: Database,
  installationId: number,
): Promise<typeof githubInstallations.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId))
    .limit(1);
  return row ?? null;
}
