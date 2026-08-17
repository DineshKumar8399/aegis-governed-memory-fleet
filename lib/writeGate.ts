/**
 * The Adversarial Write-Gate.
 *
 * Nothing reaches the shared memory substrate without passing through here.
 * One submission takes six steps:
 *
 *   1. Archive the raw source document to S3            → provenance
 *   2. Embed the candidate fact (Titan V2)              → 1024-d vector
 *   3. Confidence fast-path                             → quarantine junk cheaply
 *   4. Retrieve nearest established facts (CockroachDB) → what could it contradict?
 *   5. Adjudicate (Claude on Bedrock, forced tool call) → ALLOWED / CONFLICT / SUPERSEDE / MERGE
 *   6. Apply the verdict in ONE serializable transaction
 *
 * Step 6 is the part that matters under concurrency. The Bedrock call in step 5
 * takes seconds, so it deliberately runs *outside* the transaction — holding row
 * locks across a network call to a model endpoint would serialise the whole
 * fleet. Instead the gate adjudicates optimistically, then opens a short
 * transaction that re-reads the world `FOR UPDATE` and checks that the verdict
 * still describes it.
 *
 * If a competing agent changed the belief we adjudicated against, the verdict is
 * **stale**, and a stale verdict is never applied. The gate loops back to step 4
 * and re-adjudicates against the state that actually exists now. Only when no
 * contested belief remains at commit time is the candidate admitted. Downgrading
 * a stale CONFLICT straight to ALLOWED would let a contradiction in through the
 * exact race the gate exists to close.
 *
 * CockroachDB aborts the loser of any genuine write-write race with SQLSTATE
 * 40001, and `withRetry` replays it. The memory row and its audit row are
 * written in the same transaction, so the substrate and the audit trail can
 * never disagree about what happened.
 */

import { withRetry, type PoolClient } from "./db";
import { env, gateThresholds } from "./env";
import { adjudicate, embedText } from "./bedrock";
import { archiveProvenance } from "./s3";
import { findNearestMemories, insertMemory, supersedeMemory } from "./vector";
import type {
  AgentMemory,
  GateAdjudication,
  GateResult,
  GateVerdict,
  LlmDecision,
  MemorySubmission,
  ScoredMemory,
} from "./types";

const MAX_FACT_LENGTH = 4000;
/** Adjudication rounds before the gate stops chasing a moving world. */
const MAX_ADJUDICATION_ROUNDS = 3;

export class SubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionError";
  }
}

function normaliseSubmission(input: MemorySubmission) {
  const agentId = input.agentId?.trim();
  const fact = input.fact?.trim();
  const topic = input.topic?.trim().toLowerCase();

  if (!agentId) throw new SubmissionError("`agentId` is required.");
  if (agentId.length > 64) throw new SubmissionError("`agentId` must be 64 characters or fewer.");
  if (!fact) throw new SubmissionError("`fact` is required.");
  if (fact.length > MAX_FACT_LENGTH) {
    throw new SubmissionError(`\`fact\` must be ${MAX_FACT_LENGTH} characters or fewer.`);
  }
  if (!topic) throw new SubmissionError("`topic` is required.");
  if (topic.length > 64) throw new SubmissionError("`topic` must be 64 characters or fewer.");

  const confidence =
    typeof input.confidence === "number" && Number.isFinite(input.confidence)
      ? Math.max(0, Math.min(1, input.confidence))
      : 0.75;

  return { agentId, fact, topic, confidence, rawDocument: input.rawDocument };
}

const DECISION_TO_VERDICT: Record<LlmDecision, GateVerdict> = {
  ALLOWED: "ALLOWED",
  CONFLICT: "CONFLICT_REJECTED",
  SUPERSEDE: "SUPERSEDED",
  MERGE: "MERGED",
};

interface AuditInsert {
  incomingFact: string;
  conflictingMemoryId: string | null;
  verdict: GateVerdict;
  reasoning: string;
  agentId: string;
  topic: string;
  resultingMemoryId: string | null;
  nearestDistance: number | null;
  latencyMs: number;
  modelId: string | null;
  evaluator: string;
}

async function writeAuditLog(client: PoolClient, entry: AuditInsert): Promise<string> {
  const result = await client.query(
    `INSERT INTO audit_gate_logs
       (incoming_fact, conflicting_memory_id, gatekeeper_verdict, reasoning,
        agent_id, topic, resulting_memory_id, nearest_distance, latency_ms, model_id, evaluator)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      entry.incomingFact,
      entry.conflictingMemoryId,
      entry.verdict,
      entry.reasoning,
      entry.agentId,
      entry.topic,
      entry.resultingMemoryId,
      entry.nearestDistance,
      entry.latencyMs,
      entry.modelId,
      entry.evaluator,
    ] as never[],
  );
  return (result.rows[0] as { id: string }).id;
}

/** Re-reads one memory under a row lock so a verdict is applied to live state. */
async function lockMemory(client: PoolClient, id: string): Promise<AgentMemory | null> {
  const result = await client.query(
    `SELECT id, agent_id, fact_statement, topic, valid_from, superseded_at,
            confidence_score, source_s3_uri, status
     FROM agent_memories WHERE id = $1 FOR UPDATE`,
    [id] as never[],
  );
  return (result.rows[0] as AgentMemory) ?? null;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function processMemorySubmission(input: MemorySubmission): Promise<GateResult> {
  const startedAt = Date.now();
  const { agentId, fact, topic, confidence, rawDocument } = normaliseSubmission(input);

  // ── 1. Provenance ──────────────────────────────────────────────────────────
  const provenance = input.sourceUri
    ? { uri: input.sourceUri }
    : await archiveProvenance({ agentId, topic, fact, rawDocument, confidence });
  const sourceUri = provenance.uri;

  // ── 2. Embedding ───────────────────────────────────────────────────────────
  const embedding = await embedText(fact);
  // Distances only mean something relative to the space they were measured in,
  // so the cutoffs come from whichever embedder actually produced this vector.
  const thresholds = gateThresholds(embedding.source);

  const submission = { agentId, fact, topic, confidence, sourceUri };

  // ── 3. Confidence fast-path ────────────────────────────────────────────────
  // A fact the author does not believe should never cost a model call.
  if (confidence < env.minConfidence) {
    const applied = await applyVerdict({
      verdict: "CONFLICT_REJECTED",
      adjudication: {
        decision: "CONFLICT",
        reason:
          `Self-reported confidence ${confidence.toFixed(2)} is below the fleet floor of ` +
          `${env.minConfidence.toFixed(2)}. Quarantined before adjudication.`,
        conflictingFactId: null,
        evaluator: "fast-path",
        modelId: null,
        latencyMs: 0,
      },
      embedding: embedding.vector,
      neighbours: [],
      contenders: [],
      submission,
      thresholds,
      allowStaleRecheck: false,
    });
    // No contenders were consulted, so this branch cannot come back stale.
    if (applied.kind !== "applied") {
      throw new Error("Confidence fast-path returned a stale verdict — unreachable.");
    }
    return finalise(applied, [], startedAt, applied.retries);
  }

  // ── 4–6. Retrieve, adjudicate, apply — re-running if the world moves. ──────
  let neighbours = await findNearestMemories(embedding.vector, { topic, limit: env.topK });
  let serializationRetries = 0;

  for (let round = 1; ; round++) {
    const lastRound = round >= MAX_ADJUDICATION_ROUNDS;
    const contenders = neighbours.filter((n) => n.distance <= thresholds.adjudicate);

    const adjudication: GateAdjudication =
      contenders.length === 0
        ? {
            decision: "ALLOWED",
            reason:
              neighbours.length === 0
                ? "First fact recorded for this topic; no established belief to contradict."
                : `Nearest established fact sits at cosine distance ${neighbours[0].distance.toFixed(4)}, ` +
                  `beyond the ${thresholds.adjudicate} adjudication threshold for the ${embedding.source} ` +
                  `embedder. Accepted as novel.`,
            conflictingFactId: null,
            evaluator: "fast-path",
            modelId: null,
            latencyMs: 0,
          }
        : await adjudicate({
            fact,
            topic,
            agentId,
            neighbours: contenders,
            mergeThreshold: thresholds.merge,
          });

    const applied = await applyVerdict({
      verdict: DECISION_TO_VERDICT[adjudication.decision],
      adjudication,
      embedding: embedding.vector,
      neighbours,
      contenders,
      submission,
      thresholds,
      // On the last round, resolve staleness by re-pointing rather than looping
      // forever against a world that keeps changing underneath us.
      allowStaleRecheck: !lastRound,
      round,
    });

    serializationRetries += applied.retries;

    if (applied.kind === "applied") {
      return finalise(applied, neighbours, startedAt, serializationRetries);
    }

    // Stale: a competing writer changed the belief we adjudicated against.
    // Re-adjudicate against the state that exists now.
    neighbours = applied.freshNeighbours;
  }
}

function finalise(
  applied: AppliedOutcome & { retries: number },
  neighbours: ScoredMemory[],
  startedAt: number,
  serializationRetries: number,
): GateResult {
  return {
    verdict: applied.verdict,
    reasoning: applied.reasoning,
    evaluator: applied.evaluator,
    modelId: applied.modelId,
    memory: applied.memory,
    conflictingMemory: applied.conflicting,
    neighbours,
    auditLogId: applied.auditLogId,
    latencyMs: applied.latencyMs,
    totalMs: Date.now() - startedAt,
    serializationRetries,
    submission: applied.submission,
  };
}

// ── Application ──────────────────────────────────────────────────────────────

interface AppliedOutcome {
  kind: "applied";
  verdict: GateVerdict;
  reasoning: string;
  evaluator: GateAdjudication["evaluator"];
  modelId: string | null;
  memory: AgentMemory | null;
  conflicting: ScoredMemory | null;
  auditLogId: string;
  latencyMs: number;
  submission: GateResult["submission"];
}

interface StaleOutcome {
  kind: "stale";
  freshNeighbours: ScoredMemory[];
}

/** What the transaction body returns, before retry accounting is attached. */
type TxOutcome = AppliedOutcome | StaleOutcome;

type ApplyOutcome = TxOutcome & { retries: number };

async function applyVerdict(args: {
  verdict: GateVerdict;
  adjudication: GateAdjudication;
  embedding: number[];
  neighbours: ScoredMemory[];
  contenders: ScoredMemory[];
  submission: GateResult["submission"];
  thresholds: { adjudicate: number; merge: number };
  allowStaleRecheck: boolean;
  round?: number;
}): Promise<ApplyOutcome> {
  const { adjudication, embedding, neighbours, contenders, submission, thresholds } = args;
  const nearest = neighbours[0] ?? null;

  // Resolve which established fact the verdict is about. The model may return an
  // id; if it does not (or returns one we never showed it), fall back to the
  // nearest contender.
  const referenced =
    (adjudication.conflictingFactId
      ? contenders.find((c) => c.id === adjudication.conflictingFactId)
      : undefined) ?? (args.verdict === "ALLOWED" ? null : (contenders[0] ?? null));

  const { value, stats } = await withRetry(
    async (client): Promise<TxOutcome> => {
      let verdict = args.verdict;
      let reasoning = adjudication.reason;
      let conflicting: ScoredMemory | null = referenced ?? null;

      // ── Commit-time re-validation ──
      if (conflicting) {
        const live = await lockMemory(client, conflicting.id);
        const stillBelieved =
          live !== null && live.status === "ACTIVE" && live.superseded_at === null;

        if (!stillBelieved && verdict !== "ALLOWED") {
          // Re-read the topic under the same transaction to see what is believed
          // *now*. A vanished target does not mean the candidate is safe — the
          // replacement may contradict it just as hard.
          const fresh = await findNearestMemories(embedding, {
            topic: submission.topic,
            limit: env.topK,
            client,
          });
          const stillContested = fresh.filter((n) => n.distance <= thresholds.adjudicate);

          if (stillContested.length > 0) {
            if (args.allowStaleRecheck) {
              // Abandon this verdict and re-adjudicate against `fresh`.
              return { kind: "stale", freshNeighbours: fresh };
            }
            // Out of rounds: keep the verdict, re-point it at what is believed
            // now, and say so rather than silently admitting the claim.
            conflicting = stillContested[0];
            reasoning =
              `${adjudication.reason} [Re-validated at commit time after ${args.round ?? "several"} ` +
              `adjudication rounds: the original target was replaced concurrently, but ` +
              `"${truncate(conflicting.fact_statement)}" remains contested at distance ` +
              `${conflicting.distance.toFixed(4)}, so the verdict stands against it.]`;
          } else {
            // Genuinely nothing left to contradict.
            verdict = "ALLOWED";
            reasoning =
              `${adjudication.reason} [Re-validated at commit time: the referenced fact was ` +
              `${live === null ? "deleted" : live.status.toLowerCase()} by a concurrent writer and no ` +
              `other established belief remains within the adjudication threshold, so the ` +
              `candidate was admitted.]`;
            conflicting = null;
          }
        }
      }

      const audit = (
        resultingMemoryId: string | null,
        finalVerdict: GateVerdict,
        conflictId: string | null,
      ) =>
        writeAuditLog(client, {
          incomingFact: submission.fact,
          conflictingMemoryId: conflictId,
          verdict: finalVerdict,
          reasoning,
          agentId: submission.agentId,
          topic: submission.topic,
          resultingMemoryId,
          nearestDistance: nearest?.distance ?? null,
          latencyMs: adjudication.latencyMs,
          modelId: adjudication.modelId,
          evaluator: adjudication.evaluator,
        });

      const base = {
        kind: "applied" as const,
        evaluator: adjudication.evaluator,
        modelId: adjudication.modelId,
        latencyMs: adjudication.latencyMs,
        submission,
      };

      switch (verdict) {
        case "SUPERSEDED": {
          if (!conflicting) {
            const memory = await insertMemory({ ...submission, embedding, status: "ACTIVE" }, client);
            return {
              ...base,
              verdict: "ALLOWED",
              reasoning,
              memory,
              conflicting: null,
              auditLogId: await audit(memory.id, "ALLOWED", null),
            };
          }
          await supersedeMemory(conflicting.id, client);
          const memory = await insertMemory({ ...submission, embedding, status: "ACTIVE" }, client);
          return {
            ...base,
            verdict,
            reasoning,
            memory,
            conflicting,
            auditLogId: await audit(memory.id, verdict, conflicting.id),
          };
        }

        case "CONFLICT_REJECTED": {
          // The rejected fact is persisted — quarantined, not discarded. Blocked
          // claims are evidence: they show which agents drift and which topics
          // are contested.
          const memory = await insertMemory(
            { ...submission, embedding, status: "QUARANTINED" },
            client,
          );
          return {
            ...base,
            verdict,
            reasoning,
            memory,
            conflicting,
            auditLogId: await audit(memory.id, verdict, conflicting?.id ?? null),
          };
        }

        case "MERGED": {
          // Identical to an existing belief — record the decision, write no row.
          return {
            ...base,
            verdict,
            reasoning,
            memory: null,
            conflicting,
            auditLogId: await audit(conflicting?.id ?? null, verdict, conflicting?.id ?? null),
          };
        }

        default: {
          const memory = await insertMemory({ ...submission, embedding, status: "ACTIVE" }, client);
          return {
            ...base,
            verdict: "ALLOWED",
            reasoning,
            memory,
            conflicting: null,
            auditLogId: await audit(memory.id, "ALLOWED", null),
          };
        }
      }
    },
    {
      onRetry: (attempt) =>
        console.warn(
          `[write-gate] serialization conflict on "${submission.topic}" (attempt ${attempt}) — retrying`,
        ),
    },
  );

  return { ...value, retries: stats.retries };
}

function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
