/**
 * GitHub `installation` webhook events: created / deleted / suspend / unsuspend.
 *
 * Events are HMAC-verified over the raw body, deduplicated by `x-github-delivery`
 * in the same table as push deliveries, then applied as a soft state change.
 * Membership rows are never deleted here; a suspended installation simply stops
 * being usable by the API/worker.
 */
import { eq } from "drizzle-orm";
import { verifyWebhookSignature, type GitHubWebhookHeaders } from "@tapeci/github";
import { githubInstallations, webhookDeliveries, type Database } from "@tapeci/database";

export interface InstallationWebhookInput {
  readonly db: Database;
  readonly deliveryId: string;
  readonly headers: GitHubWebhookHeaders;
  readonly rawBody: string | Uint8Array;
  readonly secret: string;
  readonly payload: unknown;
  readonly now?: () => Date;
}

export interface InstallationWebhookResult {
  readonly duplicate: boolean;
  readonly accepted: boolean;
  readonly errorCode?: string;
}

interface InstallationPayload {
  readonly action: string;
  readonly installationId: number;
  readonly accountId: number;
  readonly accountLogin: string;
  readonly suspendedAt: Date | null;
}

const SUPPORTED_ACTIONS = new Set([
  "created",
  "deleted",
  "suspend",
  "unsuspend",
  "new_permissions_accepted",
]);

function headerValue(headers: GitHubWebhookHeaders, name: string): string | undefined {
  const value = headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function parsePayload(payload: unknown): InstallationPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const action = root["action"];
  const installation = root["installation"];
  if (typeof action !== "string" || typeof installation !== "object" || installation === null) {
    return null;
  }
  const record = installation as Record<string, unknown>;
  const account = record["account"];
  if (
    typeof record["id"] !== "number" ||
    !Number.isSafeInteger(record["id"]) ||
    record["id"] <= 0 ||
    typeof account !== "object" ||
    account === null
  ) {
    return null;
  }
  const accountRecord = account as Record<string, unknown>;
  if (
    typeof accountRecord["id"] !== "number" ||
    typeof accountRecord["login"] !== "string"
  ) {
    return null;
  }
  const suspendedAt =
    typeof record["suspended_at"] === "string" && record["suspended_at"].length > 0
      ? new Date(record["suspended_at"])
      : null;
  return {
    action,
    installationId: record["id"],
    accountId: accountRecord["id"],
    accountLogin: accountRecord["login"],
    suspendedAt: suspendedAt !== null && !Number.isNaN(suspendedAt.getTime()) ? suspendedAt : null,
  };
}

export async function handleInstallationWebhook(
  input: InstallationWebhookInput,
): Promise<InstallationWebhookResult> {
  const rawBytes =
    typeof input.rawBody === "string" ? new TextEncoder().encode(input.rawBody) : input.rawBody;
  if (
    !verifyWebhookSignature({
      secret: input.secret,
      rawBody: rawBytes,
      signatureHeader: headerValue(input.headers, "x-hub-signature-256"),
    })
  ) {
    return { duplicate: false, accepted: false, errorCode: "SIGNATURE_INVALID" };
  }
  const parsed = parsePayload(input.payload);
  if (parsed === null) {
    return { duplicate: false, accepted: false, errorCode: "INVALID_PAYLOAD" };
  }
  const now = input.now?.() ?? new Date();
  const deliveryId = input.deliveryId.trim();
  if (deliveryId.length === 0) {
    return { duplicate: false, accepted: false, errorCode: "MISSING_HEADERS" };
  }

  return input.db.transaction(async (tx) => {
    const [delivery] = await tx
      .insert(webhookDeliveries)
      .values({
        githubDeliveryId: deliveryId,
        githubInstallationNumericId: parsed.installationId,
        eventType: "installation",
        accepted: false,
      })
      .onConflictDoNothing()
      .returning();
    if (delivery === undefined) {
      return { duplicate: true, accepted: true };
    }
    const reject = async (errorCode: string): Promise<InstallationWebhookResult> => {
      await tx
        .update(webhookDeliveries)
        .set({ accepted: false, errorCode, processedAt: now })
        .where(eq(webhookDeliveries.id, delivery.id));
      return { duplicate: false, accepted: false, errorCode };
    };
    if (!SUPPORTED_ACTIONS.has(parsed.action)) {
      return reject("UNSUPPORTED_INSTALLATION_ACTION");
    }

    const deletedAt = parsed.action === "deleted" ? now : null;
    const suspendedAt =
      parsed.action === "suspend"
        ? parsed.suspendedAt ?? now
        : parsed.action === "unsuspend" || parsed.action === "new_permissions_accepted"
          ? null
          : parsed.suspendedAt;
    await tx
      .insert(githubInstallations)
      .values({
        installationId: parsed.installationId,
        githubAccountId: parsed.accountId,
        accountLogin: parsed.accountLogin,
        suspendedAt,
        deletedAt,
      })
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: {
          githubAccountId: parsed.accountId,
          accountLogin: parsed.accountLogin,
          suspendedAt,
          deletedAt,
          updatedAt: now,
        },
      });
    await tx
      .update(webhookDeliveries)
      .set({ accepted: true, processedAt: now, errorCode: null })
      .where(eq(webhookDeliveries.id, delivery.id));
    return { duplicate: false, accepted: true };
  });
}
