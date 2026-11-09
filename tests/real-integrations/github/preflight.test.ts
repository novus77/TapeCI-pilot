import { describe, expect, it } from "vitest";
import {
  credentialFileSummary,
  formatPreflightReport,
  parseGithubAppEnv,
} from "../../../scripts/real-integrations/github/preflight.js";

describe("GitHub App preflight parsing", () => {
  it("parses quoted PEM and dotenv values without echoing them", () => {
    const env = parseGithubAppEnv(
      [
        "# local credentials",
        "GITHUB_APP_ID=12345",
        'GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nsecret\\n-----END PRIVATE KEY-----\\n"',
        'GITHUB_WEBHOOK_SECRET="webhook-secret"',
      ].join("\n"),
    );

    expect(env.GITHUB_APP_ID).toBe("12345");
    expect(env.GITHUB_APP_PRIVATE_KEY).toContain("\nsecret\n");
    expect(env.GITHUB_WEBHOOK_SECRET).toBe("webhook-secret");

    const summary = credentialFileSummary(env);
    expect(summary).toEqual({
      present: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"],
      missing: ["GITHUB_APP_SLUG", "GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("12345");
    expect(serialized).not.toContain("secret");
  });

  it("rejects duplicate keys and malformed quoted values", () => {
    expect(() => parseGithubAppEnv("GITHUB_APP_ID=1\nGITHUB_APP_ID=2\n")).toThrow(/duplicate/i);
    expect(() => parseGithubAppEnv('GITHUB_APP_ID="unterminated\n')).toThrow(/quoted/i);
  });

  it("formats a read-only report without credential values", () => {
    const report = formatPreflightReport({
      file: ".tapeci/github-app.env",
      present: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"],
      missing: ["GITHUB_APP_SLUG"],
      apiBaseUrl: "https://api.github.com",
      networkCheck: "skipped",
    });

    expect(report).toContain("credentials=3/4");
    expect(report).toContain("network=skipped");
    expect(report).not.toContain("webhook-secret-value");
  });
});
