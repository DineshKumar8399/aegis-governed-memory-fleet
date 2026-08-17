/**
 * Deterministic, dependency-free stand-ins for the two Bedrock calls.
 *
 * These exist so the entire platform — swarm simulation, vector search,
 * write-gate, audit trail — runs end-to-end with no AWS credentials. They are a
 * fallback, not a model: the embedder is lexical rather than semantic, and the
 * adjudicator applies contradiction rules instead of reading for meaning.
 * `bedrockAvailability().live` tells the UI which one produced a verdict, and
 * every audit row records `evaluator` so a demo is never mistaken for a live run.
 */

import type { GateAdjudication, ScoredMemory } from "./types";

// ── Hashing embedder ─────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  ("a an and are as at be been being by for from had has have in into is it its of on or " +
    "that the their there these they this to was were will with we our you your").split(" "),
);

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Interior punctuation is kept — it carries meaning in `48.2`, `us-east-1` and
 * `99.95%`. Leading and trailing punctuation is stripped, so a sentence-final
 * `2026.` is the same token as `2026` elsewhere; without that, any fact whose
 * key figure lands at the end of a sentence never matches itself.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9%.\-_/]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.\-_/]+/, "").replace(/[.\-_/]+$/, ""))
    .filter((t) => t.length > 0);
}

/** Content-bearing tokens: no stopwords, no bare punctuation. */
export function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Signed feature-hashing embedder over unigrams + bigrams, L2-normalised so
 * cosine distance behaves the same way it does for a real embedding model.
 * Lexically-related facts land close together, which is what the write-gate's
 * retrieval step needs in order to have anything to adjudicate.
 */
export function heuristicEmbed(text: string, dim: number): number[] {
  const vec = new Float64Array(dim);
  const tokens = contentTokens(text);

  const bump = (feature: string, weight: number) => {
    const h = fnv1a(feature);
    const bucket = h % dim;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    vec[bucket] += sign * weight;
  };

  for (const token of tokens) {
    bump(`u:${token}`, 1);
    // Character 4-grams give partial credit for morphology and typos.
    for (let i = 0; i + 4 <= token.length; i++) {
      bump(`c:${token.slice(i, i + 4)}`, 0.35);
    }
  }
  for (let i = 0; i + 1 < tokens.length; i++) {
    bump(`b:${tokens[i]}_${tokens[i + 1]}`, 0.7);
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm === 0) {
    // Degenerate input (empty / all stopwords): return a stable unit vector so
    // the VECTOR column never receives a zero vector.
    const out = new Array<number>(dim).fill(0);
    out[fnv1a(text) % dim] = 1;
    return out;
  }
  return Array.from(vec, (v) => v / norm);
}

// ── Contradiction detection ──────────────────────────────────────────────────

const NEGATIONS = new Set([
  "not", "no", "never", "cannot", "cant", "won't", "wont", "without",
  "disabled", "removed", "deprecated", "unsupported", "failed", "rejected",
  "down", "offline", "inactive", "revoked", "blocked",
]);

const RECENCY_MARKERS = [
  "updated", "revised", "corrected", "as of", "now", "currently", "latest",
  "supersedes", "replaces", "migrated", "cutover", "effective", "since",
  "amended", "restated", "final", "confirmed",
];

/**
 * Numbers bucketed by unit, so "3 replicas" never clashes with "3 regions".
 * The unit must be a whole token — without the trailing boundary, `m` matches
 * the start of "May", "minutes" and "million" and silently mis-buckets them.
 */
function numericClaims(text: string): Map<string, number[]> {
  const claims = new Map<string, number[]>();
  const re = /(-?\d+(?:\.\d+)?)\s*(%|percent|ms|gb|tb|mb|bn|billion|million|[skmx])?\b/gi;
  const joined = tokenize(text).join(" ");
  let match: RegExpExecArray | null;

  while ((match = re.exec(joined)) !== null) {
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value)) continue;
    // Years are recency signals, not value claims — handled separately.
    if (Number.isInteger(value) && value >= 1900 && value <= 2100 && !match[2]) continue;
    const unit = (match[2] ?? "scalar").toLowerCase();
    const bucket = claims.get(unit) ?? [];
    if (!bucket.includes(value)) bucket.push(value);
    claims.set(unit, bucket);
  }
  return claims;
}

function years(text: string): number[] {
  return [...text.matchAll(/\b(19|20)\d{2}\b/g)]
    .map((m) => Number.parseInt(m[0], 10))
    .filter((y) => y >= 1990 && y <= 2100);
}

function quarters(text: string): number[] {
  return [...text.toLowerCase().matchAll(/\bq([1-4])\b/g)].map((m) => Number.parseInt(m[1], 10));
}

function negationCount(tokens: string[]): number {
  return tokens.filter((t) => NEGATIONS.has(t)).length;
}

/**
 * Tolerance for "the same figure, rounded differently". Kept tight (0.5%) —
 * at 2% a restatement of 48.2 would absorb a genuine correction to 47.6.
 */
function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 0.005);
}

function jaccardOverlap(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

function hasRecencyMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return RECENCY_MARKERS.some((m) => lower.includes(m));
}

export interface ContradictionSignal {
  contradicts: boolean;
  /** Human-readable evidence for the audit log. */
  evidence: string;
  /** True when the candidate looks like a legitimate later observation. */
  looksNewer: boolean;
}

export function detectContradiction(candidate: string, established: string): ContradictionSignal {
  const candTokens = contentTokens(candidate);
  const estTokens = contentTokens(established);
  const overlap = jaccardOverlap(candTokens, estTokens);

  // Facts about different subjects are never in conflict, however similar the
  // embedding says they are.
  if (overlap < 0.4) {
    return { contradicts: false, evidence: "subjects do not overlap", looksNewer: false };
  }

  const candYears = years(candidate);
  const estYears = years(established);
  const candQuarters = quarters(candidate);
  const estQuarters = quarters(established);

  const newerByYear =
    candYears.length > 0 && estYears.length > 0 && Math.max(...candYears) > Math.max(...estYears);
  const sameYear =
    candYears.length > 0 && estYears.length > 0 && Math.max(...candYears) === Math.max(...estYears);
  const newerByQuarter =
    sameYear &&
    candQuarters.length > 0 &&
    estQuarters.length > 0 &&
    Math.max(...candQuarters) > Math.max(...estQuarters);

  const looksNewer = newerByYear || newerByQuarter || hasRecencyMarker(candidate);

  // 1. Polarity flip: one asserts, the other denies.
  const candNeg = negationCount(candTokens);
  const estNeg = negationCount(estTokens);
  if (candNeg > 0 !== estNeg > 0) {
    return {
      contradicts: true,
      evidence: "one statement negates a claim the other asserts",
      looksNewer,
    };
  }

  // 2. Same measurement, different value. Only the values that actually differ
  //    are evidence — a figure both statements agree on proves nothing.
  const candNums = numericClaims(candidate);
  const estNums = numericClaims(established);

  for (const [unit, candValues] of candNums) {
    const estValues = estNums.get(unit);
    if (!estValues || estValues.length === 0) continue;

    const candOnly = candValues.filter((cv) => !estValues.some((ev) => sameNumber(cv, ev)));
    const estOnly = estValues.filter((ev) => !candValues.some((cv) => sameNumber(cv, ev)));

    if (candOnly.length > 0 && estOnly.length > 0) {
      const unitLabel = unit === "scalar" ? "" : ` ${unit}`;
      return {
        contradicts: true,
        evidence: `incompatible values for the same measurement (${candOnly.join("/")}${unitLabel} vs ${estOnly.join("/")}${unitLabel})`,
        looksNewer,
      };
    }
  }

  // 3. Near-identical phrasing that swaps exactly one identifier — the classic
  //    "same attribute, different value" contradiction (region, owner, status).
  if (overlap >= 0.7) {
    const estSet = new Set(estTokens);
    const candSet = new Set(candTokens);
    const onlyCand = candTokens.filter((t) => !estSet.has(t));
    const onlyEst = estTokens.filter((t) => !candSet.has(t));
    if (onlyCand.length > 0 && onlyEst.length > 0 && onlyCand.length <= 3 && onlyEst.length <= 3) {
      return {
        contradicts: true,
        evidence: `same claim with a swapped value ("${onlyEst.join(" ")}" -> "${onlyCand.join(" ")}")`,
        looksNewer,
      };
    }
  }

  return { contradicts: false, evidence: "no incompatible claims found", looksNewer };
}

/**
 * A paraphrase of an established fact: heavy token overlap and every numeric
 * claim identical. Distance alone cannot decide this — a reworded duplicate and
 * a genuinely new fact can sit at the same cosine distance, and they differ by
 * whether the *claims* match, not by how the sentences are spelled.
 */
export function isRestatement(candidate: string, established: string): boolean {
  const a = contentTokens(candidate);
  const b = contentTokens(established);
  if (a.length === 0 || b.length === 0) return false;
  if (jaccardOverlap(a, b) < 0.75) return false;

  const flatten = (text: string) =>
    [...numericClaims(text).values()].flat().sort((x, y) => x - y);
  const na = flatten(candidate);
  const nb = flatten(established);
  if (na.length !== nb.length) return false;
  return na.every((value, i) => sameNumber(value, nb[i]));
}

// ── Local adjudicator ────────────────────────────────────────────────────────

export function heuristicAdjudicate(
  fact: string,
  neighbours: ScoredMemory[],
  mergeThreshold = 0.06,
): Omit<GateAdjudication, "latencyMs"> {
  const active = neighbours.filter((n) => n.status === "ACTIVE" && n.superseded_at === null);

  if (active.length === 0) {
    return {
      decision: "ALLOWED",
      reason: "No established facts in this topic are semantically close enough to conflict with.",
      conflictingFactId: null,
      evaluator: "heuristic",
      modelId: "aegis-local-gatekeeper",
    };
  }

  const nearest = active[0];

  // Contradiction is checked before duplication on purpose. Two sentences can
  // be near-identical in embedding space and still assert incompatible values —
  // "42 minutes of downtime" vs "6 minutes of downtime" differ by one token.
  // Short-circuiting on distance alone would wave those through as duplicates.
  for (const candidate of active) {
    const signal = detectContradiction(fact, candidate.fact_statement);
    if (!signal.contradicts) continue;

    if (signal.looksNewer) {
      return {
        decision: "SUPERSEDE",
        reason: `Contradicts "${truncate(candidate.fact_statement)}" — ${signal.evidence} — but carries a later timestamp or explicit correction, so it is treated as an update.`,
        conflictingFactId: candidate.id,
        evaluator: "heuristic",
        modelId: "aegis-local-gatekeeper",
      };
    }

    return {
      decision: "CONFLICT",
      reason: `Contradicts established fact by ${candidate.agent_id}: ${signal.evidence}. No later timestamp or correction marker justifies overwriting it.`,
      conflictingFactId: candidate.id,
      evaluator: "heuristic",
      modelId: "aegis-local-gatekeeper",
    };
  }

  // Nothing contradicts. Anything that is either near-identical in the vector
  // space or a lexical paraphrase with matching figures is a restatement.
  for (const candidate of active) {
    const veryClose = candidate.distance <= mergeThreshold;
    if (!veryClose && !isRestatement(fact, candidate.fact_statement)) continue;
    return {
      decision: "MERGE",
      reason: veryClose
        ? `Restates an established fact by ${candidate.agent_id} at cosine distance ${candidate.distance.toFixed(4)}; no incompatible claim and no new information.`
        : `Paraphrases an established fact by ${candidate.agent_id} — heavy term overlap and identical figures, so it adds no information.`,
      conflictingFactId: candidate.id,
      evaluator: "heuristic",
      modelId: "aegis-local-gatekeeper",
    };
  }

  return {
    decision: "ALLOWED",
    reason: `Semantically adjacent to ${active.length} established fact(s) (nearest distance ${nearest.distance.toFixed(4)}) but asserts no incompatible claim.`,
    conflictingFactId: null,
    evaluator: "heuristic",
    modelId: "aegis-local-gatekeeper",
  };
}

function truncate(text: string, max = 90): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
