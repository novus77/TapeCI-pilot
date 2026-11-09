import { describe, expect, it } from "vitest";
import { LocalObjectStore, S3ObjectStore } from "@tapeci/github";
import { loadEnv } from "../../../apps/api/src/env.js";
import { createObjectStore } from "../../../apps/api/src/object-store.js";

const base = {
  DATABASE_URL: "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci",
  SESSION_SIGNING_SECRET: "test-session-secret-123456",
};

describe("object store selection", () => {
  it("defaults to the local filesystem store", () => {
    const store = createObjectStore(loadEnv(base));
    expect(store).toBeInstanceOf(LocalObjectStore);
  });

  it("builds an S3 store from environment settings", () => {
    const env = loadEnv({
      ...base,
      TAPECI_OBJECT_STORE: "s3",
      S3_BUCKET: "tapeci-artifacts",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      S3_PREFIX: "prod",
    });
    const store = createObjectStore(env);
    expect(store).toBeInstanceOf(S3ObjectStore);
    (store as S3ObjectStore).destroy();
  });

  it("fails closed when S3 credentials are incomplete", () => {
    const env = loadEnv({ ...base, TAPECI_OBJECT_STORE: "s3", S3_BUCKET: "tapeci-artifacts" });
    expect(() => createObjectStore(env)).toThrow(/S3 object storage requires/);
  });
});
