/**
 * Start the API or worker against X Layer mainnet with local credentials.
 *
 *   tsx scripts/p2/run-mainnet.ts api
 *   tsx scripts/p2/run-mainnet.ts worker
 *
 * Loads .tapeci/github-app.env and .tapeci/operator.env as real env vars.
 * Never prints secret values. Requires Postgres/Redis (pnpm db:up).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

async function loadEnvFile(path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value) as string;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const root = process.cwd();
await loadEnvFile(join(root, ".tapeci/github-app.env"));
await loadEnvFile(join(root, ".tapeci/operator.env"));
process.env.DATABASE_URL ??= "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci";
process.env.REDIS_URL ??= "redis://127.0.0.1:56379";
process.env.SESSION_SIGNING_SECRET ??= "local-mainnet-session-secret-change-me";
process.env.TAPECI_DEV_AUTH ??= "0";
// Hard stop for gas-price spikes; the runtime checks this before every write.
process.env.TAPECI_MAX_GAS_PRICE_WEI ??= "30000000"; // 0.03 gwei: ~1.5x observed 0.02 gwei
process.env.TAPECI_PUBLIC_API_URL ??= "http://127.0.0.1:8787";
process.env.TAPECI_WEB_URL ??= "http://127.0.0.1:3000";

const key = process.env.TAPECI_OPERATOR_PRIVATE_KEY;
if (key !== undefined && /^0x[0-9a-fA-F]{64}$/.test(key)) {
  const signer = privateKeyToAccount(key as `0x${string}`).address;
  const expected = process.env.TAPECI_EXPECTED_OPERATOR;
  if (expected !== undefined && expected.toLowerCase() !== signer.toLowerCase()) {
    throw new Error(`operator key does not match TAPECI_EXPECTED_OPERATOR (${signer})`);
  }
  console.log(JSON.stringify({ signer, expectedOperator: expected ?? null, maxGasPriceWei: process.env.TAPECI_MAX_GAS_PRICE_WEI }));
} else if (process.argv[2] === "worker") {
  throw new Error("TAPECI_OPERATOR_PRIVATE_KEY is missing or malformed in .tapeci/operator.env");
}

const mode = process.argv[2];
if (mode === "api") {
  await import("../../apps/api/src/server.js");
} else if (mode === "worker") {
  await import("../../apps/api/src/worker.js");
} else {
  throw new Error("usage: tsx scripts/p2/run-mainnet.ts api|worker");
}
