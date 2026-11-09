/** Object-store selection: local filesystem (dev) or S3-compatible (prod). */
import { LocalObjectStore, S3ObjectStore, type ObjectStore } from "@tapeci/github";
import type { ApiEnv } from "./env.js";
import { ApiError } from "./errors.js";

export function createObjectStore(env: ApiEnv): ObjectStore {
  if ((env.objectStoreKind ?? "local") === "local") {
    return new LocalObjectStore(env.objectStoreDir);
  }
  const bucket = env.s3Bucket;
  const accessKeyId = env.s3AccessKeyId;
  const secretAccessKey = env.s3SecretAccessKey;
  if (bucket === null || bucket === undefined || accessKeyId === null || accessKeyId === undefined ||
      secretAccessKey === null || secretAccessKey === undefined) {
    throw new ApiError(
      503,
      "OBJECT_STORE_NOT_CONFIGURED",
      "S3 object storage requires bucket and credentials",
    );
  }
  return new S3ObjectStore({
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(env.s3Region === null || env.s3Region === undefined ? {} : { region: env.s3Region }),
    ...(env.s3Endpoint === null || env.s3Endpoint === undefined ? {} : { endpoint: env.s3Endpoint }),
    ...(env.s3Prefix === null || env.s3Prefix === undefined ? {} : { prefix: env.s3Prefix }),
    ...(env.s3ForcePathStyle === undefined ? {} : { forcePathStyle: env.s3ForcePathStyle }),
  });
}
