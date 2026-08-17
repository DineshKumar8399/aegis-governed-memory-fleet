/**
 * POST /api/memory/submit
 *
 * The fleet's only write path into the memory substrate. Autonomous agents post
 * here; the Write-Gate decides whether the claim becomes part of the shared
 * world model, replaces an existing belief, or is quarantined.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { processMemorySubmission, SubmissionError } from "@/lib/writeGate";
import { bedrockAvailability } from "@/lib/bedrock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SubmitSchema = z.object({
  agentId: z.string().min(1).max(64),
  fact: z.string().min(1).max(4000),
  topic: z.string().min(1).max(64),
  confidence: z.number().min(0).max(1).optional(),
  sourceUri: z.string().max(1024).optional(),
  rawDocument: z.string().max(100_000).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = SubmitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid submission.", issues: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  try {
    const result = await processMemorySubmission(parsed.data);
    return NextResponse.json(
      {
        ...result,
        gatekeeper: bedrockAvailability(),
      },
      {
        // 202 signals "received and adjudicated, but not admitted".
        status: result.verdict === "CONFLICT_REJECTED" ? 202 : 201,
      },
    );
  } catch (err) {
    if (err instanceof SubmissionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[/api/memory/submit]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Write-gate failure." },
      { status: 500 },
    );
  }
}
