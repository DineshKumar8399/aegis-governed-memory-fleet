/**
 * GET /api/memories
 *
 * Reads the substrate. With `?q=` it runs a distributed vector search against
 * CockroachDB and returns cosine distances alongside each row; without it, a
 * plain filtered listing.
 *
 * Query params:
 *   q       — natural-language probe; enables semantic ranking
 *   topic   — restrict to one topic domain
 *   status  — ACTIVE | QUARANTINED | SUPERSEDED
 *   agentId — restrict to one agent
 *   limit   — 1..200 (default 50)
 */

import { NextResponse } from "next/server";
import { embedText } from "@/lib/bedrock";
import { listMemories, listTopics, semanticSearch, topicTimeline } from "@/lib/vector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const topic = url.searchParams.get("topic")?.trim() || undefined;
  const status = url.searchParams.get("status")?.trim().toUpperCase() || undefined;
  const agentId = url.searchParams.get("agentId")?.trim() || undefined;
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const withTimeline = url.searchParams.get("timeline") === "1";

  if (status && !["ACTIVE", "QUARANTINED", "SUPERSEDED"].includes(status)) {
    return NextResponse.json(
      { error: "`status` must be ACTIVE, QUARANTINED or SUPERSEDED." },
      { status: 400 },
    );
  }

  try {
    const topics = await listTopics();

    if (q.length > 0) {
      const embedding = await embedText(q);
      const memories = await semanticSearch({
        embedding: embedding.vector,
        topic,
        status,
        limit: Number.isFinite(limit) ? limit : 50,
      });

      return NextResponse.json({
        mode: "semantic",
        query: q,
        embedding: {
          source: embedding.source,
          modelId: embedding.modelId,
          dimensions: embedding.vector.length,
          latencyMs: embedding.latencyMs,
          inputTokens: embedding.inputTokens,
        },
        count: memories.length,
        memories,
        topics,
        timeline: withTimeline && topic ? await topicTimeline(topic) : [],
        sql: SEMANTIC_SQL,
      });
    }

    const memories = await listMemories({
      status,
      topic,
      agentId,
      limit: Number.isFinite(limit) ? limit : 50,
    });

    return NextResponse.json({
      mode: "listing",
      count: memories.length,
      memories,
      topics,
      timeline: withTimeline && topic ? await topicTimeline(topic) : [],
      sql: LISTING_SQL,
    });
  } catch (err) {
    console.error("[/api/memories]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read memories." },
      { status: 500 },
    );
  }
}

// Echoed to the dashboard's MCP/SQL inspector so the query being run is visible.
const SEMANTIC_SQL = `SELECT id, agent_id, fact_statement, topic, valid_from, superseded_at,
       confidence_score, source_s3_uri, status,
       embedding <=> $1::VECTOR(1024) AS distance
FROM agent_memories
[WHERE topic = $2 AND status = $3]
ORDER BY embedding <=> $1::VECTOR(1024)
LIMIT $n;`;

const LISTING_SQL = `SELECT id, agent_id, fact_statement, topic, valid_from, superseded_at,
       confidence_score, source_s3_uri, status
FROM agent_memories
[WHERE status = $1 AND topic = $2 AND agent_id = $3]
ORDER BY valid_from DESC
LIMIT $n OFFSET $m;`;
