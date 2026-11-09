/** Set the project approval-policy cost ceiling (no chain write). */
import { createDatabase, approvalPolicies } from "@tapeci/database";
const projectId = process.argv[2];
const capWei = process.argv[3];
if (projectId === undefined || capWei === undefined) throw new Error("usage: projectId capWei");
const { db, pool } = createDatabase(process.env.DATABASE_URL ?? "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci");
try {
  const [row] = await db.insert(approvalPolicies).values({
    projectId,
    requiredRole: "owner",
    maxCostCapWei: capWei,
    expiresInSeconds: 900,
  }).onConflictDoUpdate({
    target: approvalPolicies.projectId,
    set: { maxCostCapWei: capWei },
  }).returning();
  console.log(JSON.stringify({ projectId: row?.projectId, maxCostCapWei: row?.maxCostCapWei, requiredRole: row?.requiredRole }));
} finally { await pool.end(); }
