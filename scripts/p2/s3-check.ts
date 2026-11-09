/**
 * Real S3-compatible bucket round-trip using S3ObjectStore.
 *   S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *     pnpm s3:check
 *
 * Prints status only; never prints credentials or object bytes.
 */
import { S3ObjectStore } from "@tapeci/github";
import { sha256Hex } from "@tapeci/shared";

const endpoint = process.env.S3_ENDPOINT;
const bucket = process.env.S3_BUCKET;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.error("S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required");
  process.exit(2);
}
const store = new S3ObjectStore({
  bucket,
  endpoint,
  region: process.env.S3_REGION ?? "auto",
  accessKeyId,
  secretAccessKey,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  prefix: process.env.S3_PREFIX ?? "tapeci",
});
const bytes = new TextEncoder().encode(`tapeci s3 check ${new Date().toISOString()}`);
const sha = sha256Hex(bytes).replace(/^0x/, "");
const key = `sha256/${sha}.tar`;
try {
  await store.put(key, bytes);
  const has = await store.has(key);
  const readBack = await store.get(key);
  const match = Buffer.from(readBack).equals(Buffer.from(bytes));
  await store.delete(key);
  console.log(JSON.stringify({ ok: has && match, key, bytes: bytes.length }, null, 2));
  if (!has || !match) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  store.destroy();
}
