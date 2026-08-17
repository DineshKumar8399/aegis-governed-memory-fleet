/** Aggregate reads that power the dashboard header and the audit views. */

import { query } from "./db";
import type { AgentTrustScore, AuditLog, FleetStats, GateVerdict } from "./types";

const EMPTY_VERDICTS: Record<GateVerdict, number> = {
  ALLOWED: 0,
  CONFLICT_REJECTED: 0,
  SUPERSEDED: 0,
  MERGED: 0,
};

export async function getFleetStats(): Promise<FleetStats> {
  const [memoryRows, verdictRows, latencyRows] = await Promise.all([
    query<{
      total: number;
      active: number;
      quarantined: number;
      superseded: number;
      agents: number;
      topics: number;
    }>(
      `SELECT count(*)::INT                                          AS total,
              count(*) FILTER (WHERE status = 'ACTIVE')::INT         AS active,
              count(*) FILTER (WHERE status = 'QUARANTINED')::INT    AS quarantined,
              count(*) FILTER (WHERE status = 'SUPERSEDED')::INT     AS superseded,
              count(DISTINCT agent_id)::INT                          AS agents,
              count(DISTINCT topic)::INT                             AS topics
       FROM agent_memories`,
    ),
    query<{ gatekeeper_verdict: GateVerdict; n: number }>(
      `SELECT gatekeeper_verdict, count(*)::INT AS n
       FROM audit_gate_logs GROUP BY gatekeeper_verdict`,
    ),
    query<{ avg_latency: number | null }>(
      `SELECT avg(latency_ms) AS avg_latency
       FROM audit_gate_logs WHERE latency_ms IS NOT NULL AND latency_ms > 0`,
    ),
  ]);

  const memory = memoryRows[0] ?? {
    total: 0,
    active: 0,
    quarantined: 0,
    superseded: 0,
    agents: 0,
    topics: 0,
  };

  const verdictCounts = { ...EMPTY_VERDICTS };
  for (const row of verdictRows) verdictCounts[row.gatekeeper_verdict] = row.n;

  const totalDecisions = Object.values(verdictCounts).reduce((a, b) => a + b, 0);
  const blocked = verdictCounts.CONFLICT_REJECTED;

  return {
    totalMemories: memory.total,
    activeMemories: memory.active,
    quarantinedMemories: memory.quarantined,
    supersededMemories: memory.superseded,
    totalDecisions,
    verdictCounts,
    distinctAgents: memory.agents,
    distinctTopics: memory.topics,
    avgGateLatencyMs:
      latencyRows[0]?.avg_latency == null ? null : Math.round(latencyRows[0].avg_latency),
    conflictBlockRatePct:
      totalDecisions === 0 ? 0 : Math.round((blocked / totalDecisions) * 1000) / 10,
  };
}

export async function getAuditLogs(args: {
  limit?: number;
  verdict?: string;
  topic?: string;
  agentId?: string;
  since?: string;
}): Promise<AuditLog[]> {
  const params: unknown[] = [];
  const filters: string[] = [];

  if (args.verdict) {
    params.push(args.verdict);
    filters.push(`gatekeeper_verdict = $${params.length}`);
  }
  if (args.topic) {
    params.push(args.topic);
    filters.push(`topic = $${params.length}`);
  }
  if (args.agentId) {
    params.push(args.agentId);
    filters.push(`agent_id = $${params.length}`);
  }
  if (args.since) {
    params.push(args.since);
    filters.push(`created_at > $${params.length}::TIMESTAMPTZ`);
  }

  params.push(Math.max(1, Math.min(args.limit ?? 50, 250)));

  return query<AuditLog>(
    `SELECT id, incoming_fact, conflicting_memory_id, gatekeeper_verdict, reasoning,
            created_at, agent_id, topic, resulting_memory_id, nearest_distance,
            latency_ms, model_id, evaluator
     FROM audit_gate_logs
     ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
}

export async function getAgentTrustScores(): Promise<AgentTrustScore[]> {
  return query<AgentTrustScore>(
    `SELECT * FROM v_agent_trust_scores ORDER BY total_submissions DESC, agent_id`,
  );
}
