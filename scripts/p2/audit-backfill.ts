/**
 * Repair audit_events.project_id/organization_id for rows whose resolver failed.
 *
 *   pnpm audit:backfill                  # dry run
 *   pnpm audit:backfill -- --apply       # update rows that carry a concrete path
 *   pnpm audit:backfill -- --watch --interval-seconds 3600 --apply
 *
 * `--textfile <path>` writes Prometheus textfile-collector metrics. With
 * `--fail-on-unresolved`, unresolved rows make the process exit non-zero so a
 * cron/systemd failure alert fires.
 *
 * Rows created before migration 0011 have no path and cannot be attributed
 * reliably; the report counts them but never guesses.
 */
import { rename, writeFile } from "node:fs/promises";
import { createDatabase } from "@tapeci/database";
import { backfillAuditScopes, renderAuditBackfillMetrics } from "../../apps/api/src/audit-backfill.js";

const apply = process.argv.includes("--apply");
const watch = process.argv.includes("--watch");
const failOnUnresolved = process.argv.includes("--fail-on-unresolved");
const value = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const intervalSeconds = Math.max(60, Number(value("--interval-seconds") ?? "3600"));
const textfile = value("--textfile");
const databaseUrl = process.env.DATABASE_URL ?? "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci";
const { db, pool } = createDatabase(databaseUrl);

async function runOnce(): Promise<void> {
  const result = await backfillAuditScopes(db, { apply });
  console.log(JSON.stringify(result, null, 2));
  if (textfile !== undefined) {
    const body = renderAuditBackfillMetrics(result);
    await writeFile(`${textfile}.tmp`, body, "utf8");
    await rename(`${textfile}.tmp`, textfile);
  }
  if (failOnUnresolved && result.unresolved > 0) {
    throw new Error(`${result.unresolved} audit rows still have an unresolved scope`);
  }
}

try {
  if (!watch) {
    await runOnce();
  } else {
    for (;;) {
      try {
        await runOnce();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "audit_backfill_failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        if (!failOnUnresolved) process.exitCode = 1;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1_000));
    }
  }
} finally {
  if (!watch) await pool.end();
}
