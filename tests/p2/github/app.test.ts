import { beforeAll, describe, expect, it } from "vitest";
import { exportPKCS8, generateKeyPair, jwtVerify, type CryptoKey } from "jose";
import {
  GITHUB_API_BASE_URL,
  GithubError,
  getInstallationToken,
  signAppJwt,
} from "@tapeci/github";

const APP_ID = 123_456;
const INSTALLATION_ID = 555_001;
// Captured at module load so the signed JWT is still inside its `exp` window
// when jose verifies it with the real clock a few milliseconds later.
const FIXED_NOW = new Date();
const NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let privateKeyPem: string;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
  privateKeyPem = await exportPKCS8(privateKey);
});

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capturingFetch(
  responder: (request: CapturedRequest) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const captured: CapturedRequest = { url: String(input), init };
    calls.push(captured);
    return responder(captured);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("signAppJwt", () => {
  it("signs an RS256 App JWT with iss/iat/exp as GitHub expects", async () => {
    const token = await signAppJwt({
      appId: APP_ID,
      privateKey,
      now: () => FIXED_NOW,
    });
    const { protectedHeader, payload } = await jwtVerify(token, publicKey, {
      issuer: String(APP_ID),
    });
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iss).toBe(String(APP_ID));
    expect(payload.iat).toBe(NOW_SECONDS - 60);
    expect(payload.exp).toBe(NOW_SECONDS + 9 * 60);
    // TOTAL lifetime is exactly 10 minutes including the backdated iat.
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(600);
  });

  it("accepts a PKCS#8 PEM string (literal newlines)", async () => {
    const token = await signAppJwt({ appId: APP_ID, privateKey: privateKeyPem });
    const { payload } = await jwtVerify(token, publicKey);
    expect(payload.iss).toBe(String(APP_ID));
  });

  it("accepts a \\n-escaped environment PEM string", async () => {
    const escaped = privateKeyPem.replace(/\n/g, "\\n");
    const token = await signAppJwt({ appId: APP_ID, privateKey: escaped });
    const { payload } = await jwtVerify(token, publicKey);
    expect(payload.iss).toBe(String(APP_ID));
  });

  it("rejects a non-numeric app id", async () => {
    await expect(
      signAppJwt({ appId: "not-an-app-id", privateKey }),
    ).rejects.toMatchObject({ code: "GITHUB_APP_CONFIG_INVALID" });
  });

  it("rejects a private key that is not a PKCS#8 PEM", async () => {
    await expect(
      signAppJwt({ appId: APP_ID, privateKey: "definitely-not-a-pem" }),
    ).rejects.toMatchObject({ code: "GITHUB_APP_KEY_INVALID" });
  });
});

describe("getInstallationToken", () => {
  it("exchanges the App JWT for an installation token via the injected fetch", async () => {
    const expiresAt = new Date(FIXED_NOW.getTime() + 60 * 60 * 1000);
    const fake = capturingFetch(() =>
      jsonResponse(201, { token: "ghs_test_installation_token", expires_at: expiresAt.toISOString() }),
    );
    const result = await getInstallationToken({
      appId: APP_ID,
      privateKey,
      installationId: INSTALLATION_ID,
      fetch: fake.fetch,
      now: () => FIXED_NOW,
    });

    expect(result.token).toBe("ghs_test_installation_token");
    expect(result.expiresAt.toISOString()).toBe(expiresAt.toISOString());
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.url).toBe(
      `${GITHUB_API_BASE_URL}/app/installations/${INSTALLATION_ID}/access_tokens`,
    );
    expect(call?.init?.method).toBe("POST");
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    const authorization = headers.get("authorization") ?? "";
    expect(authorization.startsWith("Bearer ")).toBe(true);
    // The bearer token really is a valid App JWT.
    const { payload } = await jwtVerify(authorization.slice("Bearer ".length), publicKey, {
      issuer: String(APP_ID),
    });
    expect(payload.iss).toBe(String(APP_ID));
  });

  it("honours an apiBaseUrl override and trims trailing slashes", async () => {
    const expiresAt = new Date(FIXED_NOW.getTime() + 60 * 60 * 1000);
    const fake = capturingFetch(() =>
      jsonResponse(201, { token: "ghs_test_installation_token", expires_at: expiresAt.toISOString() }),
    );
    await getInstallationToken({
      appId: APP_ID,
      privateKey,
      installationId: INSTALLATION_ID,
      apiBaseUrl: "https://github.example.test/api/v3/",
      fetch: fake.fetch,
      now: () => FIXED_NOW,
    });
    expect(fake.calls[0]?.url).toBe(
      `https://github.example.test/api/v3/app/installations/${INSTALLATION_ID}/access_tokens`,
    );
  });

  it("maps HTTP 401 to GITHUB_API_UNAUTHORIZED without leaking the token", async () => {
    const fake = capturingFetch(() => jsonResponse(401, { message: "Bad credentials" }));
    const error = await getInstallationToken({
      appId: APP_ID,
      privateKey,
      installationId: INSTALLATION_ID,
      fetch: fake.fetch,
      now: () => FIXED_NOW,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).code).toBe("GITHUB_API_UNAUTHORIZED");
    const serialized = `${(error as Error).message} ${JSON.stringify((error as GithubError).details)}`;
    expect(serialized).not.toContain("PRIVATE KEY");
    expect(serialized).not.toContain("ghs_");
  });

  it("maps HTTP 404 to GITHUB_INSTALLATION_NOT_FOUND", async () => {
    const fake = capturingFetch(() => jsonResponse(404, { message: "Not Found" }));
    await expect(
      getInstallationToken({
        appId: APP_ID,
        privateKey,
        installationId: INSTALLATION_ID,
        fetch: fake.fetch,
        now: () => FIXED_NOW,
      }),
    ).rejects.toMatchObject({ code: "GITHUB_INSTALLATION_NOT_FOUND" });
  });

  it("marks 5xx failures retryable", async () => {
    const fake = capturingFetch(() => jsonResponse(503, { message: "unavailable" }));
    await expect(
      getInstallationToken({
        appId: APP_ID,
        privateKey,
        installationId: INSTALLATION_ID,
        fetch: fake.fetch,
        now: () => FIXED_NOW,
      }),
    ).rejects.toMatchObject({ code: "GITHUB_API_ERROR", retryable: true });
  });

  it("rejects a non-JSON success body", async () => {
    const fake = capturingFetch(() => new Response("<html>nope</html>", { status: 201 }));
    await expect(
      getInstallationToken({
        appId: APP_ID,
        privateKey,
        installationId: INSTALLATION_ID,
        fetch: fake.fetch,
        now: () => FIXED_NOW,
      }),
    ).rejects.toMatchObject({ code: "GITHUB_API_INVALID_RESPONSE" });
  });

  it("rejects a success body without a token", async () => {
    const fake = capturingFetch(() =>
      jsonResponse(201, { expires_at: new Date(FIXED_NOW.getTime() + 60_000).toISOString() }),
    );
    await expect(
      getInstallationToken({
        appId: APP_ID,
        privateKey,
        installationId: INSTALLATION_ID,
        fetch: fake.fetch,
        now: () => FIXED_NOW,
      }),
    ).rejects.toMatchObject({ code: "GITHUB_API_INVALID_RESPONSE" });
  });

  it("rejects an already-expired installation token", async () => {
    const fake = capturingFetch(() =>
      jsonResponse(201, {
        token: "ghs_test_installation_token",
        expires_at: new Date(FIXED_NOW.getTime() - 1_000).toISOString(),
      }),
    );
    await expect(
      getInstallationToken({
        appId: APP_ID,
        privateKey,
        installationId: INSTALLATION_ID,
        fetch: fake.fetch,
        now: () => FIXED_NOW,
      }),
    ).rejects.toMatchObject({ code: "GITHUB_API_INVALID_RESPONSE" });
  });

  it("wraps transport failures as retryable GITHUB_API_ERROR", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    await expect(
      getInstallationToken({
        appId: APP_ID,
        privateKey,
        installationId: INSTALLATION_ID,
        fetch: fetchImpl,
        now: () => FIXED_NOW,
      }),
    ).rejects.toMatchObject({ code: "GITHUB_API_ERROR", retryable: true });
  });

  it("rejects an invalid installation id before calling GitHub", async () => {
    const fake = capturingFetch(() => jsonResponse(201, {}));
    await expect(
      getInstallationToken({
        appId: APP_ID,
        privateKey,
        installationId: "0",
        fetch: fake.fetch,
      }),
    ).rejects.toMatchObject({ code: "GITHUB_APP_CONFIG_INVALID" });
    expect(fake.calls).toHaveLength(0);
  });
});
