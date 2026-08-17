/**
 * GET /api/audit-logs
 *
 * The Gatekeeper decision stream. Pass `?since=<ISO timestamp>` to poll for new
 * decisions only — the dashboard uses that for its live feed.
 */

import { NextResponse } from "next/server";
import { getAgentTrustScores, getAuditLogs, getFleetStats } from "@/lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VERDICTS = new Set(["ALLOWED", "CONFLICT_REJECTED", "SUPERSEDED", "MERGED"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const verdict = url.searchParams.get("verdict")?.trim().toUpperCase() || undefined;
  const topic = url.searchParams.get("topic")?.trim() || undefined;
  const agentId = url.searchParams.get("agentId")?.trim() || undefined;
  const since = url.searchParams.get("since")?.trim() || undefined;
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const withStats = url.searchParams.get("stats") !== "0";

  if (verdict && !VERDICTS.has(verdict)) {
    return NextResponse.json(
      { error: `\`verdict\` must be one of ${[...VERDICTS].join(", ")}.` },
      { status: 400 },
    );
  }

  try {
    const [logs, stats, trust] = await Promise.all([
      getAuditLogs({ verdict, topic, agentId, since, limit: Number.isFinite(limit) ? limit : 50 }),
      withStats ? getFleetStats() : Promise.resolve(null),
      withStats ? getAgentTrustScores() : Promise.resolve([]),
    ]);

    return NextResponse.json({
      count: logs.length,
      logs,
      stats,
      agentTrust: trust,
      // Cursor for the next poll — pass back as `?since=`.
      cursor: logs[0]?.created_at ?? since ?? null,
    });
  } catch (err) {
    console.error("[/api/audit-logs]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read audit logs." },
      { status: 500 },
    );
  }
}
