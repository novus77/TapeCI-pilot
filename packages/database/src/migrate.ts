import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import pg from "pg";

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

interface MigrationFile {
  readonly name: string;
  readonly upPath: string;
  readonly downPath: string;
}

async function listMigrations(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".up.sql"))
    .sort();
  return names.map((upFile) => {
    const name = upFile.slice(0, -".up.sql".length);
    return {
      name,
      upPath: join(directory, upFile),
      downPath: join(directory, `${name}.down.sql`),
    };
  });
}

async function connect(databaseUrl: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  return client;
}

async function ensureMigrationTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedNames(client: pg.Client): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  return result.rows.map((row) => row.name);
}

/** Apply all pending `.up.sql` migrations in order. Returns the applied names. */
export async function migrateUp(
  databaseUrl: string,
  directory: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  const client = await connect(databaseUrl);
  const applied: string[] = [];
  try {
    await ensureMigrationTable(client);
    const done = new Set(await appliedNames(client));
    for (const migration of await listMigrations(directory)) {
      if (done.has(migration.name)) continue;
      const sql = await readFile(migration.upPath, "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [migration.name]);
        await client.query("COMMIT");
        applied.push(migration.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}

/**
 * Roll back the newest `steps` migrations using their `.down.sql` files. A
 * migration without a down file is refused (never silently forgotten).
 */
export async function migrateDown(
  databaseUrl: string,
  directory: string = DEFAULT_MIGRATIONS_DIR,
  steps = 1,
): Promise<string[]> {
  const client = await connect(databaseUrl);
  const rolledBack: string[] = [];
  try {
    await ensureMigrationTable(client);
    const done = new Set(await appliedNames(client));
    const migrations = (await listMigrations(directory)).filter((migration) =>
      done.has(migration.name),
    );
    for (let index = 0; index < steps; index += 1) {
      const migration = migrations[migrations.length - 1 - index];
      if (migration === undefined) break;
      let sql: string;
      try {
        sql = await readFile(migration.downPath, "utf8");
      } catch {
        throw new Error(`migration ${migration.name} has no down file; refusing to roll back`);
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("DELETE FROM schema_migrations WHERE name = $1", [migration.name]);
        await client.query("COMMIT");
        rolledBack.push(migration.name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return rolledBack;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error("DATABASE_URL is required");
    process.exitCode = 2;
    return;
  }
  const action = process.argv[2] ?? "up";
  const steps = Number(process.argv[3] ?? "1");
  if (action === "up") {
    const applied = await migrateUp(databaseUrl);
    console.log(applied.length === 0 ? "no pending migrations" : `applied: ${applied.join(", ")}`);
  } else if (action === "down") {
    const rolled = await migrateDown(databaseUrl, undefined, steps);
    console.log(rolled.length === 0 ? "nothing to roll back" : `rolled back: ${rolled.join(", ")}`);
  } else {
    console.error(`unknown action: ${action} (use up or down)`);
    process.exitCode = 2;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}

export { DEFAULT_MIGRATIONS_DIR };
