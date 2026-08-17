/**
 * Distributed vector search against CockroachDB.
 *
 * The `<=>` operator is cosine distance. Ordering by it lets CockroachDB's
 * C-SPANN vector index serve the approximate-nearest-neighbour scan. Both
 * equality predicates the gate uses — `topic` and `status` — are prefix columns
 * on `idx_memories_topic_status_embedding`, so the scan is confined to one
 * topic's currently-believed partition rather than the whole table.
 *
 * Query shape matters more than it looks: with only `topic` in the prefix, the
 * residual `status` filter makes the optimizer abandon the vector index for a
 * conventional scan plus top-k sort. `EXPLAIN` should show `• vector search`,
 * not `• scan`.
 *
 * Every function here optionally takes a `PoolClient`, which is what makes the
 * Write-Gate possible: the neighbour lookup and the insert that depends on it
 * run inside a single serializable transaction, so two agents racing to write
 * contradictory facts cannot both read a pre-conflict snapshot and both commit.
 */

import { getPool, query, toVectorLiteral, vectorCast, type PoolClient } from "./db";
import { env } from "./env";
import type { AgentMemory, ScoredMemory, TimelineEntry } from "./types";

const MEMORY_COLUMNS = `
  id, agent_id, fact_statement, topic,
  valid_from, superseded_at, confidence_score, source_s3_uri, status
`;

type Executor = Pick<PoolClient, "query"> | ReturnType<typeof getPool>;

function exec(client?: PoolClient): Executor {
  return client ?? getPool();
}

function withSimilarity(rows: (AgentMemory & { distance: number })[]): ScoredMemory[] {
  return rows.map((row) => ({
    ...row,
    distance: Number(row.distance),
    // Cosine distance runs 0..2; fold it into an intuitive 0..1 similarity.
    similarity: Math.max(0, Math.min(1, 1 - Number(row.distance) / 2)),
  }));
}

export interface NeighbourOptions {
  topic?: string;
  limit?: number;
  /** Include QUARANTINED and SUPERSEDED rows (default: active only). */
  includeInactive?: boolean;
  /** Drop neighbours farther than this cosine distance. */
  maxDistance?: number;
  client?: PoolClient;
  /** Take a row lock on the returned rows (write-gate path only). */
  forUpdate?: boolean;
}

/**
 * Top-k nearest memories to `embedding`.
 *
 * `forUpdate` is the concurrency-control lever: inside the gate transaction we
 * lock the neighbours we adjudicated against, so a competing transaction cannot
 * supersede them between our read and our write.
 */
export async function findNearestMemories(
  embedding: number[],
  options: NeighbourOptions = {},
): Promise<ScoredMemory[]> {
  const limit = Math.max(1, Math.min(options.limit ?? env.topK, 50));
  const params: unknown[] = [toVectorLiteral(embedding)];
  const filters: string[] = [];

  if (!options.includeInactive) {
    // `status = 'ACTIVE'` alone: the chk_supersession_consistency constraint
    // guarantees an ACTIVE row has a NULL superseded_at, so adding that
    // predicate would only bolt a residual filter onto the vector scan.
    filters.push(`status = 'ACTIVE'`);
  }
  if (options.topic) {
    params.push(options.topic);
    filters.push(`topic = $${params.length}`);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
  params.push(limit);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT ${MEMORY_COLUMNS},
           embedding <=> ${vectorCast(1)} AS distance
    FROM agent_memories
    ${where}
    ORDER BY embedding <=> ${vectorCast(1)}
    LIMIT ${limitParam}
    ${options.forUpdate ? "FOR UPDATE" : ""}
  `;

  const result = await exec(options.client).query(sql, params as never[]);
  const scored = withSimilarity(result.rows as (AgentMemory & { distance: number })[]);

  return options.maxDistance === undefined
    ? scored
    : scored.filter((row) => row.distance <= options.maxDistance!);
}

/** Semantic search for the Memory Explorer — spans topics and statuses. */
export async function semanticSearch(args: {
  embedding: number[];
  topic?: string;
  status?: string;
  limit?: number;
}): Promise<ScoredMemory[]> {
  const limit = Math.max(1, Math.min(args.limit ?? 12, 100));
  const params: unknown[] = [toVectorLiteral(args.embedding)];
  const filters: string[] = [];

  if (args.topic) {
    params.push(args.topic);
    filters.push(`topic = $${params.length}`);
  }
  if (args.status) {
    params.push(args.status);
    filters.push(`status = $${params.length}`);
  }

  params.push(limit);
  const sql = `
    SELECT ${MEMORY_COLUMNS},
           embedding <=> ${vectorCast(1)} AS distance
    FROM agent_memories
    ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
    ORDER BY embedding <=> ${vectorCast(1)}
    LIMIT $${params.length}
  `;

  const rows = await query<AgentMemory & { distance: number }>(sql, params);
  return withSimilarity(rows);
}

/** Inserts a memory row. Runs inside the gate transaction when `client` is set. */
export async function insertMemory(
  args: {
    agentId: string;
    fact: string;
    topic: string;
    embedding: number[];
    confidence: number;
    sourceUri: string;
    status: "ACTIVE" | "QUARANTINED";
  },
  client?: PoolClient,
): Promise<AgentMemory> {
  const sql = `
    INSERT INTO agent_memories
      (agent_id, fact_statement, topic, embedding, confidence_score, source_s3_uri, status)
    VALUES ($1, $2, $3, ${vectorCast(4)}, $5, $6, $7)
    RETURNING ${MEMORY_COLUMNS}
  `;
  const result = await exec(client).query(sql, [
    args.agentId,
    args.fact,
    args.topic,
    toVectorLiteral(args.embedding),
    args.confidence,
    args.sourceUri,
    args.status,
  ] as never[]);
  return result.rows[0] as AgentMemory;
}

/**
 * Closes out a belief: stamps `superseded_at` and flips status. The
 * `superseded_at IS NULL` predicate makes this idempotent under retry and
 * prevents two concurrent supersessions from double-closing the same row.
 */
export async function supersedeMemory(
  memoryId: string,
  client?: PoolClient,
): Promise<AgentMemory | null> {
  const sql = `
    UPDATE agent_memories
    SET superseded_at = clock_timestamp(), status = 'SUPERSEDED'
    WHERE id = $1 AND superseded_at IS NULL
    RETURNING ${MEMORY_COLUMNS}
  `;
  const result = await exec(client).query(sql, [memoryId] as never[]);
  return (result.rows[0] as AgentMemory) ?? null;
}

export async function listMemories(args: {
  status?: string;
  topic?: string;
  agentId?: string;
  limit?: number;
  offset?: number;
}): Promise<AgentMemory[]> {
  const params: unknown[] = [];
  const filters: string[] = [];

  if (args.status) {
    params.push(args.status);
    filters.push(`status = $${params.length}`);
  }
  if (args.topic) {
    params.push(args.topic);
    filters.push(`topic = $${params.length}`);
  }
  if (args.agentId) {
    params.push(args.agentId);
    filters.push(`agent_id = $${params.length}`);
  }

  params.push(Math.max(1, Math.min(args.limit ?? 50, 200)));
  const limitParam = `$${params.length}`;
  params.push(Math.max(0, args.offset ?? 0));
  const offsetParam = `$${params.length}`;

  return query<AgentMemory>(
    `SELECT ${MEMORY_COLUMNS}
     FROM agent_memories
     ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
     ORDER BY valid_from DESC
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );
}

/** Bi-temporal history for one topic, newest first. */
export async function topicTimeline(topic: string, limit = 40): Promise<TimelineEntry[]> {
  return query<TimelineEntry>(
    `SELECT id, topic, agent_id, fact_statement, status, valid_from, superseded_at
     FROM agent_memories
     WHERE topic = $1
     ORDER BY valid_from DESC
     LIMIT $2`,
    [topic, Math.max(1, Math.min(limit, 200))],
  );
}

export async function listTopics(): Promise<{ topic: string; total: number; active: number }[]> {
  return query<{ topic: string; total: number; active: number }>(
    `SELECT topic,
            count(*)::INT AS total,
            count(*) FILTER (WHERE status = 'ACTIVE')::INT AS active
     FROM agent_memories
     GROUP BY topic
     ORDER BY total DESC`,
  );
}
