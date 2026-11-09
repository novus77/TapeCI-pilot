import nodemailer from "nodemailer";
import { and, eq } from "drizzle-orm";
import { notificationChannels, projects, type Database } from "@tapeci/database";
import type { ApiEnv } from "./env.js";

export interface NotificationDeliveryResult {
  readonly channelId: string;
  readonly kind: string;
  readonly ok: boolean;
  readonly error?: string;
}

export async function sendSlack(target: string, text: string): Promise<void> {
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw new Error(`Slack returned HTTP ${response.status}`);
}

export async function sendEmail(env: ApiEnv, to: string, subject: string, text: string): Promise<void> {
  if (env.smtpUrl === null || env.smtpUrl === undefined) {
    throw new Error("email delivery requires SMTP_URL");
  }
  const transport = nodemailer.createTransport(env.smtpUrl);
  try {
    await transport.sendMail({
      from: env.smtpFrom ?? "tapeci@localhost",
      to,
      subject,
      text,
    });
  } finally {
    transport.close();
  }
}

/** Deliver a notification to every enabled channel of a project. Best-effort per channel. */
export async function notifyProject(
  db: Database,
  env: ApiEnv,
  projectId: string,
  subject: string,
  text: string,
): Promise<readonly NotificationDeliveryResult[]> {
  const channels = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.projectId, projectId), eq(notificationChannels.enabled, true)));
  const results: NotificationDeliveryResult[] = [];
  for (const channel of channels) {
    try {
      if (channel.kind === "slack") await sendSlack(channel.target, text);
      else await sendEmail(env, channel.target, subject, text);
      results.push({ channelId: channel.id, kind: channel.kind, ok: true });
    } catch (error) {
      results.push({
        channelId: channel.id,
        kind: channel.kind,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export async function projectName(db: Database, projectId: string): Promise<string> {
  const [row] = await db.select({ repo: projects.repoFullName }).from(projects).where(eq(projects.id, projectId)).limit(1);
  return row?.repo ?? "project";
}
