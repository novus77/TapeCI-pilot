import { describe, expect, it } from "vitest";
import {
  assertWebhookTargetAllowed,
  githubCredentialPresence,
  realIntegrationEnabled,
} from "../../scripts/real-integrations/common.js";

describe("real integration safety gates", () => {
  it("requires the exact opt-in value", () => {
    expect(realIntegrationEnabled({})).toBe(false);
    expect(realIntegrationEnabled({ TAPECI_REAL_INTEGRATIONS: "true" })).toBe(false);
    expect(realIntegrationEnabled({ TAPECI_REAL_INTEGRATIONS: "1" })).toBe(true);
  });

  it("reports credential presence without exposing values", () => {
    const summary = githubCredentialPresence({
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: "private-key-material",
      GITHUB_WEBHOOK_SECRET: "webhook-secret-material",
    });

    expect(summary).toEqual({
      appId: true,
      privateKey: true,
      webhookSecret: true,
    });
    expect(JSON.stringify(summary)).not.toContain("12345");
    expect(JSON.stringify(summary)).not.toContain("private-key-material");
    expect(JSON.stringify(summary)).not.toContain("webhook-secret-material");
  });

  it("allows loopback webhook targets without an external-delivery gate", () => {
    expect(() => assertWebhookTargetAllowed("http://127.0.0.1:8787/v1/github/webhook")).not.toThrow();
    expect(() => assertWebhookTargetAllowed("http://localhost:8787/v1/github/webhook")).not.toThrow();
    expect(() => assertWebhookTargetAllowed("http://[::1]:8787/v1/github/webhook")).not.toThrow();
  });

  it("requires a second opt-in before sending to an external host", () => {
    expect(() =>
      assertWebhookTargetAllowed("https://ci.example.test/v1/github/webhook"),
    ).toThrow(/external/i);
    expect(() =>
      assertWebhookTargetAllowed("https://ci.example.test/v1/github/webhook", {
        allowExternal: true,
      }),
    ).not.toThrow();
  });

  it("rejects non-HTTP URLs and embedded credentials", () => {
    expect(() => assertWebhookTargetAllowed("file:///tmp/webhook")).toThrow(/http/i);
    expect(() =>
      assertWebhookTargetAllowed("https://user:password@ci.example.test/webhook", {
        allowExternal: true,
      }),
    ).toThrow(/credentials/i);
  });
});
