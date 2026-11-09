import { describe, expect, it } from "vitest";
import {
  approvals,
  artifactUploads,
  approvalPolicies,
  auditEvents,
  buildTokens,
  chainTransactions,
  containers,
  databaseAvailable,
  deploymentEvents,
  containerEvents,
  deploymentNotificationReads,
  organizationBudgets,
  organizationMembers,
  organizations,
  notificationChannels,
  projectBudgets,
  deployments,
  getTableColumns,
  getTableName,
  githubInstallations,
  githubInstallationUsers,
  operatorSessions,
  projectMembers,
  projects,
  queryRows,
  releaseFiles,
  releases,
  users,
  walletChallenges,
  wallets,
  webhookDeliveries,
  projectDrafts,
  buildAttempts,
  resourceIndexState,
  resourceIndexCheckpoints,
  walletResources,
  resourceQuotes,
  provisioningTasks,
  provisioningQuoteAcceptances,
  provisioningSteps,
  provisioningTransactions,
  withMigratedTestDatabase,
  type PgColumn,
  type PgTable,
} from "@tapeci/database";

/**
 * SQL Schema + Drizzle 对照: introspect the migrated PostgreSQL database and
 * prove that every Drizzle table/column exists in the database (and vice versa)
 * with a compatible type, the same nullability, default and identity settings.
 * `schema_migrations` is the runner's own ledger and is intentionally ignored.
 */

type InformationSchemaColumn = {
  readonly column_name: string;
  readonly data_type: string;
  readonly udt_name: string;
  readonly is_nullable: "YES" | "NO";
  readonly is_identity: "YES" | "NO";
  readonly identity_generation: "ALWAYS" | "BY DEFAULT" | null;
  readonly column_default: string | null;
  readonly character_maximum_length: number | null;
  readonly numeric_precision: number | null;
  readonly numeric_scale: number | null;
};

/** data_type reported by information_schema for each drizzle column type we use. */
const DATA_TYPE_BY_COLUMN_TYPE: Readonly<Record<string, string>> = {
  PgUUID: "uuid",
  PgText: "text",
  PgVarchar: "character varying",
  PgNumeric: "numeric",
  PgJsonb: "jsonb",
  PgTimestamp: "timestamp with time zone",
  PgBoolean: "boolean",
  PgBigInt53: "bigint",
  PgBigInt64: "bigint",
  PgBigSerial53: "bigint",
  PgBigSerial64: "bigint",
  PgInteger: "integer",
  PgSerial: "integer",
  PgEnumColumn: "USER-DEFINED",
};

const TABLES: readonly { readonly name: string; readonly table: PgTable }[] = [
  { name: getTableName(users), table: users },
  { name: getTableName(auditEvents), table: auditEvents },
  { name: getTableName(wallets), table: wallets },
  { name: getTableName(githubInstallations), table: githubInstallations },
  { name: getTableName(githubInstallationUsers), table: githubInstallationUsers },
  { name: getTableName(containers), table: containers },
  { name: getTableName(projects), table: projects },
  { name: getTableName(projectMembers), table: projectMembers },
  { name: getTableName(webhookDeliveries), table: webhookDeliveries },
  // P2 provisioning persistence (migration 0015).
  { name: getTableName(resourceIndexState), table: resourceIndexState },
  { name: getTableName(resourceIndexCheckpoints), table: resourceIndexCheckpoints },
  { name: getTableName(walletResources), table: walletResources },
  { name: getTableName(resourceQuotes), table: resourceQuotes },
  { name: getTableName(provisioningTasks), table: provisioningTasks },
  { name: getTableName(provisioningQuoteAcceptances), table: provisioningQuoteAcceptances },
  { name: getTableName(provisioningSteps), table: provisioningSteps },
  { name: getTableName(provisioningTransactions), table: provisioningTransactions },
  // P4 drafts and build attempts (migration 0016).
  { name: getTableName(projectDrafts), table: projectDrafts },
  { name: getTableName(buildAttempts), table: buildAttempts },
  { name: getTableName(deploymentNotificationReads), table: deploymentNotificationReads },
  { name: getTableName(containerEvents), table: containerEvents },
  { name: getTableName(projectBudgets), table: projectBudgets },
  { name: getTableName(approvalPolicies), table: approvalPolicies },
  { name: getTableName(notificationChannels), table: notificationChannels },
  { name: getTableName(organizations), table: organizations },
  { name: getTableName(organizationMembers), table: organizationMembers },
  { name: getTableName(organizationBudgets), table: organizationBudgets },
  { name: getTableName(deployments), table: deployments },
  { name: getTableName(releaseFiles), table: releaseFiles },
  { name: getTableName(chainTransactions), table: chainTransactions },
  { name: getTableName(approvals), table: approvals },
  { name: getTableName(releases), table: releases },
  { name: getTableName(deploymentEvents), table: deploymentEvents },
  { name: getTableName(walletChallenges), table: walletChallenges },
  { name: getTableName(buildTokens), table: buildTokens },
  { name: getTableName(artifactUploads), table: artifactUploads },
  { name: getTableName(operatorSessions), table: operatorSessions },
];

async function informationSchemaColumns(
  databaseUrl: string,
  table: string,
): Promise<InformationSchemaColumn[]> {
  return queryRows<InformationSchemaColumn>(
    databaseUrl,
    `SELECT column_name, data_type, udt_name, is_nullable, is_identity,
            identity_generation, column_default, character_maximum_length,
            numeric_precision, numeric_scale
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
}

async function enumLabels(databaseUrl: string): Promise<Map<string, string[]>> {
  const rows = await queryRows<{ name: string; label: string }>(
    databaseUrl,
    `SELECT t.typname AS name, e.enumlabel AS label
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname, e.enumsortorder`,
  );
  const labels = new Map<string, string[]>();
  for (const row of rows) {
    const existing = labels.get(row.name);
    if (existing === undefined) {
      labels.set(row.name, [row.label]);
    } else {
      existing.push(row.label);
    }
  }
  return labels;
}

const databaseAvailableNow = await databaseAvailable();

describe.skipIf(!databaseAvailableNow)("P2-01 SQL/Drizzle schema parity", () => {
  it("mirrors every migrated table and column", async () => {
    await withMigratedTestDatabase(async ({ url }) => {
      const dbEnums = await enumLabels(url);
      const schemaEnumNames = new Set<string>();

      for (const { name, table } of TABLES) {
        const dbColumns = await informationSchemaColumns(url, name);
        const dbColumnsByName = new Map(dbColumns.map((column) => [column.column_name, column]));
        // getTableColumns keys are the TypeScript property names; map to SQL names.
        const drizzleColumns = new Map(
          Object.values(getTableColumns(table)).map((column) => [column.name, column]),
        );
        const drizzleEntries = [...drizzleColumns.entries()];

        // Column count + name parity in both directions.
        expect(
          drizzleEntries.length,
          `${name}: drizzle declares ${drizzleEntries.length} columns, database has ${dbColumns.length}`,
        ).toBe(dbColumns.length);
        for (const [columnName, column] of drizzleEntries) {
          const dbColumn = dbColumnsByName.get(columnName);
          expect(dbColumn, `${name}.${columnName} is missing from the migrated database`).toBeDefined();
          if (dbColumn === undefined) continue;
          assertColumnParity(name, columnName, column, dbColumn, dbEnums, schemaEnumNames);
        }
        for (const dbColumn of dbColumns) {
          expect(
            drizzleColumns.has(dbColumn.column_name),
            `${name}.${dbColumn.column_name} exists in the database but not in schema.ts`,
          ).toBe(true);
        }
      }

      // Concrete DB enum types must match the drizzle enum label lists.
      expect(schemaEnumNames.size).toBeGreaterThan(0);
      for (const enumName of dbEnums.keys()) {
        expect(schemaEnumNames.has(enumName), `database enum ${enumName} is not used by schema.ts`).toBe(
          true,
        );
      }
    });
  });

  it("defines exactly the expected public tables (migration ledger excepted)", async () => {
    await withMigratedTestDatabase(async ({ url }) => {
      const rows = await queryRows<{ table_name: string }>(
        url,
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
      );
      const databaseTables = rows
        .map((row) => row.table_name)
        .filter((table) => table !== "schema_migrations")
        .sort();
      const drizzleTables = TABLES.map(({ name }) => name).sort();
      expect(databaseTables).toEqual(drizzleTables);
    });
  });

  it("installs the critical partial unique indexes with their predicates", async () => {
    await withMigratedTestDatabase(async ({ url }) => {
      const indexes = await queryRows<{ tablename: string; indexdef: string }>(
        url,
        "SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'",
      );
      const uniqueIndexes = indexes.filter((row) => row.indexdef.startsWith("CREATE UNIQUE INDEX"));

      const chainWriter = uniqueIndexes.find(
        (row) => row.tablename === "deployments" && row.indexdef.includes("WHERE"),
      );
      expect(chainWriter, "deployments one-chain-writer partial unique index is missing").toBeDefined();
      expect(chainWriter?.indexdef).toContain("(container_id)");
      for (const state of [
        "APPROVED",
        "UPLOADING_ASSETS",
        "VERIFYING_ASSETS",
        "SWITCHING_ENTRY",
        "VERIFYING_RELEASE",
      ]) {
        expect(chainWriter?.indexdef, `partial predicate must include ${state}`).toContain(state);
      }

      const currentRelease = uniqueIndexes.find(
        (row) => row.tablename === "releases" && row.indexdef.includes("WHERE"),
      );
      expect(currentRelease, "releases one-current partial unique index is missing").toBeDefined();
      expect(currentRelease?.indexdef).toContain("(project_id)");
      expect(currentRelease?.indexdef).toContain("is_current = true");

      const hasUniqueOn = (table: string, columns: readonly string[]): boolean =>
        uniqueIndexes.some(
          (row) =>
            row.tablename === table &&
            !row.indexdef.includes("WHERE") &&
            columns.every((column) => row.indexdef.includes(column)),
        );
      expect(hasUniqueOn("chain_transactions", ["chain_id", "tx_hash"])).toBe(true);
      expect(
        hasUniqueOn("chain_transactions", [
          "deployment_id",
          "operation_fingerprint",
          "nonce",
        ]),
      ).toBe(true);
    });
  });

  it("binds audit_events to projects/organizations with SET NULL scope FKs", async () => {
    await withMigratedTestDatabase(async ({ url }) => {
      const indexes = await queryRows<{ indexname: string; indexdef: string }>(
        url,
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'audit_events'
          ORDER BY indexname`,
      );
      const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));

      for (const [indexName, column] of [
        ["audit_events_project_idx", "project_id"],
        ["audit_events_organization_idx", "organization_id"],
      ] as const) {
        const definition = byName.get(indexName);
        expect(definition, `audit_events index ${indexName} is missing`).toBeDefined();
        expect(definition, `${indexName} must index ${column}`).toContain(`(${column}, created_at DESC)`);
      }

      // Deleting a project/organization must keep the trail but drop the scope.
      const foreignKeys = await queryRows<{ column_name: string; delete_rule: string }>(
        url,
        `SELECT kcu.column_name, rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
            AND kcu.constraint_schema = tc.constraint_schema
           JOIN information_schema.referential_constraints rc
             ON rc.constraint_name = tc.constraint_name
            AND rc.constraint_schema = tc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = 'public'
            AND tc.table_name = 'audit_events'`,
      );
      const rules = new Map(foreignKeys.map((row) => [row.column_name, row.delete_rule]));
      expect(rules.get("project_id"), "audit_events.project_id ON DELETE").toBe("SET NULL");
      expect(rules.get("organization_id"), "audit_events.organization_id ON DELETE").toBe("SET NULL");
    });
  });
});

function assertColumnParity(
  tableName: string,
  columnName: string,
  column: PgColumn,
  dbColumn: InformationSchemaColumn,
  dbEnums: Map<string, string[]>,
  schemaEnumNames: Set<string>,
): void {
  const label = `${tableName}.${columnName}`;
  const expectedDataType = DATA_TYPE_BY_COLUMN_TYPE[column.columnType];
  expect(expectedDataType, `${label}: unmapped drizzle column type ${column.columnType}`).toBeDefined();
  expect(dbColumn.data_type, `${label}: data_type`).toBe(expectedDataType);

  expect(column.notNull, `${label}: nullability`).toBe(dbColumn.is_nullable === "NO");

  // Defaults must agree (identity columns express their default via identity).
  const identity = column.generatedIdentity;
  if (identity === undefined) {
    expect(column.hasDefault, `${label}: default presence`).toBe(dbColumn.column_default !== null);
  } else {
    expect(dbColumn.is_identity, `${label}: should be an identity column`).toBe("YES");
    expect(dbColumn.identity_generation).toBe(
      identity.type === "always" ? "ALWAYS" : "BY DEFAULT",
    );
  }

  if (column.columnType === "PgEnumColumn") {
    const enumName = column.getSQLType();
    schemaEnumNames.add(enumName);
    expect(dbColumn.udt_name, `${label}: enum type name`).toBe(enumName);
    expect(dbColumn.data_type, `${label}: enum data_type`).toBe("USER-DEFINED");
    expect(dbEnums.get(enumName), `${label}: enum labels`).toEqual(column.enumValues);
    return;
  }

  const sqlType = column.getSQLType();
  if (column.columnType === "PgVarchar") {
    const match = /^varchar\((\d+)\)$/.exec(sqlType);
    expect(match, `${label}: expected a varchar length in ${sqlType}`).not.toBeNull();
    if (match !== null) {
      expect(dbColumn.character_maximum_length, `${label}: varchar length`).toBe(Number(match[1]));
    }
  }
  if (column.columnType === "PgNumeric") {
    const match = /^numeric\((\d+), (\d+)\)$/.exec(sqlType);
    expect(match, `${label}: expected numeric precision/scale in ${sqlType}`).not.toBeNull();
    if (match !== null) {
      expect(dbColumn.numeric_precision, `${label}: numeric precision`).toBe(Number(match[1]));
      expect(dbColumn.numeric_scale, `${label}: numeric scale`).toBe(Number(match[2]));
    }
  }
}
