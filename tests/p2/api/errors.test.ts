import { describe, expect, it } from "vitest";
import { GithubError } from "@tapeci/github";
import { errorEnvelope, httpStatusFor } from "../../../apps/api/src/errors.js";

describe("API error mapping", () => {
  it("maps artifact/OIDC GitHub errors to client statuses, not 500", () => {
    expect(httpStatusFor(new GithubError("TAR_PATH_UNSAFE", "unsafe path"))).toBe(422);
    expect(httpStatusFor(new GithubError("TAR_FILE_TOO_LARGE", "too large"))).toBe(413);
    expect(httpStatusFor(new GithubError("TAR_ARCHIVE_TOO_LARGE", "too large"))).toBe(413);
    expect(httpStatusFor(new GithubError("OIDC_INVALID", "bad token"))).toBe(401);
    expect(httpStatusFor(new GithubError("BUILD_TOKEN_REPLAYED", "replay"))).toBe(409);
    expect(httpStatusFor(new GithubError("REPOSITORY_NOT_AUTHORIZED", "no"))).toBe(403);
    expect(httpStatusFor(new GithubError("GITHUB_API_ERROR", "github down"))).toBe(502);
  });

  it("keeps the typed code and details in the envelope", () => {
    const envelope = errorEnvelope(
      new GithubError("TAR_PATH_UNSAFE", "unsafe path", { details: { path: "./" } }),
    );
    expect(envelope.error).toMatchObject({
      code: "TAR_PATH_UNSAFE",
      message: "unsafe path",
      retryable: false,
      details: { path: "./" },
    });
  });
});
