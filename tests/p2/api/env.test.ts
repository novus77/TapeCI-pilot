import { describe, expect, it } from "vitest";
import { loadEnv } from "../../../apps/api/src/env.js";

const base = {
  DATABASE_URL: "postgres://tapeci:tapeci@127.0.0.1:55432/tapeci",
  SESSION_SIGNING_SECRET: "test-session-secret-123456",
};

describe("API env", () => {
  it("parses the P2-10 gas-price guard and defaults OAuth fields", () => {
    const env = loadEnv({ ...base, TAPECI_MAX_GAS_PRICE_WEI: "30000000" });
    expect(env.maxGasPriceWei).toBe(30_000_000n);
    expect(env.githubAppSlug).toBeNull();
    expect(env.githubOAuthClientId).toBeNull();
    expect(env.publicApiUrl).toBe("http://127.0.0.1:8787");
    expect(env.sessionTtlSeconds).toBe(604_800);
    expect(env.objectStoreKind).toBe("local");
    expect(env.trustProxy).toBe(false);
  });

  it("parses S3 object-store settings", () => {
    const env = loadEnv({
      ...base,
      TAPECI_OBJECT_STORE: "s3",
      S3_BUCKET: "tapeci-artifacts",
      S3_REGION: "auto",
      S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      S3_ACCESS_KEY_ID: "key",
      S3_SECRET_ACCESS_KEY: "secret",
      S3_PREFIX: "prod",
      S3_FORCE_PATH_STYLE: "true",
    });
    expect(env.objectStoreKind).toBe("s3");
    expect(env.s3Bucket).toBe("tapeci-artifacts");
    expect(env.s3Endpoint).toBe("https://account.r2.cloudflarestorage.com");
    expect(env.s3Prefix).toBe("prod");
    expect(env.s3ForcePathStyle).toBe(true);
    const proxied = loadEnv({ ...base, TAPECI_TRUST_PROXY: "2" });
    expect(proxied.trustProxy).toBe("2");
  });

  it("rejects a non-integer gas-price guard", () => {
    expect(() => loadEnv({ ...base, TAPECI_MAX_GAS_PRICE_WEI: "0.03gwei" })).toThrow(
      /TAPECI_MAX_GAS_PRICE_WEI/,
    );
  });

  it("refuses dev auth in production", () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: "production", TAPECI_DEV_AUTH: "1" }),
    ).toThrow(/TAPECI_DEV_AUTH/);
    expect(() =>
      loadEnv({ ...base, NODE_ENV: "production", TAPECI_DEV_AUTH: "0" }),
    ).not.toThrow();
  });

  it("requires a session secret", () => {
    expect(() => loadEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(/SESSION_SIGNING_SECRET/);
  });
});
