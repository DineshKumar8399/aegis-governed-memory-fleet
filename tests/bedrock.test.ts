/**
 * Dual-mode ingestion: Bedrock when reachable, deterministic local gatekeeper
 * when not. No database and no AWS credentials required.
 *
 * On a machine with no credentials the live path fails immediately, which is
 * exactly the degradation these tests are about. They assert the *shape* of the
 * fallback — that it produces a usable vector of the right width, labels itself
 * honestly, and never claims to be live — rather than asserting which branch ran.
 */

import "./setup";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { adjudicate, bedrockAvailability, embedText, resetBedrockFallback } from "../lib/bedrock";
import { env } from "../lib/env";

describe("dual-mode embedding", () => {
  it("always returns a vector of the configured width, whichever path ran", async () => {
    const result = await embedText("the checkout service p99 latency is 120 ms");
    assert.equal(result.vector.length, env.embeddingDim);
    assert.ok(["bedrock", "local"].includes(result.source));
    assert.ok(result.modelId.length > 0, "every embedding must name the model that produced it");
  });

  it("is deterministic in fallback, so distances are reproducible across runs", async () => {
    const a = await embedText("identical input text");
    const b = await embedText("identical input text");
    if (a.source !== "local") return; // live Titan is not required to be bit-identical
    assert.deepEqual(a.vector, b.vector);
  });

  it("produces a finite, non-zero vector", async () => {
    // A zero or NaN-bearing vector would make `<=>` meaningless and silently
    // poison every neighbour comparison downstream.
    const { vector } = await embedText("cluster failover drill");
    assert.ok(vector.every(Number.isFinite), "vector contains NaN or Infinity");
    assert.ok(vector.some((v) => v !== 0), "vector is all zeroes");
  });
});

describe("dual-mode adjudication", () => {
  it("returns a well-formed verdict with an evaluator label", async () => {
    const decision = await adjudicate({
      fact: "The checkout service p99 latency is 900 ms.",
      topic: "latency",
      agentId: "test-agent",
      neighbours: [],
    });
    assert.ok(["ALLOWED", "CONFLICT", "SUPERSEDE", "MERGE"].includes(decision.decision));
    assert.ok(["bedrock", "heuristic", "fast-path"].includes(decision.evaluator));
    assert.ok(decision.reason.length > 0, "a verdict must always carry its reasoning");
  });
});

describe("availability reporting", () => {
  it("never reports `live` before a call has actually proved it", () => {
    // The honesty guarantee the status badge depends on: configuration alone
    // must read as `unverified`, not `live`.
    resetBedrockFallback();
    const status = bedrockAvailability();
    assert.notEqual(status.state, "live");
    assert.equal(status.live, false);
    assert.equal(status.reason, "no Bedrock call made yet");
  });

  it("reports a bounded retry window rather than a permanent outage", async () => {
    resetBedrockFallback();
    // Force the live path to be attempted and fail (no credentials here). If the
    // environment *does* have working credentials this call succeeds, and the
    // self-healing assertion below is vacuous rather than wrong.
    await embedText("probe to trip the fallback latch");

    const status = bedrockAvailability();
    if (status.state !== "fallback") return; // credentials resolved; nothing to assert

    assert.match(
      status.reason ?? "",
      /retrying in \d+s/,
      "fallback must advertise when it will retry, not present as terminal",
    );
    assert.equal(status.live, false);
  });
});
