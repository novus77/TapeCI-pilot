/**
 * Ensure the configured S3 bucket exists (idempotent, deploy-time init).
 *   S3_ENDPOINT=... S3_BUCKET=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *     pnpm s3:ensure-bucket
 */
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";

const endpoint = process.env.S3_ENDPOINT;
const bucket = process.env.S3_BUCKET;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.error("S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required");
  process.exit(2);
}
const client = new S3Client({
  region: process.env.S3_REGION ?? "auto",
  endpoint,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  credentials: { accessKeyId, secretAccessKey },
});
try {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(JSON.stringify({ bucket, created: false }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(JSON.stringify({ bucket, created: true }));
  }
} catch (error) {
  console.error(JSON.stringify({ bucket, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  client.destroy();
}
