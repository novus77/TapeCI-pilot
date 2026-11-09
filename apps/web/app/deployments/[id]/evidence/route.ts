import { NextResponse } from "next/server";

import {
  getDeployment,
  getDeploymentPlan,
  getVerificationReport,
  listDeploymentEvents,
} from "@/lib/api";
import { describeError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Download the deployment's durable evidence as a single JSON document. */
export async function GET(
  _request: Request,
  { params }: { readonly params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    const [deployment, events, plan, verification] = await Promise.all([
      getDeployment(id),
      listDeploymentEvents(id),
      getDeploymentPlan(id),
      getVerificationReport(id),
    ]);
    const body = {
      schemaVersion: "tapeci.evidence.v1",
      exportedAt: new Date().toISOString(),
      deployment,
      events,
      plan,
      verification,
    };
    return new NextResponse(JSON.stringify(body, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="tapeci-deployment-${id}.json"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: { code: "EVIDENCE_UNAVAILABLE", message: describeError(error) } },
      { status: 502 },
    );
  }
}
