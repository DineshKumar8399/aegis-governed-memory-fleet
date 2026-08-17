/** Shared domain types — used by the API layer, the write-gate, and the UI. */

export type MemoryStatus = "ACTIVE" | "QUARANTINED" | "SUPERSEDED";

export type GateVerdict = "ALLOWED" | "CONFLICT_REJECTED" | "SUPERSEDED" | "MERGED";

/** What the gatekeeper model is allowed to return before we map it to a verdict. */
export type LlmDecision = "ALLOWED" | "CONFLICT" | "SUPERSEDE" | "MERGE";

export interface AgentMemory {
  id: string;
  agent_id: string;
  fact_statement: string;
  topic: string;
  valid_from: string;
  superseded_at: string | null;
  confidence_score: number;
  source_s3_uri: string;
  status: MemoryStatus;
}

/** A memory row plus its cosine distance from a probe vector. */
export interface ScoredMemory extends AgentMemory {
  /** Cosine distance: 0 = identical direction, 1 = orthogonal, 2 = opposite. */
  distance: number;
  /** Convenience projection of `distance` into a 0–1 "how alike" score. */
  similarity: number;
}

export interface AuditLog {
  id: string;
  incoming_fact: string;
  conflicting_memory_id: string | null;
  gatekeeper_verdict: GateVerdict;
  reasoning: string;
  created_at: string;
  agent_id: string | null;
  topic: string | null;
  resulting_memory_id: string | null;
  nearest_distance: number | null;
  latency_ms: number | null;
  model_id: string | null;
  evaluator: string | null;
}

export interface MemorySubmission {
  agentId: string;
  fact: string;
  topic: string;
  sourceUri?: string;
  /** Agent's self-reported confidence, 0–1. Defaults to 0.75. */
  confidence?: number;
  /** Raw source document to archive in S3 for provenance. */
  rawDocument?: string;
}

/** The adjudication returned by the gatekeeper before it is applied. */
export interface GateAdjudication {
  decision: LlmDecision;
  reason: string;
  conflictingFactId?: string | null;
  /** "bedrock" when Claude adjudicated, "heuristic" for the offline gatekeeper. */
  evaluator: "bedrock" | "heuristic" | "fast-path";
  modelId: string | null;
  /** Round-trip time of the adjudication call itself. */
  latencyMs: number;
}

/** Everything the Write-Gate did for one submission. */
export interface GateResult {
  verdict: GateVerdict;
  reasoning: string;
  evaluator: GateAdjudication["evaluator"];
  modelId: string | null;
  /** The row that was written (ACTIVE for allowed, QUARANTINED for rejected). */
  memory: AgentMemory | null;
  /** The prior belief that was contradicted or replaced, if any. */
  conflictingMemory: ScoredMemory | null;
  /** Top-k neighbours the gate considered, nearest first. */
  neighbours: ScoredMemory[];
  auditLogId: string;
  latencyMs: number;
  /** Wall-clock for the whole gate, including embedding + SQL. */
  totalMs: number;
  /** CockroachDB 40001 aborts replayed before this write committed. */
  serializationRetries: number;
  submission: {
    agentId: string;
    fact: string;
    topic: string;
    confidence: number;
    sourceUri: string;
  };
}

export interface FleetStats {
  totalMemories: number;
  activeMemories: number;
  quarantinedMemories: number;
  supersededMemories: number;
  totalDecisions: number;
  verdictCounts: Record<GateVerdict, number>;
  distinctAgents: number;
  distinctTopics: number;
  avgGateLatencyMs: number | null;
  conflictBlockRatePct: number;
}

export interface AgentTrustScore {
  agent_id: string;
  total_submissions: number;
  active_facts: number;
  quarantined_facts: number;
  superseded_facts: number;
  avg_confidence: number | null;
  acceptance_rate_pct: number | null;
}

export interface TimelineEntry {
  id: string;
  topic: string;
  agent_id: string;
  fact_statement: string;
  status: MemoryStatus;
  valid_from: string;
  superseded_at: string | null;
}

/** One line of the streaming swarm console. */
export interface SwarmEvent {
  type: "start" | "result" | "error" | "done";
  index?: number;
  total?: number;
  agentId?: string;
  fact?: string;
  topic?: string;
  intent?: string;
  result?: GateResult;
  message?: string;
  elapsedMs?: number;
}
