import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appliedMigrations,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  githubInstallationUsers,
  githubInstallations,
  migrateUp,
  organizationMembers,
  organizations,
  projectMembers,
  projects,
  queryRows,
  users,
  type Database,
} from "@tapeci/database";
import { projectAccess } from "../../../apps/api/src/project-access.js";
import { realIntegrationEnabled } from "../../../scripts/real-integrations/common.js";

const enabled = realIntegrationEnabled();
const dbAvailable = enabled ? await databaseAvailable() : false;

const suffix = randomBytes(6).toString("hex");
const ownerGithubId = 7_600_000_000 + randomBytes(3).readUIntBE(0, 3);
const memberGithubId = ownerGithubId + 1;
const outsiderGithubId = ownerGithubId + 2;
const installationNumericId = ownerGithubId + 3;
const repositoryId = ownerGithubId + 4;

const address = (byte: string): string => `0x${byte.repeat(40)}`;

describe.skipIf(!enabled || !dbAvailable)(
  "PostgreSQL migration, transaction and authorization persistence",
  () => {
    let database: Awaited<ReturnType<typeof createTestDatabase>>;
    let handle: ReturnType<typeof createDatabase>;
    let db: Database;

    beforeAll(async () => {
      database = await createTestDatabase();
      await migrateUp(database.url);
      handle = createDatabase(database.url);
      db = handle.db;
    }, 60_000);

    afterAll(async () => {
      await handle?.pool.end();
      await database?.drop();
    }, 30_000);

    it("applies every migration exactly once to the random test database", async () => {
      const migrations = await appliedMigrations(database.url);
      expect(migrations).toHaveLength(13);
      expect(migrations.at(0)).toBe("0001_init");
      expect(migrations.at(-1)).toBe("0013_project_path_mode");
      expect(await migrateUp(database.url)).toEqual([]);
    });

    it("rolls back a failed transaction without leaving partial rows", async () => {
      await expect(
        db.transaction(async (tx) => {
          await tx
            .insert(users)
            .values({
              githubUserId: ownerGithubId,
              githubLogin: `owner-${suffix}`,
            });
          throw new Error("force rollback");
        }),
      ).rejects.toThrow("force rollback");

      const rows = await queryRows<{ count: number }>(
        database.url,
        "SELECT count(*)::int AS count FROM users WHERE github_user_id = $1",
        [ownerGithubId],
      );
      expect(rows[0]?.count).toBe(0);
    });

    it("persists multi-user and multi-tenant authorization after reconnecting", async () => {
      const [owner, member, outsider] = await db
        .insert(users)
        .values([
          { githubUserId: ownerGithubId, githubLogin: `owner-${suffix}` },
          { githubUserId: memberGithubId, githubLogin: `member-${suffix}` },
          { githubUserId: outsiderGithubId, githubLogin: `outsider-${suffix}` },
        ])
        .returning();
      expect(owner).toBeDefined();
      expect(member).toBeDefined();
      expect(outsider).toBeDefined();

      const [installation] = await db
        .insert(githubInstallations)
        .values({
          installationId: installationNumericId,
          githubAccountId: ownerGithubId,
          accountLogin: `org-${suffix}`,
        })
        .returning();
      const [organization] = await db
        .insert(organizations)
        .values({
          name: `TapeCI ${suffix}`,
          slug: `tapeci-${suffix}`,
          ownerUserId: owner!.id,
        })
        .returning();
      const [container] = await queryRows<{ id: string }>(
        database.url,
        `INSERT INTO containers
           (chain_id, factory_address, processor_index, processor_address, token_id,
            container_address, registry_address, binding_address)
         VALUES (196, $1, 0, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          address("1"),
          address("2"),
          String(ownerGithubId),
          address("3"),
          address("4"),
          address("5"),
        ],
      ).then((rows) => rows);
      const [project] = await db
        .insert(projects)
        .values({
          ownerUserId: owner!.id,
          organizationId: organization!.id,
          githubInstallationId: installation!.id,
          githubRepositoryId: repositoryId,
          repoFullName: `org-${suffix}/site`,
          containerId: container!.id,
        })
        .returning();

      await db.insert(githubInstallationUsers).values([
        { installationId: installation!.id, userId: owner!.id, role: "owner" },
        { installationId: installation!.id, userId: member!.id, role: "member" },
      ]);
      await db.insert(organizationMembers).values([
        { organizationId: organization!.id, userId: owner!.id, role: "owner" },
        { organizationId: organization!.id, userId: member!.id, role: "admin" },
      ]);
      await db
        .insert(projectMembers)
        .values({ projectId: project!.id, userId: owner!.id, role: "owner" });

      await handle.pool.end();
      handle = createDatabase(database.url);
      db = handle.db;

      await expect(projectAccess(db, project!.id, owner!.id)).resolves.toMatchObject({
        role: "owner",
        via: "project",
      });
      await expect(projectAccess(db, project!.id, member!.id)).resolves.toMatchObject({
        role: "maintainer",
        via: "organization",
      });
      await expect(projectAccess(db, project!.id, outsider!.id)).resolves.toBeNull();

      const installationMembers = await db
        .select()
        .from(githubInstallationUsers);
      expect(installationMembers).toHaveLength(2);
      expect(await db.select().from(organizationMembers)).toHaveLength(2);
    });

    it("rejects a duplicate installation membership under concurrency", async () => {
      const [installation] = await db
        .select()
        .from(githubInstallations);
      const [member] = await db.select().from(users);
      expect(installation).toBeDefined();
      expect(member).toBeDefined();

      const results = await Promise.allSettled([
        db.insert(githubInstallationUsers).values({
          installationId: installation!.id,
          userId: member!.id,
          role: "member",
        }),
        db.insert(githubInstallationUsers).values({
          installationId: installation!.id,
          userId: member!.id,
          role: "member",
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(0);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    });
  },
);
