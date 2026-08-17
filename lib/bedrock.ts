/**
 * Amazon Bedrock client wrapper.
 *
 *  • Embeddings  — Amazon Titan Text Embeddings V2 via `InvokeModelCommand`
 *                  (the Converse API does not cover embedding models).
 *  • Gatekeeper  — Claude via `ConverseCommand` with a forced tool call, so the
 *                  adjudication comes back as schema-validated JSON instead of
 *                  prose we have to parse hopefully.
 *
 * Both paths degrade to a deterministic local implementation when Bedrock is
 * unreachable (`AEGIS_BEDROCK_MODE=auto`), so the whole system — including the
 * swarm demo — runs end-to-end with zero AWS credentials.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  type ContentBlock,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import { env } from "./env";
import type { GateAdjudication, LlmDecision, ScoredMemory } from "./types";
import { heuristicAdjudicate, heuristicEmbed } from "./heuristics";

let client: BedrockRuntimeClient | undefined;
/** Set once a live call fails in `auto` mode, so we stop paying the timeout. */
let liveDisabledReason: string | null = null;
/** Set once a live call has actually succeeded — proof, not configuration. */
let liveConfirmed = false;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({
      region: env.awsRegion,
      maxAttempts: 3,
    });
  }
  return client;
}

/**
 * `state` is deliberately three-valued. Reporting `live` purely because nothing
 * has failed yet would claim Bedrock is working before any call proved it —
 * `unverified` says "configured, not yet exercised" instead.
 */
export type BedrockState = "live" | "unverified" | "fallback" | "mock";

export function bedrockAvailability(): {
  mode: string;
  state: BedrockState;
  live: boolean;
  reason: string | null;
  region: string;
  embeddingModelId: string;
  llmModelId: string;
} {
  const mode = env.bedrockMode;
  const state: BedrockState =
    mode === "mock"
      ? "mock"
      : liveDisabledReason !== null
        ? "fallback"
        : liveConfirmed
          ? "live"
          : "unverified";

  return {
    mode,
    state,
    live: state === "live",
    reason:
      mode === "mock"
        ? "AEGIS_BEDROCK_MODE=mock"
        : (liveDisabledReason ?? (state === "unverified" ? "no Bedrock call made yet" : null)),
    region: env.awsRegion,
    embeddingModelId: env.embeddingModelId,
    llmModelId: env.llmModelId,
  };
}

/** Reset the auto-fallback latch (used by the health endpoint's `?probe=1`). */
export function resetBedrockFallback(): void {
  liveDisabledReason = null;
  liveConfirmed = false;
}

function handleLiveFailure(operation: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (env.bedrockMode === "live") {
    throw new Error(`Bedrock ${operation} failed (AEGIS_BEDROCK_MODE=live): ${message}`);
  }
  if (liveDisabledReason === null) {
    liveDisabledReason = `${operation}: ${message}`;
    console.warn(
      `[bedrock] falling back to the local gatekeeper — ${liveDisabledReason}\n` +
        `[bedrock] set AEGIS_BEDROCK_MODE=live to surface this as an error instead.`,
    );
  }
}

// ── Embeddings ───────────────────────────────────────────────────────────────

export interface EmbeddingResult {
  vector: number[];
  source: "bedrock" | "local";
  modelId: string;
  inputTokens: number | null;
  latencyMs: number;
}

export async function embedText(text: string): Promise<EmbeddingResult> {
  const started = Date.now();
  const dim = env.embeddingDim;

  if (env.bedrockMode !== "mock" && liveDisabledReason === null) {
    try {
      const body = JSON.stringify({
        inputText: text,
        dimensions: dim,
        normalize: true,
      });

      const response = await getClient().send(
        new InvokeModelCommand({
          modelId: env.embeddingModelId,
          contentType: "application/json",
          accept: "application/json",
          body,
        }),
      );

      const decoded = JSON.parse(new TextDecoder().decode(response.body)) as {
        embedding?: number[];
        inputTextTokenCount?: number;
      };

      if (!Array.isArray(decoded.embedding)) {
        throw new Error("Bedrock returned no `embedding` field.");
      }
      if (decoded.embedding.length !== dim) {
        throw new Error(
          `Embedding width mismatch: model returned ${decoded.embedding.length} dimensions but ` +
            `EMBEDDING_DIM is ${dim}. Update EMBEDDING_DIM and re-run \`npm run db:migrate\`.`,
        );
      }

      liveConfirmed = true;
      return {
        vector: decoded.embedding,
        source: "bedrock",
        modelId: env.embeddingModelId,
        inputTokens: decoded.inputTextTokenCount ?? null,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      handleLiveFailure("embedding", err);
    }
  }

  return {
    vector: heuristicEmbed(text, dim),
    source: "local",
    modelId: "aegis-local-hashing-embedder",
    inputTokens: null,
    latencyMs: Date.now() - started,
  };
}

// ── Gatekeeper adjudication ──────────────────────────────────────────────────

const VERDICT_TOOL_NAME = "record_gate_verdict";

const verdictTool: Tool = {
  toolSpec: {
    name: VERDICT_TOOL_NAME,
    description:
      "Record the adjudication for a candidate fact against the established knowledge base. " +
      "You must call this tool exactly once.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          verdict: {
            type: "string",
            enum: ["ALLOWED", "CONFLICT", "SUPERSEDE", "MERGE"],
            description:
              "ALLOWED: novel, compatible with every established fact. " +
              "CONFLICT: directly contradicts an established fact with no evidence it is a legitimate update. " +
              "SUPERSEDE: contradicts an established fact but is a legitimate newer state of the world. " +
              "MERGE: restates an established fact with no new information.",
          },
          reason: {
            type: "string",
            description:
              "One or two sentences of evidence-grounded reasoning. Name the specific claim that " +
              "clashes or the specific new information the candidate adds.",
          },
          conflictingFactId: {
            type: "string",
            description:
              "The `id` of the established fact this verdict is about. Required for " +
              "CONFLICT, SUPERSEDE and MERGE. Omit for ALLOWED.",
          },
        },
        required: ["verdict", "reason"],
        additionalProperties: false,
      },
    },
  },
};

const SYSTEM_PROMPT = `You are Aegis, the adversarial Write-Gate guarding a shared memory substrate that a fleet of autonomous AI agents reads from and writes to.

Every incoming fact must be adjudicated against the established facts already in the substrate. Your job is to keep the substrate internally consistent: a single contradiction that slips through will be read as ground truth by every downstream agent.

Adjudicate strictly:
- CONFLICT when the candidate asserts something that cannot be true at the same time as an established fact, and nothing in the candidate indicates it is a legitimate later observation. Mutually exclusive values for the same attribute, negations of an established claim, and incompatible numbers all qualify.
- SUPERSEDE when the candidate contradicts an established fact but is clearly a newer state of the world: an explicit later date or period, an explicit correction or restatement, or a lifecycle transition (planned -> shipped, active -> deprecated).
- MERGE when the candidate says the same thing as an established fact with no new information — a paraphrase, a rounding, or a subset.
- ALLOWED when the candidate adds genuinely new information that is compatible with everything established.

Two facts about different subjects are not in conflict merely because they are worded similarly. Semantic proximity is a retrieval signal, not evidence of contradiction — judge the claims, not the phrasing.

Call ${VERDICT_TOOL_NAME} exactly once. Never answer in prose.`;

function buildUserPrompt(
  fact: string,
  topic: string,
  agentId: string,
  neighbours: ScoredMemory[],
): string {
  const established = neighbours
    .map((n, i) => {
      const state = n.superseded_at
        ? `SUPERSEDED at ${n.superseded_at}`
        : `ACTIVE since ${n.valid_from}`;
      return [
        `[${i + 1}] id: ${n.id}`,
        `    fact: ${n.fact_statement}`,
        `    author: ${n.agent_id} | confidence: ${n.confidence_score.toFixed(2)} | ${state}`,
        `    cosine distance from candidate: ${n.distance.toFixed(4)}`,
      ].join("\n");
    })
    .join("\n");

  return `<topic>${topic}</topic>

<candidate_fact author="${agentId}">
${fact}
</candidate_fact>

<established_facts>
${established || "(none — this topic has no prior memories)"}
</established_facts>

Adjudicate the candidate fact.`;
}

/**
 * Claude 4.x/5 on Bedrock require thinking to be explicitly disabled alongside a
 * forced `toolChoice`. Older model families reject the field outright, so it is
 * only sent to the families that understand it.
 */
function supportsThinkingParam(modelId: string): boolean {
  return /claude-(opus|sonnet|haiku)-(4|5)|claude-(fable|mythos)-5/.test(modelId);
}

function normaliseDecision(raw: unknown): LlmDecision {
  const value = String(raw ?? "").trim().toUpperCase();
  if (value === "CONFLICT" || value === "CONFLICT_REJECTED") return "CONFLICT";
  if (value === "SUPERSEDE" || value === "SUPERSEDED") return "SUPERSEDE";
  if (value === "MERGE" || value === "MERGED") return "MERGE";
  return "ALLOWED";
}

function extractToolUse(content: ContentBlock[] | undefined): Record<string, unknown> | null {
  for (const block of content ?? []) {
    if ("toolUse" in block && block.toolUse?.name === VERDICT_TOOL_NAME) {
      return (block.toolUse.input ?? {}) as Record<string, unknown>;
    }
  }
  return null;
}

/** Last-resort parse for models that answer in prose despite the forced tool. */
function extractJsonFromText(content: ContentBlock[] | undefined): Record<string, unknown> | null {
  const text = (content ?? [])
    .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
    .join("\n");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function adjudicate(args: {
  fact: string;
  topic: string;
  agentId: string;
  neighbours: ScoredMemory[];
  /** Merge cutoff for the local fallback, calibrated to the active embedder. */
  mergeThreshold?: number;
}): Promise<GateAdjudication> {
  const started = Date.now();

  if (env.bedrockMode !== "mock" && liveDisabledReason === null) {
    try {
      const modelId = env.llmModelId;
      const response = await getClient().send(
        new ConverseCommand({
          modelId,
          system: [{ text: SYSTEM_PROMPT }],
          messages: [
            {
              role: "user",
              content: [
                { text: buildUserPrompt(args.fact, args.topic, args.agentId, args.neighbours) },
              ],
            },
          ],
          // No temperature/top_p: current Claude models reject sampling params.
          inferenceConfig: { maxTokens: 1024 },
          toolConfig: {
            tools: [verdictTool],
            toolChoice: { tool: { name: VERDICT_TOOL_NAME } },
          },
          ...(supportsThinkingParam(modelId)
            ? { additionalModelRequestFields: { thinking: { type: "disabled" } } }
            : {}),
        }),
      );

      const content = response.output?.message?.content;
      const payload = extractToolUse(content) ?? extractJsonFromText(content);
      if (!payload) {
        throw new Error("Gatekeeper returned neither a tool call nor parseable JSON.");
      }

      const conflictingFactId =
        typeof payload.conflictingFactId === "string" && payload.conflictingFactId.trim() !== ""
          ? payload.conflictingFactId.trim()
          : null;

      liveConfirmed = true;
      return {
        decision: normaliseDecision(payload.verdict ?? payload.decision),
        reason:
          typeof payload.reason === "string" && payload.reason.trim() !== ""
            ? payload.reason.trim()
            : "Gatekeeper returned a verdict without a stated reason.",
        conflictingFactId,
        evaluator: "bedrock",
        modelId,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      handleLiveFailure("adjudication", err);
    }
  }

  const local = heuristicAdjudicate(args.fact, args.neighbours, args.mergeThreshold);
  return { ...local, latencyMs: Date.now() - started };
}

/** Round-trips a trivial request to confirm Bedrock is actually reachable. */
export async function probeBedrock(): Promise<{
  ok: boolean;
  embedding: boolean;
  llm: boolean;
  error?: string;
  latencyMs: number;
}> {
  const started = Date.now();
  if (env.bedrockMode === "mock") {
    return { ok: false, embedding: false, llm: false, error: "AEGIS_BEDROCK_MODE=mock", latencyMs: 0 };
  }

  resetBedrockFallback();
  let embedding = false;
  let llm = false;
  let error: string | undefined;

  try {
    const result = await embedText("aegis connectivity probe");
    embedding = result.source === "bedrock";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  try {
    const result = await adjudicate({
      fact: "The connectivity probe succeeded.",
      topic: "diagnostics",
      agentId: "probe",
      neighbours: [],
    });
    llm = result.evaluator === "bedrock";
  } catch (err) {
    error ??= err instanceof Error ? err.message : String(err);
  }

  return {
    ok: embedding && llm,
    embedding,
    llm,
    error: error ?? liveDisabledReason ?? undefined,
    latencyMs: Date.now() - started,
  };
}
