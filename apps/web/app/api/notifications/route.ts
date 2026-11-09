import { NextResponse } from "next/server";
import { listNotifications } from "@/lib/api";
import { describeError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const notifications = await listNotifications();
    return NextResponse.json({
      notifications,
      unread: notifications.filter((row) => row.readAt === null).length,
    });
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 502 });
  }
}
