/**
 * End-to-end tests for the Write-Gate against a live CockroachDB cluster.
 *
 * Each verdict is exercised through `processMemorySubmission` — the same entry
 * point the API routes and the swarm simulator call — and checked on both sides:
 * what the substrate now believes, and what the audit trail says happened.
 */

import "./setup";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { closePool, query } from "../lib/db";
import { env } from "../lib/env";
import { embedText } from "../lib/bedrock";
import { processMemorySubmission, SubmissionError } from "../lib/writeGate";
import { auditRowsForTopic, cleanupTopic, memoriesInTopic, uniqueTopic } from "./helpers";

describe("Write-Gate", { concurrency: false }, () => {
  const topics: string[] = [];

  const scopedTopic = (label: string) => {
    const topic = uniqueTopic(label);
    topics.push(topic);
    return topic;
  };

  after(async () => {
    for (const topic of topics) await cleanupTopic(topic);
    await closePool();
  });

  it("admits the first fact in a topic as ALLOWED", async () => {
    const topic = scopedTopic("allow");
    const result = await processMemorySubmission({
      agentId: "agent-scout",
      topic,
      fact: "The Frankfurt edge cluster serves 12 availability zones.",
      confidence: 0.9,
    });

    assert.equal(result.verdict, "ALLOWED");
    assert.ok(result.memory, "an allowed fact must produce a memory row");
    assert.equal(result.memory!.status, "ACTIVE");
    assert.equal(result.neighbours.length, 0);

    const audit = await auditRowsForTopic(topic);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].gatekeeper_verdict, "ALLOWED");
    assert.equal(audit[0].resulting_memory_id, result.memory!.id);
  });

  it("quarantines a contradiction as CONFLICT_REJECTED without touching the incumbent", async () => {
    const topic = scopedTopic("conflict");
    const first = await processMemorySubmission({
      agentId: "agent-alpha",
      topic,
      fact: "The payments incident caused 6 minutes of customer-facing downtime.",
      confidence: 0.92,
    });
    assert.equal(first.verdict, "ALLOWED");

    const second = await processMemorySubmission({
      agentId: "agent-rogue",
      topic,
      fact: "The payments incident caused 42 minutes of customer-facing downtime.",
      confidence: 0.9,
    });

    assert.equal(second.verdict, "CONFLICT_REJECTED");
    assert.ok(second.conflictingMemory, "a rejection must name the belief it contradicts");
    assert.equal(second.conflictingMemory!.id, first.memory!.id);

    // Rejected facts are kept as evidence, not dropped.
    assert.ok(second.memory, "a rejected fact is still persisted");
    assert.equal(second.memory!.status, "QUARANTINED");

    const rows = await memoriesInTopic(topic);
    const active = rows.filter((r) => r.status === "ACTIVE");
    assert.equal(active.length, 1, "the incumbent belief must survive untouched");
    assert.equal(active[0].id, first.memory!.id);
    assert.equal(active[0].superseded_at, null);
  });

  it("replaces a belief with SUPERSEDED when the correction is newer", async () => {
    const topic = scopedTopic("supersede");
    const first = await processMemorySubmission({
      agentId: "agent-alpha",
      topic,
      fact: "The checkout service p99 latency is 120 ms in eu-central-1.",
      confidence: 0.9,
    });

    const second = await processMemorySubmission({
      agentId: "agent-beta",
      topic,
      fact: "Updated: the checkout service p99 latency is 240 ms in eu-central-1.",
      confidence: 0.9,
    });

    assert.equal(second.verdict, "SUPERSEDED");
    assert.equal(second.conflictingMemory!.id, first.memory!.id);

    const rows = await memoriesInTopic(topic);
    const previous = rows.find((r) => r.id === first.memory!.id)!;
    assert.equal(previous.status, "SUPERSEDED");
    assert.ok(previous.superseded_at !== null, "a replaced belief must be stamped");

    const active = rows.filter((r) => r.status === "ACTIVE");
    assert.equal(active.length, 1);
    assert.equal(active[0].id, second.memory!.id);
  });

  it("records MERGED for a restatement and writes no new row", async () => {
    const topic = scopedTopic("merge");
    await processMemorySubmission({
      agentId: "agent-alpha",
      topic,
      fact: "Platform division Q3 2026 revenue was 48.2 million.",
      confidence: 0.9,
    });

    const before = (await memoriesInTopic(topic)).length;
    const merged = await processMemorySubmission({
      agentId: "agent-gamma",
      topic,
      fact: "Q3 2026 revenue for the platform division was 48.2 million.",
      confidence: 0.9,
    });

    assert.equal(merged.verdict, "MERGED");
    assert.equal(merged.memory, null, "a merge must not create a duplicate row");
    assert.equal((await memoriesInTopic(topic)).length, before);

    // The decision is still auditable even though nothing was written.
    const audit = await auditRowsForTopic(topic);
    assert.equal(audit.at(-1)!.gatekeeper_verdict, "MERGED");
  });

  it("quarantines a low-confidence claim without paying for adjudication", async () => {
    const topic = scopedTopic("lowconf");
    const result = await processMemorySubmission({
      agentId: "agent-unsure",
      topic,
      fact: "The database might possibly be in some region.",
      confidence: 0.05,
    });

    assert.equal(result.verdict, "CONFLICT_REJECTED");
    assert.equal(result.evaluator, "fast-path");
    assert.equal(result.memory!.status, "QUARANTINED");
    assert.equal(result.latencyMs, 0, "the fast path must not call a model");
  });

  it("rejects malformed submissions before any write happens", async () => {
    const topic = scopedTopic("invalid");
    await assert.rejects(
      () => processMemorySubmission({ agentId: "", topic, fact: "x" }),
      SubmissionError,
    );
    await assert.rejects(
      () => processMemorySubmission({ agentId: "a", topic, fact: "" }),
      SubmissionError,
    );
    await assert.rejects(
      () => processMemorySubmission({ agentId: "a", topic: "", fact: "x" }),
      SubmissionError,
    );
    assert.equal((await memoriesInTopic(topic)).length, 0);
  });

  it("normalises topics so casing cannot fork a belief set", async () => {
    const topic = scopedTopic("casing");
    await processMemorySubmission({
      agentId: "agent-alpha",
      topic: topic.toUpperCase(),
      fact: "The failover drill is scheduled for the first Tuesday of each month.",
      confidence: 0.9,
    });
    const rows = await memoriesInTopic(topic);
    assert.equal(rows.length, 1, "an upper-cased topic must land in the same partition");
  });
});

describe("CockroachDB vector index", { concurrency: false }, () => {
  const topic = uniqueTopic("index");

  after(async () => {
    await cleanupTopic(topic);
    await closePool();
  });

  it("serves the gate's retrieval query from the C-SPANN index, not a scan", async () => {
    // This needs real volume. On a demo-sized table the optimizer correctly
    // prefers a plain scan plus top-k — reading 14 rows beats descending an
    // index — so asserting against the seeded substrate would only prove that
    // CockroachDB costs small tables sensibly.
    //
    // What the assertion is actually defending: `status` must stay in the index
    // prefix. Drop it and the residual filter pushes the optimizer back to a
    // scan at *any* size, which still returns correct answers and silently
    // costs the latency story.
    await bulkLoad(topic, 800);
    await query(`ANALYZE agent_memories`);

    const probe = await embedText("a representative probe fact about cluster latency");
    const literal = `[${probe.vector.join(",")}]`;

    const plan = await query<{ info: string }>(
      `EXPLAIN
       SELECT id, embedding <=> $1::VECTOR(${env.embeddingDim}) AS distance
       FROM agent_memories
       WHERE status = 'ACTIVE' AND topic = $2
       ORDER BY embedding <=> $1::VECTOR(${env.embeddingDim})
       LIMIT 5`,
      [literal, topic],
    );

    const text = plan.map((r) => r.info).join("\n");
    assert.match(text, /vector search/i, `expected a vector search in the plan, got:\n${text}`);
    assert.match(
      text,
      /idx_memories_topic_status_embedding/,
      `expected the (topic, status, embedding) index to serve it, got:\n${text}`,
    );
    // Both equality predicates must be satisfied by the index prefix rather than
    // re-checked as a residual filter above the scan.
    assert.match(
      text,
      /prefix spans:.*ACTIVE/,
      `expected topic+status to be answered by the index prefix, got:\n${text}`,
    );
  });
});

/** Random unit vectors — direction is irrelevant, row count is the point. */
function randomUnitVector(dim: number): number[] {
  const vec = new Array<number>(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const x = Math.random() * 2 - 1;
    vec[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  return vec.map((x) => x / norm);
}

async function bulkLoad(topic: string, count: number, batchSize = 250): Promise<void> {
  for (let offset = 0; offset < count; offset += batchSize) {
    const rows: string[] = [];
    const params: unknown[] = [];
    const n = Math.min(batchSize, count - offset);
    for (let i = 0; i < n; i++) {
      const base = params.length;
      params.push(
        `bulk-${offset + i}`,
        `Synthetic probe fact number ${offset + i}.`,
        topic,
        `[${randomUnitVector(env.embeddingDim).join(",")}]`,
      );
      rows.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::VECTOR(${env.embeddingDim}), 0.9, 'test://bulk', 'ACTIVE')`,
      );
    }
    await query(
      `INSERT INTO agent_memories
         (agent_id, fact_statement, topic, embedding, confidence_score, source_s3_uri, status)
       VALUES ${rows.join(", ")}`,
      params,
    );
  }
}
