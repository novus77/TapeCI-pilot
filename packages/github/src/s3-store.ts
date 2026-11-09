/**
 * S3-compatible object store (AWS S3, Cloudflare R2, MinIO).
 *
 * Keys are content addressed (`sha256/<hex>.tar`). Both `put` and `get` verify
 * the content hash, so a misconfigured bucket, corrupted object or wrong key is
 * reported instead of silently served. No public URLs are generated.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { sha256Hex, type Hex } from "@tapeci/shared";
import { GithubError } from "./errors.js";
import type { ObjectStore } from "./ingest.js";

export interface S3ObjectStoreConfig {
  readonly bucket: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Optional key prefix (no leading/trailing slash required). */
  readonly prefix?: string;
  /** R2/MinIO: true. AWS S3: false (default when no endpoint is set). */
  readonly forcePathStyle?: boolean;
  readonly maxAttempts?: number;
}

function keyHex(key: string): string {
  const match = /^sha256\/([0-9a-f]{64})\.tar$/.exec(key);
  if (match === null || match[1] === undefined) {
    throw new GithubError("OBJECT_STORE_KEY_INVALID", "object key must look like sha256/<64 hex>.tar");
  }
  return match[1];
}

function requireNonEmpty(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GithubError("OBJECT_STORE_KEY_INVALID", `${name} is required for S3 storage`);
  }
  return value.trim();
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    record.name === "NoSuchKey" ||
    record.name === "NotFound" ||
    record.$metadata?.httpStatusCode === 404
  );
}

function storeError(message: string, cause: unknown): GithubError {
  return new GithubError("OBJECT_STORE_ERROR", message, {
    retryable: true,
    cause,
  });
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(config: S3ObjectStoreConfig) {
    this.bucket = requireNonEmpty(config.bucket, "bucket");
    const prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");
    this.prefix = prefix;
    this.client = new S3Client({
      region: config.region ?? "auto",
      ...(config.endpoint === undefined || config.endpoint.trim() === ""
        ? {}
        : { endpoint: config.endpoint.trim() }),
      forcePathStyle: config.forcePathStyle ?? config.endpoint !== undefined,
      credentials: {
        accessKeyId: requireNonEmpty(config.accessKeyId, "accessKeyId"),
        secretAccessKey: requireNonEmpty(config.secretAccessKey, "secretAccessKey"),
      },
      maxAttempts: config.maxAttempts ?? 3,
    });
  }

  private fullKey(key: string): string {
    keyHex(key);
    return this.prefix.length === 0 ? key : `${this.prefix}/${key}`;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const expected = keyHex(key);
    const actual = sha256Hex(bytes);
    const actualHex = actual.toLowerCase().replace(/^0x/, "");
    if (actualHex !== expected) {
      throw new GithubError(
        "OBJECT_STORE_CONTENT_MISMATCH",
        "object bytes do not match the content-addressed key",
        { details: { key } },
      );
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.fullKey(key),
          Body: bytes,
          ContentType: "application/x-tar",
          Metadata: { sha256: actual },
        }),
      );
    } catch (cause) {
      throw new GithubError("OBJECT_STORE_ERROR", "S3 PutObject failed", {
        retryable: true,
        cause,
      });
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const expected = keyHex(key);
    let response;
    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
    } catch (cause) {
      if (isNotFound(cause)) {
        throw new GithubError("OBJECT_STORE_NOT_FOUND", `object ${key} was not found`, {
          details: { key },
        });
      }
      throw storeError(`S3 GetObject failed for ${key}`, cause);
    }
    const bytes = await response.Body?.transformToByteArray();
    if (bytes === undefined) {
      throw new GithubError("OBJECT_STORE_NOT_FOUND", `object ${key} had an empty body`, {
        details: { key },
      });
    }
    const actual = sha256Hex(bytes);
    const actualHex = actual.toLowerCase().replace(/^0x/, "");
    if (actualHex !== expected) {
      throw new GithubError(
        "OBJECT_STORE_CONTENT_MISMATCH",
        `object ${key} content hash does not match its key`,
        { details: { key, actual: actual as Hex } },
      );
    }
    return new Uint8Array(bytes);
  }

  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return true;
    } catch (cause) {
      if (isNotFound(cause)) return false;
      throw storeError(`S3 HeadObject failed for ${key}`, cause);
    }
  }

  /** Release the SDK HTTP pool (tests / short-lived processes). */
  destroy(): void {
    this.client.destroy();
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
    } catch (cause) {
      if (isNotFound(cause)) return;
      throw storeError(`S3 DeleteObject failed for ${key}`, cause);
    }
  }
}
