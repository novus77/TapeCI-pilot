import { createDatabase } from "@tapeci/database";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const { db, pool } = createDatabase(env.databaseUrl);
const app = buildApp({ db, env });

await app.listen({ port: env.port, host: env.host });
console.log(`tapeci api listening on http://${env.host}:${env.port}`);

const shutdown = async (): Promise<void> => {
  await app.close();
  await pool.end();
};
process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
