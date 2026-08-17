/** GET /api/stats — header KPIs, per-agent trust scores, topic breakdown. */

import { NextResponse } from "next/server";
import { getAgentTrustScores, getFleetStats } from "@/lib/stats";
import { listTopics } from "@/lib/vector";
import { bedrockAvailability } from "@/lib/bedrock";
import { s3Availability } from "@/lib/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [stats, agentTrust, topics] = await Promise.all([
      getFleetStats(),
      getAgentTrustScores(),
      listTopics(),
    ]);

    return NextResponse.json({
      stats,
      agentTrust,
      topics,
      gatekeeper: bedrockAvailability(),
      provenance: s3Availability(),
    });
  } catch (err) {
    console.error("[/api/stats]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read stats." },
      { status: 500 },
    );
  }
}
