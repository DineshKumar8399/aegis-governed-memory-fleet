/**
 * Proves the two claims Aegis makes about running on CockroachDB under
 * concurrency. Both need a live cluster — `docker compose up -d` first.
 *
 *  1. SERIALIZABLE genuinely aborts the loser of a read-write race with SQLSTATE
 *     40001, and `withRetry` replays it to success. Asserted deterministically
 *     with a latch rather than hoped for by firing traffic and looking.
 *
 *  2. When a whole swarm races to overwrite the same belief, the substrate ends
 *     with exactly one currently-believed fact for that topic, and the audit
 *     trail accounts for every submission. That invariant — not the retry count —
 *     is the property that matters: a fleet that ends with two contradictory
 *     ACTIVE facts has been corrupted, however many retries it logged.
 */

import "./setup";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { closePool, withRetry } from "../lib/db";
import { processMemorySubmission } from "../lib/writeGate";
import { auditRowsForTopic, cleanupTopic, memoriesInTopic, seedEstablishedFact, uniqueTopic } from "./helpers";

/** Resolves once, letting a test hold one transaction open at a chosen point. */
function latch() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

describe("CockroachDB serializable retry", { concurrency: false }, () => {
  const topics: string[] = [];

  after(async () => {
    for (const topic of topics) await cleanupTopic(topic);
    await closePool();
  });

  it("aborts the loser of a read-write cycle with 40001 and replays it", async () => {
    const topic = uniqueTopic("40001");
    topics.push(topic);

    // Two rows and a crossed dependency: A reads P then writes Q, B reads Q then
    // writes P. Neither order serialises, so SERIALIZABLE must abort one of them.
    //
    // Note what does *not* work here: two transactions blind-inserting different
    // rows. Those are serializable however they interleave (the reader simply
    // orders before the writer), and CockroachDB is right to let both commit.
    // A genuine cycle is the only thing that forces 40001.
    const p = await seedEstablishedFact({ topic, agentId: "row-p", fact: "Row P baseline." });
    const q = await seedEstablishedFact({ topic, agentId: "row-q", fact: "Row Q baseline." });

    const aHasRead = latch();
    const bHasRead = latch();
    let aAttempts = 0;
    let bAttempts = 0;

    const readConfidence = async (client: { query: Function }, id: string) => {
      const res = await client.query(
        `SELECT confidence_score FROM agent_memories WHERE id = $1`,
        [id] as never[],
      );
      return (res.rows[0] as { confidence_score: number }).confidence_score;
    };

    const bumpConfidence = (client: { query: Function }, id: string, value: number) =>
      client.query(`UPDATE agent_memories SET confidence_score = $2 WHERE id = $1`, [
        id,
        value,
      ] as never[]);

    // Both transactions must complete their read before either writes; the
    // latches only gate the first attempt so a replay can run unimpeded.
    const txnA = withRetry(async (client) => {
      const seen = await readConfidence(client, p.id);
      if (++aAttempts === 1) {
        aHasRead.release();
        await bHasRead.gate;
      }
      await bumpConfidence(client, q.id, Math.min(0.99, seen + 0.01));
    });

    const txnB = withRetry(async (client) => {
      const seen = await readConfidence(client, q.id);
      if (++bAttempts === 1) {
        bHasRead.release();
        await aHasRead.gate;
      }
      await bumpConfidence(client, p.id, Math.min(0.99, seen + 0.02));
    });

    const [statsA, statsB] = (await Promise.all([txnA, txnB])).map((r) => r.stats);
    const retries = statsA.retries + statsB.retries;

    assert.ok(
      retries >= 1,
      `expected SERIALIZABLE to abort one side of the cycle with 40001, got ${retries} retries ` +
        `(A: ${statsA.attempts} attempts, B: ${statsB.attempts} attempts)`,
    );
    // Both still committed — that is the point of the retry loop.
    assert.equal(statsA.attempts, statsA.retries + 1);
    assert.equal(statsB.attempts, statsB.retries + 1);
    console.log(`    · read-write cycle → ${retries} abort(s) replayed to success by withRetry`);
  });

  it("keeps exactly one believed fact when a swarm races to overwrite it", async () => {
    const topic = uniqueTopic("cascade");
    topics.push(topic);

    await seedEstablishedFact({
      topic,
      agentId: "baseline-agent",
      fact: "The checkout service p99 latency is 120 ms in the us-east-1 region.",
    });

    // Each rival asserts an incompatible latency for the same measurement and
    // carries a recency marker, so every one of them adjudicates to SUPERSEDE
    // against whatever is believed at the moment it runs.
    const rivals = [130, 145, 160, 175, 190, 205].map((ms, i) => ({
      agentId: `rival-${i}`,
      fact: `Updated: the checkout service p99 latency is ${ms} ms in the us-east-1 region.`,
      topic,
      confidence: 0.9,
    }));

    const settled = await Promise.allSettled(rivals.map((r) => processMemorySubmission(r)));

    const failures = settled.filter((s) => s.status === "rejected");
    assert.equal(
      failures.length,
      0,
      `every submission must resolve to a verdict; ${failures.length} threw: ` +
        failures.map((f) => (f as PromiseRejectedResult).reason?.message).join(" | "),
    );

    const results = settled.map((s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof processMemorySubmission>>>).value);
    const retries = results.reduce((sum, r) => sum + r.serializationRetries, 0);
    const verdicts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.verdict] = (acc[r.verdict] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`    · ${rivals.length} rivals → verdicts ${JSON.stringify(verdicts)}, ${retries} serialization retries replayed`);

    // The invariant. Two ACTIVE rows here would mean the fleet believes two
    // incompatible latencies at once — precisely what the gate exists to prevent.
    const rows = await memoriesInTopic(topic);
    const active = rows.filter((r) => r.status === "ACTIVE");
    assert.equal(
      active.length,
      1,
      `exactly one belief may remain active, found ${active.length}: ${active.map((a) => a.fact_statement).join(" || ")}`,
    );

    // A superseded row must be stamped; an active one must not be.
    for (const row of rows) {
      if (row.status === "SUPERSEDED") {
        assert.ok(row.superseded_at !== null, `${row.id} is SUPERSEDED but has no superseded_at`);
      } else {
        assert.equal(row.superseded_at, null, `${row.id} is ${row.status} but carries superseded_at`);
      }
    }

    // Substrate and audit trail are written in one transaction, so they cannot
    // disagree about what happened.
    const audit = await auditRowsForTopic(topic);
    assert.equal(audit.length, rivals.length, "every submission must leave exactly one audit row");

    const memoryIds = new Set(rows.map((r) => r.id));
    for (const entry of audit) {
      if (entry.resulting_memory_id) {
        assert.ok(
          memoryIds.has(entry.resulting_memory_id),
          `audit ${entry.id} points at a memory row that does not exist`,
        );
      }
    }
  });
});

/** A cheap unit vector of the configured width — content is irrelevant here. */
function vectorLiteral(): string {
  const dim = Number(process.env.EMBEDDING_DIM ?? 1024);
  const vec = new Array<number>(dim).fill(0);
  vec[0] = 1;
  return `[${vec.join(",")}]`;
}
