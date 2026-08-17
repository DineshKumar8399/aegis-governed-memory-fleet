/**
 * GET /api/health
 *
 * Reports whether each dependency is reachable and, for Bedrock/S3, whether the
 * platform is running live or on its deterministic local fallback. Pass
 * `?probe=1` to force a real Bedrock round-trip instead of reading the cached
 * fallback state.
 */

import { NextResponse } from "next/server";
import { probeDatabase } from "@/lib/db";
import { bedrockAvailability, probeBedrock } from "@/lib/bedrock";
import { s3Availability } from "@/lib/s3";
import { env, gateThresholds } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const probe = new URL(request.url).searchParams.get("probe") === "1";

  const database = await probeDatabase();
  const bedrock = probe ? { ...bedrockAvailability(), probe: await probeBedrock() } : bedrockAvailability();

  // The dashboard plots distances against the threshold that is actually in
  // force, which depends on which embedder is serving requests right now.
  const active = gateThresholds(bedrock.state === "live" ? "bedrock" : "local");
  const status = database.ok ? 200 : 503;

  return NextResponse.json(
    {
      status: database.ok ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      database: {
        ...database,
        // Trim the long CockroachDB version banner to something displayable.
        version: database.version?.split(" ").slice(0, 3).join(" ") ?? null,
      },
      bedrock,
      s3: s3Availability(),
      config: {
        region: env.awsRegion,
        embeddingDim: env.embeddingDim,
        similarityThreshold: active.adjudicate,
        mergeThreshold: active.merge,
        similarityThresholdBedrock: env.similarityThreshold,
        similarityThresholdLocal: env.similarityThresholdLocal,
        topK: env.topK,
        minConfidence: env.minConfidence,
      },
    },
    { status },
  );
}
