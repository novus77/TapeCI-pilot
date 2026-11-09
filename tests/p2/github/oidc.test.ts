import { beforeAll, describe, expect, it } from "vitest";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose";
import {
  DEFAULT_BUILD_TOKEN_TTL_SECONDS,
  GithubError,
  issueBuildToken,
  verifyBuildToken,
  verifyGitHubOidc,
} from "@tapeci/github";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "tapeci-artifact-upload";
const REPOSITORY_ID = 987_001;
const REPOSITORY_OWNER_ID = 424_242;
const COMMIT_SHA = "b".repeat(40);
const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const BUILD_TOKEN_SECRET = "test-session-signing-secret-0001";

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let publicJwk: JWK;
let otherPublicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  const otherPair = await generateKeyPair("RS256");
  otherPrivateKey = otherPair.privateKey;
  otherPublicJwk = await exportJWK(otherPair.publicKey);
});

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function oidcClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = nowSeconds();
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    iat: now - 30,
    nbf: now - 30,
    exp: now + 300,
    repository_id: String(REPOSITORY_ID),
    repository_owner_id: String(REPOSITORY_OWNER_ID),
    repository: "octocat/site",
    repository_owner: "octocat",
    ref: "refs/heads/main",
    sha: COMMIT_SHA,
    workflow_ref: "octocat/site/.github/workflows/build.yml@refs/heads/main",
    sub: "repo:octocat/site:ref:refs/heads/main",
    event_name: "push",
    run_id: "1234567890",
    ...overrides,
  };
}

async function signOidc(
  claims: Record<string, unknown>,
  signingKey: CryptoKey = privateKey,
): Promise<string> {
  return new SignJWT(claims as JWTPayload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(signingKey);
}

function localJwks(jwk: JWK) {
  return createLocalJWKSet({
    keys: [{ ...jwk, alg: "RS256", kid: "test-key", use: "sig" }],
  });
}

async function oidcError(
  token: string,
  options: Parameters<typeof verifyGitHubOidc>[1] = {
    audience: AUDIENCE,
    jwks: localJwks(publicJwk),
  },
): Promise<GithubError> {
  try {
    await verifyGitHubOidc(token, options);
  } catch (error) {
    expect(error).toBeInstanceOf(GithubError);
    return error as GithubError;
  }
  throw new Error("expected verifyGitHubOidc to reject");
}

describe("verifyGitHubOidc", () => {
  it("verifies a valid GitHub Actions OIDC token and returns typed claims", async () => {
    const token = await signOidc(oidcClaims());
    const claims = await verifyGitHubOidc(token, {
      audience: AUDIENCE,
      jwks: localJwks(publicJwk),
    });
    expect(claims.issuer).toBe(ISSUER);
    expect(claims.audience).toEqual([AUDIENCE]);
    expect(claims.repository).toBe("octocat/site");
    expect(claims.repositoryId).toBe(REPOSITORY_ID);
    expect(claims.repositoryOwnerId).toBe(REPOSITORY_OWNER_ID);
    expect(claims.ref).toBe("refs/heads/main");
    expect(claims.sha).toBe(COMMIT_SHA);
    expect(claims.workflowRef).toContain(".github/workflows/build.yml");
    expect(claims.eventName).toBe("push");
    expect(claims.runId).toBe("1234567890");
    expect(claims.expiresAt).toBeGreaterThan(nowSeconds());
    expect(claims.claims.repository_id).toBe(String(REPOSITORY_ID));
  });

  it("accepts numeric repository ids", async () => {
    const token = await signOidc(
      oidcClaims({ repository_id: REPOSITORY_ID, repository_owner_id: REPOSITORY_OWNER_ID }),
    );
    const claims = await verifyGitHubOidc(token, {
      audience: AUDIENCE,
      jwks: localJwks(publicJwk),
    });
    expect(claims.repositoryId).toBe(REPOSITORY_ID);
    expect(claims.repositoryOwnerId).toBe(REPOSITORY_OWNER_ID);
  });

  it("rejects a wrong audience", async () => {
    const token = await signOidc(oidcClaims());
    const error = await oidcError(token, { audience: "some-other-audience", jwks: localJwks(publicJwk) });
    expect(error.code).toBe("OIDC_INVALID_CLAIMS");
    expect(error.details.claim).toBe("aud");
  });

  it("rejects a wrong issuer", async () => {
    const token = await signOidc(oidcClaims());
    const error = await oidcError(token, {
      audience: AUDIENCE,
      issuer: "https://issuer.example.test",
      jwks: localJwks(publicJwk),
    });
    expect(error.code).toBe("OIDC_INVALID_CLAIMS");
    expect(error.details.claim).toBe("iss");
  });

  it("rejects an expired token", async () => {
    const now = nowSeconds();
    const token = await signOidc(
      oidcClaims({ iat: now - 3_600, nbf: now - 3_600, exp: now - 60 }),
    );
    const error = await oidcError(token);
    expect(error.code).toBe("OIDC_EXPIRED");
  });

  it("rejects a not-yet-valid token (nbf in the future)", async () => {
    const now = nowSeconds();
    const token = await signOidc(oidcClaims({ nbf: now + 600, exp: now + 900 }));
    const error = await oidcError(token);
    expect(error.code).toBe("OIDC_INVALID_CLAIMS");
    expect(error.details.claim).toBe("nbf");
  });

  it("rejects a token signed by an untrusted key", async () => {
    const token = await signOidc(oidcClaims(), otherPrivateKey);
    const error = await oidcError(token);
    expect(error.code).toBe("OIDC_INVALID_SIGNATURE");
  });

  it("rejects a malformed token", async () => {
    const error = await oidcError("not.a.jwt");
    expect(error.code).toBe("OIDC_INVALID");
  });

  it("requires exp/iat/nbf and the deployment-scoping claims", async () => {
    const required: readonly string[] = [
      "exp",
      "iat",
      "nbf",
      "repository_id",
      "repository_owner_id",
      "ref",
      "sha",
      "workflow_ref",
    ];
    for (const claim of required) {
      const claims = oidcClaims();
      delete claims[claim];
      const token = await signOidc(claims);
      const error = await oidcError(token);
      expect(error.code, `missing ${claim}`).toBe("OIDC_INVALID_CLAIMS");
    }
  });

  it("rejects unparsable repository ids", async () => {
    for (const repositoryId of ["abc", 0, -1, "", 1.5]) {
      const token = await signOidc(oidcClaims({ repository_id: repositoryId }));
      const error = await oidcError(token);
      expect(error.code).toBe("OIDC_INVALID_CLAIMS");
    }
  });

  it("rejects non-branch refs and non-commit shas", async () => {
    const badRef = await oidcError(await signOidc(oidcClaims({ ref: "main" })));
    expect(badRef.code).toBe("OIDC_INVALID_CLAIMS");
    const badSha = await oidcError(await signOidc(oidcClaims({ sha: "abc" })));
    expect(badSha.code).toBe("OIDC_INVALID_CLAIMS");
  });

  it("enforces optional expected-claim bindings", async () => {
    const token = await signOidc(oidcClaims());
    const jwks = localJwks(publicJwk);
    await expect(
      verifyGitHubOidc(token, {
        audience: AUDIENCE,
        jwks,
        expected: {
          repositoryId: REPOSITORY_ID,
          repositoryOwnerId: REPOSITORY_OWNER_ID,
          ref: "refs/heads/main",
          sha: COMMIT_SHA,
        },
      }),
    ).resolves.toMatchObject({ repositoryId: REPOSITORY_ID });

    for (const expected of [
      { repositoryId: 1 },
      { repositoryOwnerId: 1 },
      { ref: "refs/heads/other" },
      { sha: "c".repeat(40) },
    ]) {
      const error = await oidcError(token, { audience: AUDIENCE, jwks, expected });
      expect(error.code).toBe("OIDC_MISMATCH");
    }
  });

  it("rejects an unused trusted JWK with a different kid", async () => {
    const token = await signOidc(oidcClaims());
    const error = await oidcError(token, {
      audience: AUDIENCE,
      jwks: createLocalJWKSet({
        keys: [{ ...otherPublicJwk, alg: "RS256", kid: "test-key", use: "sig" }],
      }),
    });
    expect(error.code).toBe("OIDC_INVALID_SIGNATURE");
  });
});

describe("build tokens (HS256)", () => {
  const baseOptions = {
    deploymentId: DEPLOYMENT_ID,
    repositoryId: REPOSITORY_ID,
    commitSha: COMMIT_SHA,
    ref: "refs/heads/main",
    secret: BUILD_TOKEN_SECRET,
  };

  it("issues a verifiable one-time token bound to the deployment", async () => {
    const issued = await issueBuildToken(baseOptions);
    expect(issued.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const verified = await verifyBuildToken({
      token: issued.token,
      secret: BUILD_TOKEN_SECRET,
    });
    expect(verified).toEqual({
      jti: issued.jti,
      deploymentId: DEPLOYMENT_ID,
      repositoryId: REPOSITORY_ID,
      commitSha: COMMIT_SHA,
      ref: "refs/heads/main",
      expiresAt: issued.expiresAt,
    });
    expect(issued.claims.expiresAt - issued.claims.issuedAt).toBe(
      DEFAULT_BUILD_TOKEN_TTL_SECONDS,
    );
  });

  it("honours a custom TTL", async () => {
    const issued = await issueBuildToken({ ...baseOptions, ttlSeconds: 120 });
    expect(issued.claims.expiresAt - issued.claims.issuedAt).toBe(120);
  });

  it("rejects a token signed with a different secret", async () => {
    const issued = await issueBuildToken(baseOptions);
    await expect(
      verifyBuildToken({ token: issued.token, secret: "a-different-signing-secret" }),
    ).rejects.toMatchObject({ code: "BUILD_TOKEN_INVALID" });
  });

  it("rejects an expired token", async () => {
    const issued = await issueBuildToken({
      ...baseOptions,
      ttlSeconds: 60,
      now: () => new Date(Date.now() - 10 * 60 * 1000),
    });
    await expect(
      verifyBuildToken({ token: issued.token, secret: BUILD_TOKEN_SECRET }),
    ).rejects.toMatchObject({ code: "BUILD_TOKEN_EXPIRED" });
  });

  it("rejects a tampered token payload", async () => {
    const issued = await issueBuildToken(baseOptions);
    const [header, payload, signature] = issued.token.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const tampered = Buffer.from(
      JSON.stringify({ ...decoded, commitSha: "d".repeat(40) }),
      "utf8",
    ).toString("base64url");
    await expect(
      verifyBuildToken({
        token: `${header ?? ""}.${tampered}.${signature ?? ""}`,
        secret: BUILD_TOKEN_SECRET,
      }),
    ).rejects.toMatchObject({ code: "BUILD_TOKEN_INVALID" });
  });

  it("rejects invalid issue inputs", async () => {
    const invalid: Array<Record<string, unknown>> = [
      { commitSha: "nope" },
      { repositoryId: 0 },
      { ref: "main" },
      { ttlSeconds: 0 },
      { ttlSeconds: 86_401 },
      { deploymentId: "not-a-uuid" },
      { secret: "" },
    ];
    for (const overrides of invalid) {
      await expect(
        issueBuildToken({ ...baseOptions, ...overrides }),
      ).rejects.toMatchObject({ code: "BUILD_TOKEN_INVALID" });
    }
  });

  it("classifies bad build-token claims as BUILD_TOKEN_INVALID", async () => {
    const badClaims: Array<Record<string, unknown>> = [
      { deploymentId: DEPLOYMENT_ID, repositoryId: "abc", commitSha: COMMIT_SHA, ref: "refs/heads/main" },
      { deploymentId: DEPLOYMENT_ID, repositoryId: REPOSITORY_ID, commitSha: "nope", ref: "refs/heads/main" },
      { deploymentId: DEPLOYMENT_ID, repositoryId: REPOSITORY_ID, commitSha: COMMIT_SHA, ref: "main" },
      { deploymentId: "not-a-uuid", repositoryId: REPOSITORY_ID, commitSha: COMMIT_SHA, ref: "refs/heads/main" },
    ];
    for (const claims of badClaims) {
      const token = await new SignJWT(claims as JWTPayload)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer("tapeci")
        .setAudience("tapeci-build")
        .setJti("22222222-2222-4222-8222-222222222222")
        .setIssuedAt(Math.floor(Date.now() / 1000))
        .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
        .sign(new TextEncoder().encode(BUILD_TOKEN_SECRET));
      await expect(
        verifyBuildToken({ token, secret: BUILD_TOKEN_SECRET }),
      ).rejects.toMatchObject({ code: "BUILD_TOKEN_INVALID" });
    }
  });

  it("rejects malformed tokens", async () => {
    for (const token of ["", "abc", "a.b.c"]) {
      await expect(
        verifyBuildToken({ token, secret: BUILD_TOKEN_SECRET }),
      ).rejects.toMatchObject({ code: "BUILD_TOKEN_INVALID" });
    }
  });
});
