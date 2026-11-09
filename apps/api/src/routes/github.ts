import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { users } from "@tapeci/database";
import { requireUser } from "../auth.js";
import type { ApiDeps } from "../deps.js";
import { ApiError } from "../errors.js";
import { installationRepositories, listInstallationsForUser } from "../github-app.js";

export function registerGithubRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get("/v1/users", async (request) => {
    requireUser(request);
    const query = request.query as { q?: string; limit?: string };
    const term = (query.q ?? "").trim();
    // An empty term would return every user on the instance, which is both useless
    // and a disclosure, so require at least two characters.
    if (term.length < 2) return { users: [] };
    const limit = Math.min(Math.max(Number(query.limit ?? "10") || 10, 1), 25);
    const rows = await deps.db
      .select({ id: users.id, githubLogin: users.githubLogin })
      .from(users)
      .where(sql`lower(${users.githubLogin}) like ${`%${term.toLowerCase()}%`}`)
      .orderBy(users.githubLogin)
      .limit(limit);
    return { users: rows };
  });

  app.get("/v1/me", async (request) => {
    const user = requireUser(request);
    return {
      id: user.id,
      githubLogin: user.githubLogin,
      githubUserId: user.githubUserId,
      isAdmin: (deps.env.adminLogins ?? []).includes(user.githubLogin.toLowerCase()),
    };
  });

  app.get("/v1/github/installations/:id/repositories", async (request) => {
    requireUser(request);
    const params = request.params as { id?: string };
    if (params.id === undefined) {
      throw new ApiError(400, "INVALID_PATH", "installation id is required");
    }
    const user = requireUser(request);
    const repositories = await installationRepositories(deps.db, deps.env, deps, params.id, user.id);
    return {
      repositories: repositories.map((repository) => ({
        id: repository.id,
        name: repository.name,
        fullName: repository.fullName,
        private: repository.private,
        defaultBranch: repository.defaultBranch,
        archived: repository.archived,
      })),
    };
  });

  app.get("/v1/github/installations", async (request) => {
    const user = requireUser(request);
    const rows = await listInstallationsForUser(deps.db, user.id);
    return {
      installations: rows.map((row) => ({
        id: row.id,
        installationId: row.installationId,
        accountLogin: row.accountLogin,
        suspended: row.suspendedAt !== null,
      })),
    };
  });
}
