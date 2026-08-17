/**
 * Agent-fleet simulator.
 *
 * Spawns N autonomous agents that submit to the same topic *simultaneously*.
 * Their payloads are deliberately adversarial: one restates an established
 * belief, one contradicts it outright, one contradicts it with a legitimate
 * later timestamp, one hallucinates a number, and one contributes something
 * genuinely new. Every agent believes it is right.
 *
 * Two properties get demonstrated at once:
 *   • the Write-Gate rejects contradictions and drift while admitting real news;
 *   • CockroachDB serialises the concurrent writes correctly — the losers of a
 *     race are aborted with 40001 and replayed, so no two agents can both
 *     supersede the same belief.
 */

import { query } from "./db";
import { processMemorySubmission } from "./writeGate";
import type { GateResult, SwarmEvent } from "./types";

export type SwarmIntent = "anchor" | "duplicate" | "contradiction" | "supersession" | "novel" | "drift";

export interface SwarmAgentPlan {
  agentId: string;
  role: string;
  intent: SwarmIntent;
  fact: string;
  confidence: number;
  /** What the operator should expect to see, shown next to the live verdict. */
  expectation: string;
}

export interface SwarmScenario {
  id: string;
  title: string;
  topic: string;
  /** Established belief written (or merged) before the fleet fires. */
  anchor: SwarmAgentPlan;
  agents: SwarmAgentPlan[];
}

const CURRENT_YEAR = new Date().getFullYear();

export const SCENARIOS: SwarmScenario[] = [
  {
    id: "revenue",
    title: "Quarterly revenue reconciliation",
    topic: "revenue-q3",
    anchor: {
      agentId: "ledger-beta",
      role: "Finance reconciliation agent",
      intent: "anchor",
      fact: `Q3 ${CURRENT_YEAR} net revenue for the Atlas product line was 48.2 million USD, confirmed against the audited general ledger.`,
      confidence: 0.94,
      expectation: "Establishes the baseline belief for this topic.",
    },
    agents: [
      {
        agentId: "recon-alpha",
        role: "Market intelligence agent",
        intent: "contradiction",
        fact: `Q3 ${CURRENT_YEAR} net revenue for the Atlas product line was 61.7 million USD based on channel-partner estimates.`,
        confidence: 0.71,
        expectation: "Contradicts the audited figure with no correction marker — expect CONFLICT_REJECTED.",
      },
      {
        agentId: "ledger-beta",
        role: "Finance reconciliation agent",
        intent: "duplicate",
        fact: `Net revenue in Q3 ${CURRENT_YEAR} for Atlas came to 48.2 million USD per the audited general ledger.`,
        confidence: 0.9,
        expectation: "Restates the anchor in different words — expect MERGED, no duplicate row.",
      },
      {
        agentId: "scribe-delta",
        role: "Filings and disclosure agent",
        intent: "supersession",
        fact: `Corrected: Q3 ${CURRENT_YEAR} net revenue for the Atlas product line was restated to 47.6 million USD following the post-close revenue-recognition adjustment filed in Q4 ${CURRENT_YEAR}.`,
        confidence: 0.96,
        expectation: "Contradicts the anchor but carries an explicit correction — expect SUPERSEDED.",
      },
      {
        agentId: "ops-gamma",
        role: "Operations telemetry agent",
        intent: "novel",
        fact: `Atlas gross margin in Q3 ${CURRENT_YEAR} was 63 percent, up from 59 percent the prior quarter.`,
        confidence: 0.88,
        expectation: "New, compatible information — expect ALLOWED.",
      },
      {
        agentId: "probe-epsilon",
        role: "Unsupervised research agent (drifting)",
        intent: "drift",
        fact: `Q3 ${CURRENT_YEAR} net revenue for the Atlas product line was approximately 480 million USD across all regions.`,
        confidence: 0.31,
        expectation: "Order-of-magnitude hallucination below the confidence floor — expect CONFLICT_REJECTED.",
      },
    ],
  },
  {
    id: "infra",
    title: "Production topology drift",
    topic: "infra-topology",
    anchor: {
      agentId: "ops-gamma",
      role: "Operations telemetry agent",
      intent: "anchor",
      fact: "The Atlas primary CockroachDB cluster runs 9 nodes across 3 regions with the leaseholder preference pinned to us-east-1.",
      confidence: 0.95,
      expectation: "Establishes the baseline belief for this topic.",
    },
    agents: [
      {
        agentId: "recon-alpha",
        role: "Market intelligence agent",
        intent: "contradiction",
        fact: "The Atlas primary CockroachDB cluster runs 9 nodes across 3 regions with the leaseholder preference pinned to eu-west-1.",
        confidence: 0.66,
        expectation: "Same claim, swapped region — expect CONFLICT_REJECTED.",
      },
      {
        agentId: "ops-gamma",
        role: "Operations telemetry agent",
        intent: "supersession",
        fact: "Updated after the migration cutover: the Atlas primary CockroachDB cluster now runs 15 nodes across 3 regions with the leaseholder preference pinned to us-east-1.",
        confidence: 0.97,
        expectation: "Node count changed, explicit cutover marker — expect SUPERSEDED.",
      },
      {
        agentId: "scribe-delta",
        role: "Filings and disclosure agent",
        intent: "novel",
        fact: "The Atlas cluster enforces a 30-day GC TTL and streams changefeeds into the audit lake via Kafka.",
        confidence: 0.86,
        expectation: "Adjacent but non-conflicting — expect ALLOWED.",
      },
      {
        agentId: "ledger-beta",
        role: "Finance reconciliation agent",
        intent: "duplicate",
        fact: "Atlas primary CockroachDB cluster: 9 nodes, 3 regions, leaseholder preference us-east-1.",
        confidence: 0.83,
        expectation: "Paraphrase of the anchor — expect MERGED.",
      },
      {
        agentId: "probe-epsilon",
        role: "Unsupervised research agent (drifting)",
        intent: "drift",
        fact: "The Atlas primary CockroachDB cluster does not replicate across regions and has no leaseholder preference configured.",
        confidence: 0.44,
        expectation: "Negates the established topology — expect CONFLICT_REJECTED.",
      },
    ],
  },
  {
    id: "compliance",
    title: "Compliance posture contradiction",
    topic: "compliance-status",
    anchor: {
      agentId: "scribe-delta",
      role: "Filings and disclosure agent",
      intent: "anchor",
      fact: `The Atlas platform holds an active SOC 2 Type II attestation covering the period ending 31 March ${CURRENT_YEAR}, issued by the external auditor.`,
      confidence: 0.97,
      expectation: "Establishes the baseline belief for this topic.",
    },
    agents: [
      {
        agentId: "probe-epsilon",
        role: "Unsupervised research agent (drifting)",
        intent: "contradiction",
        fact: `The Atlas platform does not hold a SOC 2 Type II attestation for the period ending 31 March ${CURRENT_YEAR}.`,
        confidence: 0.52,
        expectation: "Direct negation of an audited claim — expect CONFLICT_REJECTED.",
      },
      {
        agentId: "scribe-delta",
        role: "Filings and disclosure agent",
        intent: "supersession",
        fact: `As of the latest surveillance audit, the Atlas platform's SOC 2 Type II attestation was extended to cover the period ending 30 September ${CURRENT_YEAR}.`,
        confidence: 0.95,
        expectation: "Legitimate lifecycle update — expect SUPERSEDED.",
      },
      {
        agentId: "ops-gamma",
        role: "Operations telemetry agent",
        intent: "novel",
        fact: "All Atlas customer data at rest is encrypted with AES-256 using customer-managed keys held in AWS KMS.",
        confidence: 0.91,
        expectation: "New control statement — expect ALLOWED.",
      },
      {
        agentId: "recon-alpha",
        role: "Market intelligence agent",
        intent: "duplicate",
        fact: `Atlas currently maintains an active SOC 2 Type II attestation through 31 March ${CURRENT_YEAR}.`,
        confidence: 0.8,
        expectation: "Restatement of the anchor — expect MERGED.",
      },
      {
        agentId: "ledger-beta",
        role: "Finance reconciliation agent",
        intent: "novel",
        fact: "Annual external audit spend for the Atlas compliance program is budgeted at 340000 USD.",
        confidence: 0.87,
        expectation: "Unrelated financial fact in the same topic — expect ALLOWED.",
      },
    ],
  },
];

export function getScenario(id?: string): SwarmScenario {
  if (id) {
    const found = SCENARIOS.find((s) => s.id === id);
    if (found) return found;
  }
  return SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
}

async function topicHasBelief(topic: string): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::INT AS n FROM agent_memories
     WHERE topic = $1 AND status = 'ACTIVE' AND superseded_at IS NULL`,
    [topic],
  );
  return (rows[0]?.n ?? 0) > 0;
}

async function runAgent(plan: SwarmAgentPlan, topic: string): Promise<GateResult> {
  return processMemorySubmission({
    agentId: plan.agentId,
    fact: plan.fact,
    topic,
    confidence: plan.confidence,
    rawDocument: `[${plan.role}] intent=${plan.intent}\n\n${plan.fact}`,
  });
}

/**
 * Streams the swarm run as it happens. The anchor is awaited first so the fleet
 * has something to contradict; the remaining agents are launched with
 * `Promise.all` and land in whatever order the gate finishes them.
 */
export async function* streamSwarm(options: {
  scenarioId?: string;
  agentCount?: number;
}): AsyncGenerator<SwarmEvent> {
  const scenario = getScenario(options.scenarioId);
  const agents = scenario.agents.slice(0, Math.max(1, Math.min(options.agentCount ?? 5, scenario.agents.length)));
  const startedAt = Date.now();

  yield {
    type: "start",
    total: agents.length,
    topic: scenario.topic,
    message: `${scenario.title} — ${agents.length} agents targeting topic "${scenario.topic}"`,
  };

  // Establish the belief the fleet will collide with, unless one already exists.
  if (!(await topicHasBelief(scenario.topic))) {
    try {
      const anchorResult = await runAgent(scenario.anchor, scenario.topic);
      yield {
        type: "result",
        index: 0,
        total: agents.length,
        agentId: scenario.anchor.agentId,
        fact: scenario.anchor.fact,
        topic: scenario.topic,
        intent: "anchor",
        result: anchorResult,
      };
    } catch (err) {
      yield {
        type: "error",
        agentId: scenario.anchor.agentId,
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }
  }

  // All agents fire at once — this is the concurrency the gate has to survive.
  const inflight = agents.map(async (plan, index) => {
    try {
      const result = await runAgent(plan, scenario.topic);
      return { plan, index, result } as const;
    } catch (err) {
      return {
        plan,
        index,
        error: err instanceof Error ? err.message : String(err),
      } as const;
    }
  });

  for (const settled of await settleInOrderOfCompletion(inflight)) {
    if ("error" in settled) {
      yield {
        type: "error",
        index: settled.index + 1,
        total: agents.length,
        agentId: settled.plan.agentId,
        fact: settled.plan.fact,
        intent: settled.plan.intent,
        message: settled.error,
      };
    } else {
      yield {
        type: "result",
        index: settled.index + 1,
        total: agents.length,
        agentId: settled.plan.agentId,
        fact: settled.plan.fact,
        topic: scenario.topic,
        intent: settled.plan.intent,
        result: settled.result,
      };
    }
  }

  yield {
    type: "done",
    total: agents.length,
    topic: scenario.topic,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Yields settled promises in completion order rather than array order. */
async function settleInOrderOfCompletion<T>(promises: Promise<T>[]): Promise<T[]> {
  const pending = new Map<number, Promise<{ key: number; value: T }>>();
  promises.forEach((p, i) => pending.set(i, p.then((value) => ({ key: i, value }))));

  const ordered: T[] = [];
  while (pending.size > 0) {
    const { key, value } = await Promise.race(pending.values());
    pending.delete(key);
    ordered.push(value);
  }
  return ordered;
}

/** Non-streaming variant used by the Lambda handler and plain JSON clients. */
export async function runSwarm(options: { scenarioId?: string; agentCount?: number }) {
  const events: SwarmEvent[] = [];
  for await (const event of streamSwarm(options)) events.push(event);
  return events;
}
