import { describe, expect, it } from "vitest";
import type { Database } from "@tapeci/database";
import {
  GithubError,
  computeWebhookSignature,
  handlePushWebhook,
  parsePushPayload,
  verifyWebhookSignature,
} from "@tapeci/github";
import {
  TEST_COMMIT_SHA,
  TEST_DEFAULT_BRANCH,
  TEST_INSTALLATION_ID,
  TEST_REPO_FULL_NAME,
  TEST_REPOSITORY_ID,
  TEST_WEBHOOK_SECRET,
  makePushPayload,
  signPushRequest,
} from "./helpers.js";

const RAW_BODY = JSON.stringify({ hello: "世界" });

function expectGithubError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).code).toBe(code);
    return;
  }
  throw new Error(`expected GithubError ${code}`);
}

describe("verifyWebhookSignature", () => {
  it("accepts the exact body with the correct secret", () => {
    const signature = computeWebhookSignature(TEST_WEBHOOK_SECRET, RAW_BODY);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(
      verifyWebhookSignature({
        secret: TEST_WEBHOOK_SECRET,
        rawBody: RAW_BODY,
        signatureHeader: signature,
      }),
    ).toBe(true);
  });

  it("accepts raw bytes identical to the signed string", () => {
    const bytes = new TextEncoder().encode(RAW_BODY);
    const signature = computeWebhookSignature(TEST_WEBHOOK_SECRET, bytes);
    expect(
      verifyWebhookSignature({
        secret: TEST_WEBHOOK_SECRET,
        rawBody: bytes,
        signatureHeader: signature,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = computeWebhookSignature(TEST_WEBHOOK_SECRET, RAW_BODY);
    expect(
      verifyWebhookSignature({
        secret: TEST_WEBHOOK_SECRET,
        rawBody: `${RAW_BODY} `,
        signatureHeader: signature,
      }),
    ).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const signature = computeWebhookSignature("another-secret", RAW_BODY);
    expect(
      verifyWebhookSignature({
        secret: TEST_WEBHOOK_SECRET,
        rawBody: RAW_BODY,
        signatureHeader: signature,
      }),
    ).toBe(false);
  });

  it("rejects missing, malformed and non-sha256 headers", () => {
    for (const signatureHeader of [
      undefined,
      "",
      "sha256=",
      "sha256=zzzz",
      `sha1=${"a".repeat(40)}`,
      `sha256=${"A".repeat(64)}`,
      `sha256=${"a".repeat(63)}`,
      `sha256=${"a".repeat(64)} `,
    ]) {
      expect(
        verifyWebhookSignature({
          secret: TEST_WEBHOOK_SECRET,
          rawBody: RAW_BODY,
          signatureHeader,
        }),
      ).toBe(false);
    }
  });
});

describe("parsePushPayload", () => {
  it("extracts the fields TapeCI needs from a push payload", () => {
    const parsed = parsePushPayload(makePushPayload());
    expect(parsed).toMatchObject({
      installationId: TEST_INSTALLATION_ID,
      repositoryId: TEST_REPOSITORY_ID,
      repositoryFullName: TEST_REPO_FULL_NAME,
      ownerLogin: "octocat",
      ref: `refs/heads/${TEST_DEFAULT_BRANCH}`,
      branch: TEST_DEFAULT_BRANCH,
      commitSha: TEST_COMMIT_SHA,
      deleted: false,
    });
  });

  it("marks branch deletions (deleted=true or zero sha) as deleted", () => {
    expect(parsePushPayload(makePushPayload({ deleted: true })).deleted).toBe(true);
    expect(parsePushPayload(makePushPayload({ after: "0".repeat(40) })).deleted).toBe(true);
  });

  it("rejects tag refs as unsupported", () => {
    expectGithubError(
      () => parsePushPayload(makePushPayload({ ref: "refs/tags/v1.0.0" })),
      "UNSUPPORTED_REF",
    );
  });

  it("rejects a ref without a branch name", () => {
    expectGithubError(
      () => parsePushPayload(makePushPayload({ ref: "refs/heads/" })),
      "UNSUPPORTED_REF",
    );
  });

  it("rejects missing/invalid fields", () => {
    const invalidPayloads: unknown[] = [
      null,
      [],
      "not-an-object",
      {},
      { ...makePushPayload(), installation: undefined },
      { ...makePushPayload(), repository: undefined },
      {
        ...makePushPayload(),
        repository: { ...(makePushPayload().repository as object), id: 0 },
      },
      {
        ...makePushPayload(),
        repository: { ...(makePushPayload().repository as object), full_name: "no-slash" },
      },
      {
        ...makePushPayload(),
        repository: {
          ...(makePushPayload().repository as object),
          owner: { login: "" },
        },
      },
      { ...makePushPayload(), ref: 42 },
      { ...makePushPayload(), after: "not-a-sha" },
    ];
    for (const payload of invalidPayloads) {
      expectGithubError(() => parsePushPayload(payload), "INVALID_PAYLOAD");
    }
  });
});

// A stub is safe here: signature verification runs before any database access.
const unreachableDb = {} as unknown as Database;

describe("handlePushWebhook signature gating", () => {
  async function callWithSignature(signature: string | undefined) {
    const payload = makePushPayload();
    const rawBody = JSON.stringify(payload);
    return handlePushWebhook({
      db: unreachableDb,
      deliveryId: "delivery-signature-test",
      event: "push",
      headers: signature === undefined ? {} : { "x-hub-signature-256": signature },
      rawBody,
      secret: TEST_WEBHOOK_SECRET,
    });
  }

  it("rejects a tampered body before touching the database", async () => {
    const request = signPushRequest(makePushPayload(), { deliveryId: "delivery-tampered" });
    const tamperedBody = request.rawBody.replace(TEST_COMMIT_SHA, "b".repeat(40));
    const result = await handlePushWebhook({
      db: unreachableDb,
      deliveryId: "delivery-tampered",
      event: "push",
      headers: request.headers,
      rawBody: tamperedBody,
      secret: TEST_WEBHOOK_SECRET,
    });
    expect(result).toEqual({
      duplicate: false,
      accepted: false,
      errorCode: "SIGNATURE_INVALID",
    });
  });

  it("rejects a missing signature header", async () => {
    await expect(callWithSignature(undefined)).resolves.toMatchObject({
      accepted: false,
      errorCode: "SIGNATURE_INVALID",
    });
  });

  it("requires a webhook secret", async () => {
    await expect(
      handlePushWebhook({
        db: unreachableDb,
        deliveryId: "delivery-no-secret",
        event: "push",
        headers: {},
        rawBody: "{}",
        secret: "",
      }),
    ).rejects.toMatchObject({ code: "WEBHOOK_CONFIG_INVALID" });
  });
});
