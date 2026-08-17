# CockroachDB Cloud MCP — Aegis audit plane

Aegis exposes its governance record through the **CockroachDB Cloud managed MCP
server**, a hosted endpoint at `https://cockroachlabs.cloud/mcp` that lets an AI
client inspect schemas, run read-only SQL, and read query plans against a live
cluster.

Read-only is the server's default posture. Write tools (`create_database`,
`create_table`, `insert_rows`, `update_rows`, `delete_rows`) exist but require
explicit opt-in — **Aegis never enables them.** An audit plane that can alter the
record it audits is not an audit plane.

---

## 1. Connect

Pick whichever authentication style suits you. All four forms use HTTP
transport; SSE is not supported.

### OAuth (all clusters in the org)

```shell
claude mcp add cockroachdb-cloud https://cockroachlabs.cloud/mcp --transport http
```

```jsonc
// ~/.claude.json
"mcpServers": {
  "cockroachdb-cloud": {
    "type": "http",
    "url": "https://cockroachlabs.cloud/mcp"
  }
}
```

### OAuth (scoped to one cluster)

```shell
claude mcp add cockroachdb-cloud https://cockroachlabs.cloud/mcp \
  --transport http \
  --header "mcp-cluster-id: {your-cluster-id}"
```

```jsonc
"mcpServers": {
  "cockroachdb-cloud": {
    "type": "http",
    "url": "https://cockroachlabs.cloud/mcp",
    "headers": { "mcp-cluster-id": "{your-cluster-id}" }
  }
}
```

### Service-account API key

Create the key in the Cloud Console under **Access Management → Service
Accounts**, then:

```shell
claude mcp add cockroachdb-cloud https://cockroachlabs.cloud/mcp \
  --transport http \
  --header "mcp-cluster-id: {your-cluster-id}" \
  --header "Authorization: Bearer {your-service-account-api-key}"
```

```jsonc
"mcpServers": {
  "cockroachdb-cloud": {
    "type": "http",
    "url": "https://cockroachlabs.cloud/mcp",
    "headers": {
      "mcp-cluster-id": "{your-cluster-id}",
      "Authorization": "Bearer {your-service-account-api-key}"
    }
  }
}
```

`cockroach-mcp.config.json` in this directory is the same snippet, ready to
copy. Restart your MCP client after editing its config.

Grant the service account the **least-privilege** role that still permits SQL
reads on the Aegis cluster. Do not reuse an admin key.

---

## 2. Verify

Once connected, ask your MCP client:

> List the tables in the Aegis database, then show me the schema for
> `agent_memories`.

You should see `agent_memories`, `audit_gate_logs`, and the four audit views.
The `embedding` column reports as `VECTOR(1024)`.

---

## 3. Audit queries

These are the questions the governance record is designed to answer. Paste them
into your MCP client (they route through `select_query`).

**What does the fleet currently believe?**

```sql
SELECT topic, agent_id, fact_statement, confidence_score, valid_from
FROM v_active_beliefs
ORDER BY topic, valid_from DESC;
```

**What was blocked, and why?**

```sql
SELECT created_at, agent_id, topic, nearest_distance, evaluator,
       incoming_fact, reasoning
FROM audit_gate_logs
WHERE gatekeeper_verdict = 'CONFLICT_REJECTED'
ORDER BY created_at DESC
LIMIT 25;
```

**How did belief about one topic evolve, and for how long was each version held?**

```sql
SELECT agent_id, status, valid_from, superseded_at, believed_for, fact_statement
FROM v_belief_timeline
WHERE topic = 'pricing-model';
```

**Which agents are drifting?**

```sql
SELECT * FROM v_agent_trust_scores
ORDER BY acceptance_rate_pct NULLS LAST;
```

**Is the gate actually doing work, and how fast?**

```sql
SELECT * FROM v_gate_verdict_summary ORDER BY decisions DESC;
```

**Does the vector index exist, and is the planner using it?**

```sql
SHOW INDEXES FROM agent_memories;

EXPLAIN
SELECT id, fact_statement
FROM agent_memories
WHERE topic = 'pricing-model' AND status = 'ACTIVE'
ORDER BY embedding <=> (SELECT embedding FROM agent_memories LIMIT 1)
LIMIT 5;
```

---

## 4. Read-only tools available upstream

| Tool | Purpose |
| --- | --- |
| `list_databases` | Databases in the cluster |
| `list_tables` | Tables in a database |
| `get_table_schema` | Column definitions |
| `get_cluster` | Cluster metadata |
| `list_sql_users` | SQL users |
| `list_cluster_nodes` | Node membership and liveness |
| `show_running_queries` | Statements executing now |
| `select_query` | Arbitrary read-only SQL |
| `explain_query` | Query plan |
| `show_statement` | Statement details |

---

## 5. The in-app inspector

The dashboard's **MCP inspector** tab reproduces this read-only tool surface
against the same cluster, so you can exercise the audit queries without an MCP
client attached. It is a convenience mirror, not a replacement — the managed
server is what an external auditor connects to.

Its handler (`app/api/mcp/inspect/route.ts`) enforces read-only twice,
independently:

1. a statement allowlist (`SELECT`, `WITH`, `SHOW`, `EXPLAIN`, `TABLE`) with
   mutating-keyword rejection and a single-statement rule, and
2. execution inside `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`, which
   CockroachDB enforces in the engine regardless of what got past step 1.
