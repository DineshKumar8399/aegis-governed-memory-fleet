/**
 * Shared fixtures for the integration tests.
 *
 * Every test that touches the database works inside its own generated topic, so
 * runs are isolated from the seeded demo substrate and from each other. Nothing
 * here truncates a shared table — a test that wipes `agent_memories` would
 * destroy the demo data sitting in the Docker volume.
 */

import "./setup";
import { query } from "../lib/db";
import { embedText } from "../lib/bedrock";
import { insertMemory } from "../lib/vector";
import type { AgentMemory } from "../lib/types";

/** A collision-proof topic name, so parallel test files never share state. */
export function uniqueTopic(label: string): string {
  return `test-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Seeds an established, currently-believed fact directly (bypassing the gate). */
export async function seedEstablishedFact(args: {
  topic: string;
  agentId: string;
  fact: string;
  confidence?: number;
}): Promise<AgentMemory> {
  const embedding = await embedText(args.fact);
  return insertMemory({
    agentId: args.agentId,
    fact: args.fact,
    topic: args.topic,
    embedding: embedding.vector,
    confidence: args.confidence ?? 0.9,
    sourceUri: "test://seed",
    status: "ACTIVE",
  });
}

export async function memoriesInTopic(topic: string): Promise<AgentMemory[]> {
  return query<AgentMemory>(
    `SELECT id, agent_id, fact_statement, topic, valid_from, superseded_at,
            confidence_score, source_s3_uri, status
     FROM agent_memories WHERE topic = $1 ORDER BY valid_from`,
    [topic],
  );
}

export async function auditRowsForTopic(topic: string) {
  return query<{
    id: string;
    gatekeeper_verdict: string;
    resulting_memory_id: string | null;
    conflicting_memory_id: string | null;
    agent_id: string;
  }>(
    `SELECT id, gatekeeper_verdict, resulting_memory_id, conflicting_memory_id, agent_id
     FROM audit_gate_logs WHERE topic = $1 ORDER BY created_at`,
    [topic],
  );
}

/** Removes everything a test created. Audit rows go first — they reference memories. */
export async function cleanupTopic(topic: string): Promise<void> {
  await query(`DELETE FROM audit_gate_logs WHERE topic = $1`, [topic]);
  await query(`DELETE FROM agent_memories WHERE topic = $1`, [topic]);
}
