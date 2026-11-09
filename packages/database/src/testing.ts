import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDatabase, type Database } from "./client.js";
import { migrateUp } from "./migrate.js";

export const DEFAULT_TEST_DATABASE_URL = "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci";
export const DEFAULT_ADMIN_DATABASE_URL = "postgres://tapeci:tapeci@127.0.0.1:55432/postgres";

export function testDatabaseUrl(): string {
  return process.env.TAPECI_TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

function adminDatabaseUrl(): string {
  return process.env.TAPECI_ADMIN_DATABASE_URL ?? DEFAULT_ADMIN_DATABASE_URL;
}

export interface TestDatabase {
  readonly url: string;
  readonly drop: () => Promise<void>;
}

/** Create an ephemeral database on the Docker PostgreSQL service. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = adminDatabaseUrl();
  const name = `tapeci_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const base = new URL(testDatabaseUrl());
  base.pathname = `/${name}`;
  return {
    url: base.toString(),
    drop: async () => {
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

export async function databaseAvailable(adminUrl?: string): Promise<boolean> {
  const client = new pg.Client({
    connectionString: adminUrl ?? adminDatabaseUrl(),
    connectionTimeoutMillis: 2_000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Run a single SQL statement on its own connection and return the rows. */
export async function queryRows<Row extends Record<string, unknown>>(
  databaseUrl: string,
  text: string,
  values?: readonly unknown[],
): Promise<Row[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<Row>(text, values === undefined ? undefined : [...values]);
    return result.rows;
  } finally {
    await client.end();
  }
}

/**
 * Drop and recreate the `public` schema of a test database. Migrations live in
 * `public`, so this returns the database to a pristine state without the cost of
 * creating a brand new database. Never point this at anything but a throwaway DB.
 */
export async function resetDatabase(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end();
  }
}

/** Names applied via `migrateUp`, oldest first (requires the migrations table). */
export async function appliedMigrations(databaseUrl: string): Promise<string[]> {
  const rows = await queryRows<{ name: string }>(
    databaseUrl,
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  return rows.map((row) => row.name);
}

export async function tableExists(databaseUrl: string, table: string): Promise<boolean> {
  const rows = await queryRows<{ present: boolean }>(
    databaseUrl,
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`public.${table}`],
  );
  return rows[0]?.present === true;
}

export interface MigratedTestDatabase {
  readonly url: string;
  readonly db: Database;
  readonly pool: ReturnType<typeof createDatabase>["pool"];
}

/**
 * Run `run` against a fresh ephemeral database with all migrations applied.
 * The database and its pool are always cleaned up, even when the callback throws.
 * The callback receives the database URL so it can also use `queryRows`.
 */
export async function withMigratedTestDatabase<Result>(
  run: (database: MigratedTestDatabase) => Promise<Result>,
): Promise<Result> {
  const testDatabase = await createTestDatabase();
  const handle = createDatabase(testDatabase.url);
  try {
    await migrateUp(testDatabase.url);
    return await run({ url: testDatabase.url, db: handle.db, pool: handle.pool });
  } finally {
    await handle.pool.end();
    await testDatabase.drop();
  }
}
