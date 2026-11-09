import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { computeWebhookSignature } from "@tapeci/github";
import {
  assertWebhookTargetAllowed,
  realIntegrationEnabled,
  type Environment,
} from "../common.js";

type EventType = "installation" | "push";

export interface SendEventOptions {
  readonly target: URL;
  readonly event: EventType;
  readonly action: string;
  readonly deliveryId: string;
  readonly secret: string;
  readonly allowExternal: boolean;
  readonly installationId: number;
  readonly accountId: number;
  readonly accountLogin: string;
  readonly repositoryId: number;
  readonly repositoryFullName: string;
  readonly commitSha: string;
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function integerOption(
  argv: readonly string[],
  flag: string,
  fallback: number,
): number {
  const raw = valueAfter(argv, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return value;
}

export function parseSendEventOptions(
  argv: readonly string[],
  env: Environment,
): SendEventOptions {
  if (!realIntegrationEnabled(env)) {
    throw new Error("real event delivery requires TAPECI_REAL_INTEGRATIONS=1");
  }
  const rawTarget = valueAfter(argv, "--target");
  if (rawTarget === undefined || rawTarget.trim() === "") {
    throw new Error("--target is required");
  }
  const allowExternal = argv.includes("--allow-external");
  const target = assertWebhookTargetAllowed(rawTarget, { allowExternal });
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (secret === undefined || secret.trim() === "") {
    throw new Error("GITHUB_WEBHOOK_SECRET is required in the current environment");
  }
  const rawEvent = valueAfter(argv, "--event") ?? "installation";
  if (rawEvent !== "installation" && rawEvent !== "push") {
    throw new Error("--event must be installation or push");
  }
  return {
    target,
    event: rawEvent,
    action: valueAfter(argv, "--action") ?? "created",
    deliveryId: valueAfter(argv, "--delivery-id") ?? `tapeci-real-${randomUUID()}`,
    secret,
    allowExternal,
    installationId: integerOption(argv, "--installation-id", 8_800_000_001),
    accountId: integerOption(argv, "--account-id", 8_800_000_002),
    accountLogin: valueAfter(argv, "--account-login") ?? "tapeci-real-integration",
    repositoryId: integerOption(argv, "--repository-id", 8_800_000_003),
    repositoryFullName:
      valueAfter(argv, "--repository-full-name") ?? "tapeci-real-integration/site",
    commitSha: valueAfter(argv, "--commit-sha") ?? "a".repeat(40),
  };
}

export interface SignedEvent {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function buildSignedEvent(input: {
  readonly event: EventType;
  readonly deliveryId: string;
  readonly secret: string;
  readonly payload: unknown;
}): SignedEvent {
  const body = JSON.stringify(input.payload);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": "tapeci-real-integration",
      "x-github-event": input.event,
      "x-github-delivery": input.deliveryId,
      "x-hub-signature-256": computeWebhookSignature(input.secret, body),
    },
  };
}

function payloadFor(options: SendEventOptions): unknown {
  if (options.event === "installation") {
    return {
      action: options.action,
      installation: {
        id: options.installationId,
        account: {
          id: options.accountId,
          login: options.accountLogin,
          type: "Organization",
        },
        suspended_at: options.action === "suspend" ? new Date().toISOString() : null,
      },
    };
  }
  return {
    ref: "refs/heads/main",
    before: "0".repeat(40),
    after: options.commitSha,
    created: false,
    deleted: false,
    forced: false,
    repository: {
      id: options.repositoryId,
      name: options.repositoryFullName.split("/").at(-1) ?? "site",
      full_name: options.repositoryFullName,
      owner: { id: options.accountId, login: options.accountLogin },
      default_branch: "main",
    },
    installation: { id: options.installationId },
  };
}

export interface DeliveryEvidence {
  readonly status: number;
  readonly deliveryId: string;
  readonly event: EventType;
  readonly duplicate: boolean;
  readonly accepted: boolean;
  readonly errorCode: string | null;
}

export async function sendSignedEvent(
  options: SendEventOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryEvidence> {
  const signed = buildSignedEvent({
    event: options.event,
    deliveryId: options.deliveryId,
    secret: options.secret,
    payload: payloadFor(options),
  });
  const response = await fetchImpl(options.target, {
    method: "POST",
    headers: signed.headers,
    body: signed.body,
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    status: response.status,
    deliveryId: options.deliveryId,
    event: options.event,
    duplicate: body["duplicate"] === true,
    accepted: body["accepted"] === true,
    errorCode:
      typeof body["errorCode"] === "string"
        ? body["errorCode"]
        : typeof (body["error"] as Record<string, unknown> | undefined)?.["code"] === "string"
          ? ((body["error"] as Record<string, unknown>)["code"] as string)
          : null,
  };
}

async function main(): Promise<void> {
  const options = parseSendEventOptions(process.argv.slice(2), process.env);
  if (!options.target.hostname.match(/^(localhost|127\.0\.0\.1|\[?::1\]?)$/)) {
    console.log(
      [
        "external delivery requested; verify the following before execution:",
        `target=${options.target.toString()}`,
        `event=${options.event}`,
        `action=${options.action}`,
        `delivery=${options.deliveryId}`,
        `installation=${options.installationId}`,
        `repository=${options.repositoryFullName}`,
      ].join("\n"),
    );
  }
  const evidence = await sendSignedEvent(options);
  console.log(JSON.stringify(evidence));
  if (evidence.status < 200 || evidence.status >= 300) process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
