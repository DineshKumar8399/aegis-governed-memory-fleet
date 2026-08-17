/**
 * POST /api/simulate-swarm
 *
 * Launches a fleet of simulated agents at one topic simultaneously. Returns
 * newline-delimited JSON by default so the dashboard terminal can render each
 * verdict the instant the gate produces it; pass `{"stream": false}` for a
 * single JSON array.
 *
 * GET returns the scenario catalogue.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { runSwarm, SCENARIOS, streamSwarm } from "@/lib/swarm";
import { bedrockAvailability } from "@/lib/bedrock";
import { s3Availability } from "@/lib/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SwarmSchema = z.object({
  scenarioId: z.string().max(64).optional(),
  agentCount: z.number().int().min(1).max(5).optional(),
  stream: z.boolean().optional(),
});

export async function GET() {
  return NextResponse.json({
    scenarios: SCENARIOS.map((s) => ({
      id: s.id,
      title: s.title,
      topic: s.topic,
      anchor: { agentId: s.anchor.agentId, fact: s.anchor.fact },
      agents: s.agents.map((a) => ({
        agentId: a.agentId,
        role: a.role,
        intent: a.intent,
        fact: a.fact,
        confidence: a.confidence,
        expectation: a.expectation,
      })),
    })),
    gatekeeper: bedrockAvailability(),
    provenance: s3Availability(),
  });
}

export async function POST(request: Request) {
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = SwarmSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid swarm request.", issues: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  const { scenarioId, agentCount, stream = true } = parsed.data;

  if (!stream) {
    try {
      const events = await runSwarm({ scenarioId, agentCount });
      return NextResponse.json({ events, gatekeeper: bedrockAvailability() });
    } catch (err) {
      console.error("[/api/simulate-swarm]", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Swarm failed." },
        { status: 500 },
      );
    }
  }

  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (payload: unknown) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));

      try {
        emit({ type: "meta", gatekeeper: bedrockAvailability(), provenance: s3Availability() });
        for await (const event of streamSwarm({ scenarioId, agentCount })) {
          emit(event);
        }
      } catch (err) {
        emit({
          type: "error",
          message: err instanceof Error ? err.message : "Swarm failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
