import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

/** Drizzle handle plus the underlying pool (raw CAS SQL needs `$client`). */
export type Database = NodePgDatabase<typeof schema> & { readonly $client: pg.Pool };

export function createDatabase(databaseUrl: string): {
  pool: pg.Pool;
  db: Database;
} {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema }) as NodePgDatabase<typeof schema>;
  return { pool, db: Object.assign(db, { $client: pool }) as Database };
}
