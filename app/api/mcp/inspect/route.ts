/**
 * /api/mcp/inspect — the read-only audit plane.
 *
 * GET  returns the ready-to-paste CockroachDB Cloud MCP Server configuration and
 *      the catalogue of read-only tools the audit plane exposes.
 * POST executes one of those tools.
 *
 * This endpoint mirrors the read-only tool surface of the CockroachDB Cloud
 * managed MCP server (`list_databases`, `list_tables`, `get_table_schema`,
 * `select_query`, `explain_query`, `list_cluster_nodes`, `show_running_queries`)
 * against this application's own cluster, so an auditor can exercise the same
 * queries from the dashboard without first wiring up an MCP client.
 *
 * Read-only is enforced twice, independently:
 *   1. a statement allowlist + mutating-keyword rejection, and
 *   2. `SET TRANSACTION READ ONLY` inside a transaction that always rolls back,
 *      which CockroachDB enforces in the engine regardless of what got past (1).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Tool catalogue ───────────────────────────────────────────────────────────

interface InspectorTool {
  name: string;
  description: string;
  /** Builds the SQL. `arg` is already validated by `argPattern` when present. */
  build: (arg?: string) => string;
  requiresArg?: boolean;
  argLabel?: string;
  argPattern?: RegExp;
  /** Some tables are unavailable on CockroachDB Basic — surface that clearly. */
  mayBeRestricted?: boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

const TOOLS: Record<string, InspectorTool> = {
  list_databases: {
    name: "list_databases",
    description: "List every database visible to the audit role.",
    build: () => "SHOW DATABASES",
  },
  list_tables: {
    name: "list_tables",
    description: "List the tables and views in the current database.",
    build: () =>
      `SELECT table_name, table_type
       FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_type, table_name`,
  },
  get_table_schema: {
    name: "get_table_schema",
    description: "Column definitions for one table, including the VECTOR column.",
    requiresArg: true,
    argLabel: "table name",
    argPattern: IDENTIFIER,
    build: (arg) =>
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${arg}'
       ORDER BY ordinal_position`,
  },
  list_indexes: {
    name: "list_indexes",
    description: "Index definitions for one table — shows the C-SPANN vector indexes.",
    requiresArg: true,
    argLabel: "table name",
    argPattern: IDENTIFIER,
    build: (arg) => `SHOW INDEXES FROM ${arg}`,
  },
  list_cluster_nodes: {
    name: "list_cluster_nodes",
    description: "Cluster membership and liveness.",
    mayBeRestricted: true,
    build: () =>
      `SELECT node_id, address, locality, is_live
       FROM crdb_internal.gossip_nodes
       ORDER BY node_id`,
  },
  show_running_queries: {
    name: "show_running_queries",
    description: "Statements currently executing across the cluster.",
    mayBeRestricted: true,
    build: () =>
      `SELECT node_id, user_name, start, substring(query, 1, 160) AS query
       FROM crdb_internal.cluster_queries
       ORDER BY start
       LIMIT 25`,
  },
  audit_verdict_summary: {
    name: "audit_verdict_summary",
    description: "Governance throughput by verdict (view: v_gate_verdict_summary).",
    build: () => "SELECT * FROM v_gate_verdict_summary ORDER BY decisions DESC",
  },
  agent_trust_scores: {
    name: "agent_trust_scores",
    description: "Per-agent acceptance rate (view: v_agent_trust_scores).",
    build: () =>
      "SELECT * FROM v_agent_trust_scores ORDER BY acceptance_rate_pct NULLS LAST, agent_id",
  },
  belief_timeline: {
    name: "belief_timeline",
    description: "Bi-temporal belief history for one topic (view: v_belief_timeline).",
    requiresArg: true,
    argLabel: "topic",
    argPattern: /^[A-Za-z0-9._-]{1,64}$/,
    build: (arg) =>
      `SELECT topic, agent_id, status, valid_from, superseded_at, believed_for,
              substring(fact_statement, 1, 140) AS fact
       FROM v_belief_timeline
       WHERE topic = '${arg}'
       LIMIT 50`,
  },
  quarantine_report: {
    name: "quarantine_report",
    description: "Every blocked claim with the reasoning that blocked it.",
    build: () =>
      `SELECT l.created_at, l.agent_id, l.topic, l.nearest_distance, l.evaluator,
              substring(l.incoming_fact, 1, 140) AS blocked_claim,
              substring(l.reasoning, 1, 240) AS reasoning
       FROM audit_gate_logs l
       WHERE l.gatekeeper_verdict = 'CONFLICT_REJECTED'
       ORDER BY l.created_at DESC
       LIMIT 25`,
  },
};

// ── Read-only enforcement ────────────────────────────────────────────────────

const ALLOWED_PREFIX = /^(select|with|show|explain|table)\b/i;
const MUTATING = /\b(insert|update|delete|upsert|drop|alter|create|truncate|grant|revoke|comment|import|export|backup|restore|copy|call|refresh|reassign|prepare|execute)\b/i;

export class ReadOnlyViolation extends Error {}

function assertReadOnly(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (trimmed.length === 0) throw new ReadOnlyViolation("Empty statement.");
  if (trimmed.length > 4000) throw new ReadOnlyViolation("Statement exceeds 4000 characters.");
  if (trimmed.includes(";")) {
    throw new ReadOnlyViolation("Only a single statement may be submitted.");
  }
  if (!ALLOWED_PREFIX.test(trimmed)) {
    throw new ReadOnlyViolation(
      "Only SELECT, WITH, SHOW, EXPLAIN and TABLE statements are permitted on the audit plane.",
    );
  }
  if (MUTATING.test(trimmed)) {
    throw new ReadOnlyViolation("Statement contains a mutating keyword and was rejected.");
  }
  return trimmed;
}

interface ExecResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  latencyMs: number;
}

/**
 * Executes inside an explicitly read-only transaction that always rolls back.
 * Even a statement that slipped past `assertReadOnly` cannot mutate anything.
 */
async function executeReadOnly(sql: string): Promise<ExecResult> {
  const started = Date.now();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await client.query(sql);
    await client.query("ROLLBACK");

    return {
      columns: result.fields?.map((f) => f.name) ?? [],
      rows: (result.rows as Record<string, unknown>[]).slice(0, 200),
      rowCount: result.rowCount ?? result.rows.length,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── Config snippet ───────────────────────────────────────────────────────────

function mcpConfigSnippet() {
  const headers: Record<string, string> = {};
  if (env.mcpClusterId) headers["mcp-cluster-id"] = env.mcpClusterId;
  if (env.mcpApiKey) headers["Authorization"] = "Bearer ${CRDB_MCP_API_KEY}";

  const server: Record<string, unknown> = { type: "http", url: env.mcpUrl };
  if (Object.keys(headers).length > 0) server.headers = headers;

  const cliParts = ["claude mcp add cockroachdb-cloud", env.mcpUrl, "--transport http"];
  if (env.mcpClusterId) cliParts.push(`--header "mcp-cluster-id: ${env.mcpClusterId}"`);
  if (env.mcpApiKey) {
    cliParts.push('--header "Authorization: Bearer $CRDB_MCP_API_KEY"');
  }

  return {
    endpoint: env.mcpUrl,
    transport: "http",
    authMode: env.mcpApiKey ? "service-account-api-key" : "oauth",
    clusterScoped: Boolean(env.mcpClusterId),
    json: { mcpServers: { "cockroachdb-cloud": server } },
    cli: cliParts.join(" "),
    readOnlyByDefault: true,
    note:
      "The CockroachDB Cloud MCP server is read-only by default; write tools " +
      "(create_database, create_table, insert_rows, update_rows, delete_rows) " +
      "require explicit opt-in. Aegis intentionally never enables them.",
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function GET() {
  return NextResponse.json({
    mcp: mcpConfigSnippet(),
    tools: Object.values(TOOLS).map((t) => ({
      name: t.name,
      description: t.description,
      requiresArg: Boolean(t.requiresArg),
      argLabel: t.argLabel ?? null,
      mayBeRestricted: Boolean(t.mayBeRestricted),
      sql: t.requiresArg ? t.build("<arg>") : t.build(),
    })),
    upstreamReadOnlyTools: [
      "list_databases",
      "list_tables",
      "get_table_schema",
      "get_cluster",
      "list_sql_users",
      "list_cluster_nodes",
      "show_running_queries",
      "select_query",
      "explain_query",
      "show_statement",
    ],
  });
}

const InspectSchema = z.object({
  tool: z.string().min(1).max(64).optional(),
  arg: z.string().max(128).optional(),
  sql: z.string().max(4000).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = InspectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid inspector request.", issues: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  const { tool, arg, sql } = parsed.data;

  let statement: string;
  let toolName: string;

  if (tool) {
    const spec = TOOLS[tool];
    if (!spec) {
      return NextResponse.json(
        { error: `Unknown tool "${tool}". Call GET /api/mcp/inspect for the catalogue.` },
        { status: 400 },
      );
    }
    if (spec.requiresArg) {
      if (!arg) {
        return NextResponse.json(
          { error: `Tool "${tool}" requires an argument (${spec.argLabel}).` },
          { status: 400 },
        );
      }
      if (spec.argPattern && !spec.argPattern.test(arg)) {
        return NextResponse.json(
          { error: `Invalid ${spec.argLabel} "${arg}".` },
          { status: 400 },
        );
      }
    }
    statement = spec.build(arg);
    toolName = spec.name;
  } else if (sql) {
    try {
      statement = assertReadOnly(sql);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof ReadOnlyViolation ? err.message : "Rejected." },
        { status: 400 },
      );
    }
    toolName = "select_query";
  } else {
    return NextResponse.json({ error: "Provide either `tool` or `sql`." }, { status: 400 });
  }

  try {
    const result = await executeReadOnly(statement);
    return NextResponse.json({ tool: toolName, sql: statement, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        tool: toolName,
        sql: statement,
        error: message,
        hint: TOOLS[toolName]?.mayBeRestricted
          ? "This `crdb_internal` table is not exposed on CockroachDB Basic clusters. Try a Standard/Advanced cluster or a self-hosted node."
          : undefined,
      },
      { status: 400 },
    );
  }
}
