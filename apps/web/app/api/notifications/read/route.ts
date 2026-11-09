import { NextResponse } from "next/server";
import { markNotificationsRead } from "@/lib/api";
import { describeError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as { deploymentIds?: unknown };
    const ids = Array.isArray(body.deploymentIds)
      ? body.deploymentIds.filter((value): value is string => typeof value === "string")
      : [];
    return NextResponse.json({ marked: await markNotificationsRead(ids) });
  } catch (error) {
    return NextResponse.json({ error: describeError(error) }, { status: 502 });
  }
}
