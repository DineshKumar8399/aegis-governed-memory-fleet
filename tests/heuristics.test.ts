/**
 * Unit tests for the offline gatekeeper. No database, no network.
 *
 * These lock down the rules that decide whether two statements disagree — the
 * part of Aegis that ran wrong in subtle, silent ways during development
 * (trailing punctuation breaking token matches, unit-less numbers colliding
 * across measurements, duplicates being checked before contradictions).
 */

import "./setup";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  contentTokens,
  detectContradiction,
  heuristicAdjudicate,
  heuristicEmbed,
  isRestatement,
  tokenize,
} from "../lib/heuristics";
import type { ScoredMemory } from "../lib/types";

/** Builds the shape `heuristicAdjudicate` expects from a bare fact string. */
function neighbour(fact: string, overrides: Partial<ScoredMemory> = {}): ScoredMemory {
  return {
    id: overrides.id ?? "00000000-0000-0000-0000-000000000001",
    agent_id: overrides.agent_id ?? "agent-alpha",
    fact_statement: fact,
    topic: overrides.topic ?? "test",
    valid_from: "2026-01-01T00:00:00.000Z",
    superseded_at: overrides.superseded_at ?? null,
    confidence_score: overrides.confidence_score ?? 0.9,
    source_s3_uri: "test://n",
    status: overrides.status ?? "ACTIVE",
    distance: overrides.distance ?? 0.2,
    similarity: 1 - (overrides.distance ?? 0.2) / 2,
  };
}

describe("tokenize", () => {
  it("strips edge punctuation but keeps meaning-bearing interior characters", () => {
    // A sentence-final "2026." must be the same token as "2026" elsewhere,
    // otherwise a fact never matches itself and duplicate detection dies.
    assert.deepEqual(tokenize("Revenue hit 48.2 in 2026."), ["revenue", "hit", "48.2", "in", "2026"]);
    assert.deepEqual(tokenize("Region us-east-1, uptime 99.95%"), [
      "region",
      "us-east-1",
      "uptime",
      "99.95%",
    ]);
  });

  it("drops stopwords and single characters from content tokens", () => {
    assert.deepEqual(contentTokens("the cluster is in a region"), ["cluster", "region"]);
  });
});

describe("heuristicEmbed", () => {
  it("returns an L2-normalised vector of the requested width", () => {
    const vec = heuristicEmbed("checkout latency is 120 ms", 1024);
    assert.equal(vec.length, 1024);
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, `expected unit norm, got ${norm}`);
  });

  it("never emits a zero vector for degenerate input", () => {
    // A zero vector has no direction, so cosine distance against it is undefined
    // and the VECTOR column would poison every later comparison.
    const vec = heuristicEmbed("the and of", 1024);
    assert.ok(vec.some((v) => v !== 0));
  });

  it("places related text nearer than unrelated text", () => {
    const cosine = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    const base = heuristicEmbed("checkout service p99 latency is 120 ms", 1024);
    const related = heuristicEmbed("checkout service p99 latency is 180 ms", 1024);
    const unrelated = heuristicEmbed("the marketing team hired four designers", 1024);
    assert.ok(
      cosine(base, related) > cosine(base, unrelated),
      "a lexically related fact must sit closer than an unrelated one",
    );
  });
});

describe("detectContradiction", () => {
  it("flags incompatible values for the same measurement", () => {
    const signal = detectContradiction(
      "The incident caused 42 minutes of downtime.",
      "The incident caused 6 minutes of downtime.",
    );
    assert.equal(signal.contradicts, true);
  });

  it("does not flag the same figure carried by different units", () => {
    // "3 replicas" and "3 regions" share a number and nothing else.
    const signal = detectContradiction(
      "The cluster runs 3 replicas per range.",
      "The cluster runs 3 regions per deployment.",
    );
    assert.equal(signal.contradicts, false);
  });

  it("flags a polarity flip", () => {
    const signal = detectContradiction(
      "Multi-region failover is not enabled for the payments cluster.",
      "Multi-region failover is enabled for the payments cluster.",
    );
    assert.equal(signal.contradicts, true);
  });

  it("ignores statements about different subjects", () => {
    const signal = detectContradiction(
      "The billing service p99 latency is 300 ms.",
      "The marketing site had 12000 visitors.",
    );
    assert.equal(signal.contradicts, false);
    assert.match(signal.evidence, /subjects do not overlap/);
  });

  it("treats an explicit correction as newer", () => {
    const signal = detectContradiction(
      "Updated: the checkout p99 latency is 180 ms.",
      "The checkout p99 latency is 120 ms.",
    );
    assert.equal(signal.contradicts, true);
    assert.equal(signal.looksNewer, true);
  });
});

describe("isRestatement", () => {
  it("recognises a paraphrase with identical figures", () => {
    assert.equal(
      isRestatement(
        "Q3 2026 revenue was 48.2 million for the platform division.",
        "The platform division Q3 2026 revenue was 48.2 million.",
      ),
      true,
    );
  });

  it("rejects a paraphrase whose figures differ", () => {
    assert.equal(
      isRestatement(
        "Q3 2026 revenue was 51.7 million for the platform division.",
        "The platform division Q3 2026 revenue was 48.2 million.",
      ),
      false,
    );
  });
});

describe("heuristicAdjudicate", () => {
  it("allows a fact with no established neighbours", () => {
    assert.equal(heuristicAdjudicate("Anything at all.", []).decision, "ALLOWED");
  });

  it("prefers CONFLICT over MERGE for near-identical but incompatible facts", () => {
    // The ordering bug that shipped once: these two sit close enough in vector
    // space to look like duplicates, so a merge-first gate waved the
    // contradiction straight through.
    const decision = heuristicAdjudicate(
      "The incident caused 42 minutes of downtime.",
      [neighbour("The incident caused 6 minutes of downtime.", { distance: 0.02 })],
      0.06,
    );
    assert.equal(decision.decision, "CONFLICT");
  });

  it("supersedes when the contradiction carries a correction marker", () => {
    const decision = heuristicAdjudicate("Updated: the checkout p99 latency is 180 ms.", [
      neighbour("The checkout p99 latency is 120 ms.", { distance: 0.05 }),
    ]);
    assert.equal(decision.decision, "SUPERSEDE");
    assert.equal(decision.conflictingFactId, "00000000-0000-0000-0000-000000000001");
  });

  it("merges an exact restatement", () => {
    const decision = heuristicAdjudicate(
      "The platform division Q3 2026 revenue was 48.2 million.",
      [neighbour("Q3 2026 revenue was 48.2 million for the platform division.", { distance: 0.03 })],
      0.06,
    );
    assert.equal(decision.decision, "MERGE");
  });

  it("ignores neighbours that are no longer believed", () => {
    const decision = heuristicAdjudicate(
      "The incident caused 42 minutes of downtime.",
      [
        neighbour("The incident caused 6 minutes of downtime.", {
          distance: 0.02,
          status: "SUPERSEDED",
          superseded_at: "2026-02-01T00:00:00.000Z",
        }),
      ],
      0.06,
    );
    assert.equal(decision.decision, "ALLOWED");
  });
});
