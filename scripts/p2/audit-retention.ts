/**
 * Prune audit_events older than N days.
 *
 *   pnpm audit:retention                 # dry run, 90 days
 *   pnpm audit:retention -- --days 180 --apply
 *
 * Defaults to a dry run. Deleting fewer than 30 days is refused unless --force,
 * because audit rows are the evidence trail for releases.
 */
import { Pool } from "pg";

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const days = Number(arg("--days") ?? process.env.TAPECI_AUDIT_RETENTION_DAYS ?? "90");
const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
if (!Number.isInteger(days) || days <= 0) {
  throw new Error("--days must be a positive integer");
}
if (days < 30 && !force) {
  throw new Error("refusing to prune fewer than 30 days without --force");
}
const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const url = process.env.DATABASE_URL ?? "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci";
const pool = new Pool({ connectionString: url });
try {
  const eligible = await pool.query<{ count: string }>(
    "select count(*)::text as count from audit_events where created_at < $1",
    [cutoff],
  );
  console.log(
    JSON.stringify(
      {
        dryRun: !apply,
        cutoff: cutoff.toISOString(),
        days,
        eligible: Number(eligible.rows[0]?.count ?? "0"),
      },
      null,
      2,
    ),
  );
  if (apply) {
    let deleted = 0;
    for (;;) {
      const batch = await pool.query<{ id: string }>(
        `delete from audit_events
          where id in (
            select id from audit_events where created_at < $1 order by created_at limit 1000
          )
          returning id`,
        [cutoff],
      );
      deleted += batch.rowCount ?? 0;
      if ((batch.rowCount ?? 0) === 0) break;
    }
    console.log(JSON.stringify({ applied: true, deleted }, null, 2));
  }
} finally {
  await pool.end();
}
