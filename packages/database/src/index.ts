export * from "./schema.js";
export * from "./client.js";
export * from "./migrate.js";
export * from "./testing.js";

// Re-export the drizzle primitives consumers (API, workers, tests) need so they
// can consume `@tapeci/database` without depending on drizzle-orm directly.
export { and, eq, getTableColumns, getTableName, sql } from "drizzle-orm";
export type { PgColumn, PgTable } from "drizzle-orm/pg-core";
