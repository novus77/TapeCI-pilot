/** One-shot installation reconciliation. Requires GitHub App credentials. */
import { createDatabase } from "@tapeci/database";
import { loadEnv } from "../../apps/api/src/env.js";
import { reconcileInstallationsIfConfigured } from "../../apps/api/src/github-reconcile.js";

const env = loadEnv();
const { db, pool } = createDatabase(env.databaseUrl);
try {
  const result = await reconcileInstallationsIfConfigured({ db, env });
  console.log(JSON.stringify({ event: "reconcile", result }, null, 2));
  if (result === null) process.exitCode = 2;
} finally {
  await pool.end();
}
