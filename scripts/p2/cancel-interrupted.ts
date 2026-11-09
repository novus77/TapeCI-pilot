/**
 * Cancel resumable UPLOAD_INTERRUPTED deployments so a container has exactly one
 * writer. History (mined txs/journal) is preserved; no chain write.
 *
 *   tsx scripts/p2/cancel-interrupted.ts <deploymentId...>
 */
import { createDatabase } from "@tapeci/database";
import { transitionDeployment } from "@tapeci/queue";
import { eq } from "drizzle-orm";
import { deployments } from "@tapeci/database";

const ids = process.argv.slice(2);
if (ids.length === 0) throw new Error("usage: cancel-interrupted.ts <deploymentId...>");
const { db, pool } = createDatabase(process.env.DATABASE_URL ?? "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci");
try {
  for (const id of ids) {
    const [row] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
    if (row === undefined) throw new Error(`${id}: not found`);
    if (row.state !== "UPLOAD_INTERRUPTED") {
      console.log(JSON.stringify({ id, skipped: true, state: row.state }));
      continue;
    }
    const next = await transitionDeployment(db, {
      deploymentId: id,
      toState: "CANCELED",
      expectedVersion: row.stateVersion,
      eventType: "upload_abandoned",
      actorKind: "system",
      actorId: null,
      payload: { reason: "pre-RC cleanup: interrupted run superseded by a clean release" },
    });
    console.log(JSON.stringify({ id, state: next.state }));
  }
} finally {
  await pool.end();
}
