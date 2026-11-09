import { describe, expect, it } from "vitest";
import {
  buildSignedEvent,
  parseSendEventOptions,
} from "../../../scripts/real-integrations/github/send-event.js";

describe("real GitHub event sender gates", () => {
  it("builds a deterministic GitHub-shaped signed request", () => {
    const event = buildSignedEvent({
      event: "installation",
      deliveryId: "delivery-123",
      secret: "webhook-secret",
      payload: { action: "created" },
    });

    expect(event.headers["x-github-event"]).toBe("installation");
    expect(event.headers["x-github-delivery"]).toBe("delivery-123");
    expect(event.headers["x-hub-signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(event.body)).toEqual({ action: "created" });
  });

  it("requires opt-in, an explicit target and a credential source", () => {
    expect(() =>
      parseSendEventOptions(["--target", "http://127.0.0.1:8787/v1/github/webhook"], {}),
    ).toThrow(/TAPECI_REAL_INTEGRATIONS=1/);

    expect(() =>
      parseSendEventOptions([], { TAPECI_REAL_INTEGRATIONS: "1" }),
    ).toThrow(/--target/);

    expect(() =>
      parseSendEventOptions(
        ["--target", "http://127.0.0.1:8787/v1/github/webhook"],
        { TAPECI_REAL_INTEGRATIONS: "1" },
      ),
    ).toThrow(/GITHUB_WEBHOOK_SECRET/i);
  });

  it("requires separate approval for a public target", () => {
    expect(() =>
      parseSendEventOptions(
        ["--target", "https://ci.example.test/v1/github/webhook"],
        {
          TAPECI_REAL_INTEGRATIONS: "1",
          GITHUB_WEBHOOK_SECRET: "webhook-secret",
        },
      ),
    ).toThrow(/external/i);

    const options = parseSendEventOptions(
      [
        "--target",
        "https://ci.example.test/v1/github/webhook",
        "--allow-external",
        "--event",
        "installation",
        "--action",
        "created",
      ],
      {
        TAPECI_REAL_INTEGRATIONS: "1",
        GITHUB_WEBHOOK_SECRET: "webhook-secret",
      },
    );
    expect(options.target.toString()).toBe("https://ci.example.test/v1/github/webhook");
    expect(options.allowExternal).toBe(true);
  });
});
