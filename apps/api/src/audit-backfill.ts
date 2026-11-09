import { count, eq, isNull, or } from "drizzle-orm";
import { auditEvents, type Database } from "@tapeci/database";
import { resolveAuditScope } from "./audit.js";

export interface AuditBackfillResult {
  readonly scanned: number;
  readonly updated: number;
  readonly unresolved: number;
  readonly historicalWithoutPath: number;
  readonly applied: boolean;
}

/**
 * Re-resolve project/organization scope for audit rows whose resolver failed.
 * Only rows that carry a concrete `path` can be repaired; rows written before
 * migration 0011 have no path and are reported, never guessed.
 */
export async function backfillAuditScopes(
  db: Database,
  options: { readonly apply?: boolean; readonly limit?: number } = {},
): Promise<AuditBackfillResult> {
  const apply = options.apply === true;
  const limit = Math.min(options.limit ?? 500, 5_000);
  const rows = await db
    .select()
    .from(auditEvents)
    .where(or(isNull(auditEvents.projectId), isNull(auditEvents.organizationId)))
    .limit(limit * 2);
  const repairable = rows.filter((row) => row.path !== null).slice(0, limit);
  let updated = 0;
  let unresolved = 0;
  for (const row of repairable) {
    const scope = await resolveAuditScope(db, row.path ?? "");
    if (scope.projectId === null && scope.organizationId === null) {
      unresolved += 1;
      continue;
    }
    if (apply) {
      await db
        .update(auditEvents)
        .set({ projectId: scope.projectId, organizationId: scope.organizationId })
        .where(eq(auditEvents.id, row.id));
      updated += 1;
    }
  }
  const [historical] = await db
    .select({ value: count() })
    .from(auditEvents)
    .where(isNull(auditEvents.path));
  return {
    scanned: repairable.length,
    updated,
    unresolved,
    historicalWithoutPath: historical?.value ?? 0,
    applied: apply,
  };
}

/** Prometheus textfile metrics for a scheduled backfill run. */
export function renderAuditBackfillMetrics(result: AuditBackfillResult, now = new Date()): string {
  const lines = [
    "# HELP tapeci_audit_backfill_last_run_timestamp_seconds Last backfill completion time",
    "# TYPE tapeci_audit_backfill_last_run_timestamp_seconds gauge",
    `tapeci_audit_backfill_last_run_timestamp_seconds ${Math.floor(now.getTime() / 1000)}`,
    "# HELP tapeci_audit_backfill_scanned Audit rows examined in the last run",
    "# TYPE tapeci_audit_backfill_scanned gauge",
    `tapeci_audit_backfill_scanned ${result.scanned}`,
    "# HELP tapeci_audit_backfill_updated Audit rows repaired in the last run",
    "# TYPE tapeci_audit_backfill_updated gauge",
    `tapeci_audit_backfill_updated ${result.updated}`,
    "# HELP tapeci_audit_backfill_unresolved Audit rows with a path that still does not resolve",
    "# TYPE tapeci_audit_backfill_unresolved gauge",
    `tapeci_audit_backfill_unresolved ${result.unresolved}`,
    "# HELP tapeci_audit_backfill_historical_without_path Rows written before path capture",
    "# TYPE tapeci_audit_backfill_historical_without_path gauge",
    `tapeci_audit_backfill_historical_without_path ${result.historicalWithoutPath}`,
    "",
  ];
  return lines.join("\n");
}
