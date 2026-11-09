import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  appliedMigrations,
  createDatabase,
  createTestDatabase,
  databaseAvailable,
  migrateDown,
  migrateUp,
  queryRows,
  resetDatabase,
  tableExists,
  type TestDatabase,
} from "@tapeci/database";
import {
  COMMIT_SHA,
  REGISTRY_ADDRESS,
  captureError,
  insertOne,
  seedCore,
} from "./helpers.js";

/**
 * Derived from the migrations directory, never hard-coded: adding a migration must
 * not require editing this file, and a literal list silently rots.
 */
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/database/migrations",
);
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".up.sql"))
  .map((name) => name.replace(/\.up\.sql$/, ""))
  .sort();


const BASELINE_TABLES = [
  "users",
  "wallets",
  "github_installations",
  "containers",
  "projects",
  "webhook_deliveries",
  "deployments",
  "release_files",
  "chain_transactions",
  "approvals",
  "releases",
  "deployment_events",
] as const;

const P2_TABLES = [
  "wallet_challenges",
  "build_tokens",
  "artifact_uploads",
  "project_members",
  "operator_sessions",
  "container_events",
] as const;

const databaseAvailableNow = await databaseAvailable();

describe.skipIf(!databaseAvailableNow)("P2-01 migration runner", () => {
  const databases: TestDatabase[] = [];
  const temporaryDirectories: string[] = [];

  async function freshDatabase(): Promise<TestDatabase> {
    const database = await createTestDatabase();
    databases.push(database);
    return database;
  }

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "tapeci-migrations-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  afterAll(async () => {
    for (const database of databases.splice(0)) {
      await database.drop();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applies 0001+0002 to a fresh database and is idempotent", async () => {
    const database = await freshDatabase();

    expect(await migrateUp(database.url)).toEqual(ALL_MIGRATIONS);
    expect(await appliedMigrations(database.url)).toEqual(ALL_MIGRATIONS);
    for (const table of [...BASELINE_TABLES, ...P2_TABLES]) {
      expect(await tableExists(database.url, table), `table ${table} should exist`).toBe(true);
    }

    // A second run must apply nothing and leave the migration ledger untouched.
    expect(await migrateUp(database.url)).toEqual([]);
    expect(await appliedMigrations(database.url)).toEqual(ALL_MIGRATIONS);
  });

  it("rolls back 0002 without touching baseline audit rows, then re-applies it", async () => {
    const database = await freshDatabase();
    await migrateUp(database.url);

    const userId = insertOne(
      await queryRows<{ id: string }>(
        database.url,
        "INSERT INTO users (github_user_id, github_login) VALUES ($1, $2) RETURNING id",
        [9_100, "audit-owner"],
      ),
    ).id;
    const installationId = insertOne(
      await queryRows<{ id: string }>(
        database.url,
        `INSERT INTO github_installations (installation_id, github_account_id, account_login)
         VALUES ($1, $2, $3) RETURNING id`,
        [9_101, 9_102, "audit-org"],
      ),
    ).id;
    const containerId = insertOne(
      await queryRows<{ id: string }>(
        database.url,
        `INSERT INTO containers
           (chain_id, factory_address, processor_index, processor_address, token_id,
            container_address, registry_address, binding_address)
         VALUES (196, $1, 0, $2, $3, $4, $5, $6) RETURNING id`,
        [
          "0x1111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222",
          "1",
          "0x3333333333333333333333333333333333333333",
          REGISTRY_ADDRESS,
          "0x5555555555555555555555555555555555555555",
        ],
      ),
    ).id;
    const projectId = insertOne(
      await queryRows<{ id: string }>(
        database.url,
        `INSERT INTO projects
           (owner_user_id, github_installation_id, github_repository_id, repo_full_name, container_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, installationId, 9_103, "audit-org/site", containerId],
      ),
    ).id;
    const deliveryId = insertOne(
      await queryRows<{ id: string }>(
        database.url,
        `INSERT INTO webhook_deliveries (github_delivery_id, event_type, commit_sha, accepted)
         VALUES ($1, $2, $3, true) RETURNING id`,
        ["audit-delivery-1", "push", COMMIT_SHA],
      ),
    ).id;
    const deploymentId = insertOne(
      await queryRows<{ id: string }>(
        database.url,
        `INSERT INTO deployments
           (project_id, container_id, created_by_user_id, webhook_delivery_id, trigger_kind,
            commit_sha, registry_address, approved_cost_cap_wei, estimated_cost_wei, plan_json)
         VALUES ($1, $2, $3, $4, 'webhook', $5, $6, $7, $8, $9) RETURNING id`,
        [
          projectId,
          containerId,
          userId,
          deliveryId,
          COMMIT_SHA,
          REGISTRY_ADDRESS,
          "1000000000000000000",
          "900000000000000000",
          JSON.stringify({ chainId: 196, steps: [{ operation: "writeChunk", index: 0 }] }),
        ],
      ),
    ).id;
    insertOne(
      await queryRows<{ id: string }>(
        database.url,
        `INSERT INTO deployment_events
           (deployment_id, old_state, new_state, event_type, actor_kind, actor_id, payload)
         VALUES ($1, NULL, 'RECEIVED', 'deployment_requested', 'webhook', $2, $3) RETURNING id`,
        [deploymentId, "delivery-1", JSON.stringify({ source: "push", step: 1 })],
      ),
    );

    // P2 tables hold rows that the down migration is allowed to drop.
    await queryRows(
      database.url,
      `INSERT INTO wallet_challenges (address, chain_id, nonce, message, expires_at)
       VALUES ($1, 196, $2, $3, now() + interval '5 minutes')`,
      ["0x8888888888888888888888888888888888888888", "audit-nonce", "sign in"],
    );

    expect(await migrateDown(database.url, undefined, ALL_MIGRATIONS.length - 1)).toEqual([...ALL_MIGRATIONS].reverse().slice(0, ALL_MIGRATIONS.length - 1));
    expect(await appliedMigrations(database.url)).toEqual(["0001_init"]);

    for (const table of P2_TABLES) {
      expect(await tableExists(database.url, table), `table ${table} should be gone`).toBe(false);
    }
    for (const table of BASELINE_TABLES) {
      expect(await tableExists(database.url, table), `table ${table} should survive`).toBe(true);
    }

    const [user] = await queryRows<{ github_login: string }>(
      database.url,
      "SELECT github_login FROM users WHERE id = $1",
      [userId],
    );
    expect(user?.github_login).toBe("audit-owner");

    const [deployment] = await queryRows<{
      state: string;
      commit_sha: string;
      approved_cost_cap_wei: string;
      plan_json: unknown;
    }>(
      database.url,
      `SELECT state, commit_sha, approved_cost_cap_wei::text AS approved_cost_cap_wei, plan_json
       FROM deployments WHERE id = $1`,
      [deploymentId],
    );
    expect(deployment?.state).toBe("RECEIVED");
    expect(deployment?.commit_sha).toBe(COMMIT_SHA);
    expect(deployment?.approved_cost_cap_wei).toBe("1000000000000000000");
    expect(deployment?.plan_json).toEqual({
      chainId: 196,
      steps: [{ operation: "writeChunk", index: 0 }],
    });

    const [event] = await queryRows<{
      new_state: string;
      actor_kind: string;
      payload: unknown;
    }>(
      database.url,
      "SELECT new_state, actor_kind, payload FROM deployment_events WHERE deployment_id = $1",
      [deploymentId],
    );
    expect(event?.new_state).toBe("RECEIVED");
    expect(event?.actor_kind).toBe("webhook");
    expect(event?.payload).toEqual({ source: "push", step: 1 });

    const [delivery] = await queryRows<{ accepted: boolean; commit_sha: string }>(
      database.url,
      "SELECT accepted, commit_sha FROM webhook_deliveries WHERE id = $1",
      [deliveryId],
    );
    expect(delivery?.accepted).toBe(true);
    expect(delivery?.commit_sha).toBe(COMMIT_SHA);

    // Re-applying P2 restores its tables and keeps the audit/data rows untouched.
    expect(await migrateUp(database.url)).toEqual(ALL_MIGRATIONS.slice(1));
    for (const table of P2_TABLES) {
      expect(await tableExists(database.url, table)).toBe(true);
    }
    const [baselineCounts] = await queryRows<{ deployments: number; deployment_events: number }>(
      database.url,
      `SELECT
         (SELECT count(*)::int FROM deployments) AS deployments,
         (SELECT count(*)::int FROM deployment_events) AS deployment_events`,
    );
    expect(baselineCounts).toEqual({ deployments: 1, deployment_events: 1 });
  });

  it("refuses to roll back a migration that has no down file", async () => {
    const database = await freshDatabase();
    await migrateUp(database.url);

    const fixtureDirectory = await temporaryDirectory();
    await writeFile(
      join(fixtureDirectory, "9999_fixture.up.sql"),
      "CREATE TABLE fixture_marker (id INTEGER PRIMARY KEY);\n",
      "utf8",
    );

    expect(await migrateUp(database.url, fixtureDirectory)).toEqual(["9999_fixture"]);
    expect(await tableExists(database.url, "fixture_marker")).toBe(true);

    const error = await captureError(migrateDown(database.url, fixtureDirectory, 1));
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/has no down file/);

    // Refusal must not partially apply: the migration stays applied and the DDL sticks.
    expect(await appliedMigrations(database.url)).toContain("9999_fixture");
    expect(await tableExists(database.url, "fixture_marker")).toBe(true);
  });

  it("rolls back the baseline only when explicitly asked for more steps", async () => {
    const database = await freshDatabase();
    await migrateUp(database.url);

    expect(await migrateDown(database.url, undefined, ALL_MIGRATIONS.length)).toEqual([...ALL_MIGRATIONS].reverse());
    expect(await appliedMigrations(database.url)).toEqual([]);
    for (const table of [...BASELINE_TABLES, ...P2_TABLES]) {
      expect(await tableExists(database.url, table), `table ${table} should be gone`).toBe(false);
    }

    // The same database can be migrated forward again.
    expect(await migrateUp(database.url)).toEqual(ALL_MIGRATIONS);
    expect(await tableExists(database.url, "deployment_events")).toBe(true);
  });

  it("resetDatabase returns a migrated database to a pristine state", async () => {
    const database = await freshDatabase();
    await migrateUp(database.url);
    expect(await tableExists(database.url, "users")).toBe(true);

    await resetDatabase(database.url);
    expect(await tableExists(database.url, "users")).toBe(false);

    // The database is reusable for a fresh migration run.
    expect(await migrateUp(database.url)).toEqual(ALL_MIGRATIONS);
    expect(await appliedMigrations(database.url)).toEqual(ALL_MIGRATIONS);
  });

  it("refuses to drop the prepared-artifact columns while a pin still exists", async () => {
    // 0020's down migration used to drop the pin and request unconditionally. For a compressed
    // deployment that is unrecoverable: a NULL request parses as "original", so the frozen bytes
    // can never be found again (Stage C review F2). It must refuse instead.
    const database = await freshDatabase();
    await migrateUp(database.url);
    const handle = createDatabase(database.url);
    try {
      const core = await seedCore(handle.db);
      await queryRows(
        database.url,
        `UPDATE deployments SET prepared_artifact_key = $1, preparation_request = $2::jsonb WHERE id = $3`,
        [`sha256/${"a".repeat(64)}.tar`, JSON.stringify({ schemaVersion: "tapeci.preparation.v1", mode: "gzip-whole", spaFallback: false, gatewayId: "fixture" }), core.deploymentId],
      );
      const error = await captureError(migrateDown(database.url, undefined, ALL_MIGRATIONS.length - 1));
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/refusing to drop prepared-artifact columns/i);

      // The refusal must not partially apply: both columns still exist.
      const columns = await queryRows<{ column_name: string }>(
        database.url,
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'deployments' AND column_name IN ('prepared_artifact_key','preparation_request')`,
      );
      expect(columns.map((column) => column.column_name).sort()).toEqual([
        "preparation_request",
        "prepared_artifact_key",
      ]);
    } finally {
      await handle.pool.end();
    }
  });

});
