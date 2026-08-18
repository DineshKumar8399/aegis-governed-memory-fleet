# CockroachDB Agent Skills — audit of the Aegis write path

The [CockroachDB Agent Skills Repo](https://github.com/cockroachlabs/cockroachdb-skills)
is installed **project-scoped** (`.agents/skills/`, pinned in `skills-lock.json`)
so it travels with this repository rather than living in one developer's global
agent config:

```bash
npx skills add cockroachlabs/cockroachdb-skills -p
```

34 skills across 9 operational domains. This document records what was actually
done with them — three were applied to Aegis's own code, and two of those found
real defects that are now fixed.

---

## 1. `designing-application-transactions` → 3 defects found

Applied to `lib/db.ts` and `lib/writeGate.ts`, the two files that own every
transaction Aegis opens.

### PASS — transaction scope

> *"Do not place remote API calls, service-to-service requests, loops, expensive
> computation, or artificial waits inside a CockroachDB transaction."*

This is the single most important design decision in the project, and it was
already right. The gatekeeper model call takes seconds; the write-gate
deliberately adjudicates **outside** the transaction, then opens a short one that
re-reads under `FOR UPDATE` and re-validates the verdict. Holding row locks
across a Bedrock round-trip would serialize the entire fleet.

The skill also explains a consequence we had already observed empirically:
*"external work inside a retried transaction may run twice."* Keeping the model
call outside is what makes replaying a `40001` free of duplicate side effects.

### PASS — retry strategy

> *"For most applications, a full-transaction retry loop is simpler and
> recommended"* over the `SAVEPOINT cockroach_restart` protocol.

`withRetry` already does full-transaction replay with exponential backoff **and
jitter**, matching the reference implementation.

### PASS — push invariants into SQL

> *"Do not fetch state into application code, modify it in memory, and write it
> back."*

`supersedeMemory` is a guarded UPDATE — `WHERE id = $1 AND superseded_at IS
NULL` — so it is idempotent under retry and two concurrent supersessions cannot
double-close a row. No read-modify-write anywhere in the write path.

### **FAIL → fixed** — `40003` was indistinguishable from a clean abort

The skill's SQLSTATE table draws a line we had collapsed:

| Code | Meaning | Action |
|---|---|---|
| `40001` | Serialization / retryable | Retry the whole unit of work |
| `40003` | Ambiguous result / indeterminate commit | **Do not blindly replay non-idempotent work** |

`isRetryable` only tested for `40001`, so `40003` fell through to the generic
`throw`. Not *wrong* — an ambiguous commit was never replayed — but it surfaced
as an anonymous error, so a caller could not distinguish "definitely failed" from
"may have committed." For a write-gate that distinction is the whole game:
resubmitting an ambiguous commit can admit a fact twice or supersede a belief
that was already superseded.

Now raised as a typed `AmbiguousCommitError` carrying the guidance to re-read
`audit_gate_logs` to establish what actually landed.

### **FAIL → fixed** — connections had unbounded lifetime

> *`maxLifetime`: 30 min (add jitter ± 5 min)*

The pool set no maximum lifetime. Against a *distributed* cluster this is not
hygiene, it is load distribution: a connection pinned to one node for the
process lifetime keeps sending traffic there after a rolling restart or a
scale-out, and newly added nodes never pick up their share. Now
`maxLifetimeSeconds: 1800 + jitter(0–300)`, with the jitter preventing a fleet
of pods from recycling in lockstep.

### **FAIL → fixed** — idle timeout too aggressive

Recommended 5–10 minutes; Aegis had 30 seconds, which churned connections
between bursts of swarm traffic and paid reconnect cost for a negligible idle
saving. Now 10 minutes.

---

## 2. `analyzing-range-distribution` → validated the "distributed" claim

Run against the live cluster to check that C-SPANN vector indexes are genuinely
independent distributed structures rather than a column on the primary index:

```sql
SELECT index_name, count(*) AS ranges
FROM [SHOW RANGES FROM TABLE agent_memories WITH INDEXES]
GROUP BY index_name ORDER BY ranges DESC;
```

| index | ranges |
|---|---|
| `idx_memories_embedding` | **2** |
| `idx_memories_topic_status_embedding` | **2** |
| `agent_memories_pkey` | 1 |
| `idx_memories_agent` | 1 |
| `idx_memories_timeline` | 1 |
| `idx_memories_topic_status` | 1 |

Both **vector** indexes have already split into multiple ranges while every
conventional index is still a single range — the C-SPANN structure partitions on
its own schedule. On a multi-node cluster those ranges are what distribute the
ANN scan across nodes.

**Honest limit:** this is a single-node Docker cluster, so all ranges currently
share one node. The range *splitting* is real and observable; cross-node
*placement* is not demonstrated here and would need a multi-node or Cloud
cluster to show.

---

## 3. `auditing-table-statistics` → explained an earlier test failure

Used to interpret a genuinely confusing result: `EXPLAIN` showed `• scan`
instead of `• vector search` on the seeded demo table, which looked like the
vector index was broken.

It was not. Table statistics drive the optimizer's cost model, and on a 14-row
table a full scan plus top-k genuinely *is* cheaper than descending an index.
The fix was to make the test honest rather than to change the schema:
`tests/writeGate.test.ts` now bulk-loads 800 rows and runs `ANALYZE` before
asserting, at which point the plan flips to

```
• vector search
  table: agent_memories@idx_memories_topic_status_embedding
  prefix spans: [/'…'/'ACTIVE' - /'…'/'ACTIVE']
```

confirming both equality predicates are answered by the index prefix rather than
re-checked as a residual filter.

---

## Skills consulted but not applied

`provisioning-cluster-for-production`, `configuring-ip-allowlists`,
`auditing-cloud-cluster-security` and `configuring-audit-logging` all target a
CockroachDB **Cloud** cluster. They are the migration path for this project and
are deliberately listed here as not-yet-exercised rather than claimed.
