/**
 * CockroachDB access layer.
 *
 * Two things here are CockroachDB-specific and load-bearing:
 *
 *  1. `withRetry` — CockroachDB runs SERIALIZABLE by default, so concurrent
 *     transactions that would violate serializability are aborted with SQLSTATE
 *     40001 and are expected to be retried by the client. The agent swarm writes
 *     conflicting facts about the same topic simultaneously, which is exactly
 *     the workload that produces 40001, so retry handling is mandatory rather
 *     than defensive.
 *
 *  2. `toVectorLiteral` / `vectorCast` — the pg driver has no VECTOR codec, so
 *     vectors travel as `'[0.1,0.2,...]'` text and are cast server-side.
 */

import fs from "node:fs";
import pgPkg from "pg";
import { env } from "./env";

const { Pool, types } = pgPkg;
type PoolClient = pgPkg.PoolClient;
type QueryResultRow = pgPkg.QueryResultRow;

// node-postgres returns INT8 (OID 20), FLOAT8 (701) and NUMERIC (1700) as
// strings to preserve precision. In CockroachDB `INT` *is* INT8, so every
// `count(*)::INT` arrives as a string — and `"18" + "10"` is `"1810"`, not 28.
// Every numeric column in this schema is a count, score or latency that fits
// comfortably in a JS number, so parse them and keep the API JSON honest.
const parseFloatOrNull = (v: string | null) => (v === null ? null : Number.parseFloat(v));

types.setTypeParser(20, (v) => {
  if (v === null) return null;
  const parsed = Number(v);
  // Refuse to silently lose precision on a value that cannot round-trip.
  return Number.isSafeInteger(parsed) ? parsed : v;
});
types.setTypeParser(701, parseFloatOrNull);
types.setTypeParser(1700, parseFloatOrNull);

let pool: pgPkg.Pool | undefined;

function buildSslConfig(connectionString: string) {
  if (/sslmode=disable/i.test(connectionString)) return false;

  const caPath = env.databaseCaCertPath;
  if (caPath) {
    return { ca: fs.readFileSync(caPath, "utf8"), rejectUnauthorized: true };
  }
  // CockroachDB Cloud presents a certificate chained to a public root, so the
  // system trust store is sufficient — no cert file to distribute.
  return { rejectUnauthorized: true };
}

export function getPool(): pgPkg.Pool {
  if (pool) return pool;

  const connectionString = env.databaseUrl;
  pool = new Pool({
    connectionString,
    max: env.databasePoolMax,
    ssl: buildSslConfig(connectionString),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    application_name: "aegis-write-gate",
  });

  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as never[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

const RETRYABLE_SQLSTATE = "40001"; // serialization_failure

function isRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === RETRYABLE_SQLSTATE;
}

export interface RetryStats {
  attempts: number;
  retries: number;
}

/**
 * Runs `fn` inside a transaction, retrying on CockroachDB serialization
 * failures with exponential backoff + jitter.
 */
export async function withRetry<T>(
  fn: (client: PoolClient) => Promise<T>,
  opts: { maxAttempts?: number; onRetry?: (attempt: number, err: unknown) => void } = {},
): Promise<{ value: T; stats: RetryStats }> {
  const maxAttempts = opts.maxAttempts ?? 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return { value, stats: { attempts: attempt, retries: attempt - 1 } };
    } catch (err) {
      // The transaction is already aborted server-side on 40001; ROLLBACK is
      // best-effort cleanup so the connection returns to the pool usable.
      await client.query("ROLLBACK").catch(() => undefined);
      lastError = err;
      if (!isRetryable(err) || attempt === maxAttempts) throw err;
      opts.onRetry?.(attempt, err);
      const backoffMs = Math.min(2 ** attempt * 25, 500) + Math.random() * 50;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    } finally {
      client.release();
    }
  }

  throw lastError;
}

/** Encodes a JS number array as a CockroachDB VECTOR literal. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.map((n) => (Number.isFinite(n) ? n : 0)).join(",")}]`;
}

/** `$3::VECTOR(1024)` — dimension comes from validated env, never user input. */
export function vectorCast(paramIndex: number): string {
  return `$${paramIndex}::VECTOR(${env.embeddingDim})`;
}

/** Cheap liveness + capability probe used by /api/health and the doctor script. */
export async function probeDatabase(): Promise<{
  ok: boolean;
  version?: string;
  supportsVector?: boolean;
  tablesReady?: boolean;
  latencyMs: number;
  error?: string;
}> {
  const started = Date.now();
  try {
    const row = await queryOne<{ version: string }>("SELECT version() AS version");
    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('agent_memories', 'audit_gate_logs')`,
    );

    let supportsVector = false;
    try {
      await query(`SELECT '[1,2,3]'::VECTOR(3) <=> '[1,2,3]'::VECTOR(3) AS d`);
      supportsVector = true;
    } catch {
      supportsVector = false;
    }

    return {
      ok: true,
      version: row?.version,
      supportsVector,
      tablesReady: tables.length === 2,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type { PoolClient };
