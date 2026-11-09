import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import S3rver from "s3rver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3ObjectStore, type S3ObjectStoreConfig } from "@tapeci/github";
import { sha256Hex } from "@tapeci/shared";

/**
 * Integration test for S3ObjectStore over the real S3 HTTP protocol.
 *
 * - With `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` set it
 *   talks to that real S3-compatible endpoint (MinIO/R2/AWS). The bucket must exist.
 * - Otherwise it starts an in-process s3rver on 127.0.0.1 with an ephemeral port.
 *
 * s3rver implements the S3 HTTP/XML surface but does NOT verify SigV4 (it accepts
 * any signature). Signature correctness is covered by the AWS SDK against a real
 * endpoint in the deployed environment, not by this test.
 */
const externalEndpoint = process.env.S3_ENDPOINT;
const useExternal =
  externalEndpoint !== undefined &&
  externalEndpoint.length > 0 &&
  process.env.S3_ACCESS_KEY_ID !== undefined &&
  process.env.S3_SECRET_ACCESS_KEY !== undefined;

describe("S3ObjectStore over S3 HTTP", () => {
  const bucket = process.env.S3_BUCKET ?? "tapeci-artifacts";
  let directory: string | null = null;
  let server: S3rver | null = null;
  let client: S3Client;
  let store: S3ObjectStore;

  beforeAll(async () => {
    let endpoint: string;
    let accessKeyId: string;
    let secretAccessKey: string;
    let region = "us-east-1";
    if (useExternal) {
      endpoint = externalEndpoint;
      accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "";
      secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "";
      region = process.env.S3_REGION ?? region;
    } else {
      directory = await mkdtemp(join(tmpdir(), "tapeci-s3-"));
      // Port 0 avoids colliding with the compose MinIO port (59000).
      server = new S3rver({
        port: 0,
        address: "127.0.0.1",
        directory,
        silent: true,
        configureBuckets: [{ name: bucket }],
      });
      const address = await server.run();
      endpoint = `http://${address.address}:${address.port}`;
      accessKeyId = "S3RVER";
      secretAccessKey = "S3RVER";
    }
    const config: S3ObjectStoreConfig = {
      bucket,
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: true,
      prefix: "tapeci-integration",
    };
    store = new S3ObjectStore(config);
    client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
  }, 60_000);

  afterAll(async () => {
    store?.destroy();
    client?.destroy();
    if (server !== null) await server.close();
    if (directory !== null) await rm(directory, { recursive: true, force: true });
  });

  it("put/get/has/delete round-trips bytes and verifies the hash", async () => {
    const bytes = Buffer.from("TapeCI S3 integration payload", "utf8");
    const sha = sha256Hex(new Uint8Array(bytes)).replace(/^0x/, "");
    const key = `sha256/${sha}.tar`;
    await store.put(key, new Uint8Array(bytes));
    expect(await store.has(key)).toBe(true);
    const readBack = await store.get(key);
    expect(Buffer.from(readBack).toString("utf8")).toBe(bytes.toString("utf8"));
    await store.delete(key);
    expect(await store.has(key)).toBe(false);
    await expect(store.get(key)).rejects.toMatchObject({ code: "OBJECT_STORE_NOT_FOUND" });
  });

  it("rejects bytes that do not match the content-addressed key", async () => {
    const bytes = Buffer.from("mismatched payload", "utf8");
    const wrongKey = `sha256/${"0".repeat(64)}.tar`;
    await expect(store.put(wrongKey, new Uint8Array(bytes))).rejects.toMatchObject({
      code: "OBJECT_STORE_CONTENT_MISMATCH",
    });
  });
});
