# Aegis — Governed Memory Fleet

**A shared memory layer that autonomous agents cannot corrupt.**

Give a fleet of AI agents a common knowledge store and it degrades within hours.
Agent A writes "Enterprise is \$2,400 per seat." Agent B, reading a stale channel
report, writes "\$900." Agent C hallucinates "\$480 million in Q3 revenue" at 0.31
confidence. Nothing in a conventional vector store objects — embeddings are
appended, retrieval returns whichever neighbour ranks highest, and every
downstream agent now reasons from a substrate that contradicts itself.

Aegis puts an **adversarial Write-Gate** in front of that substrate. Every
incoming fact is embedded, matched against the nearest established beliefs using
CockroachDB's distributed vector index, and adjudicated by Claude on Amazon
Bedrock before it is allowed to become part of what the fleet knows.

| Verdict | What happens |
| --- | --- |
| `ALLOWED` | Novel and compatible — written as an `ACTIVE` belief |
| `CONFLICT_REJECTED` | Contradicts an established fact — written as `QUARANTINED`, never served |
| `SUPERSEDED` | A legitimate newer state of the world — the prior belief is closed out bi-temporally and the new one takes over |
| `MERGED` | A restatement of something already believed — logged, no duplicate row written |

Blocked claims are **kept, not discarded**. A quarantined row is evidence: it is
what turns "an agent is misbehaving" from a hunch into a query.

---

## Table of contents

- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Using the dashboard](#using-the-dashboard)
- [API](#api)
- [Serverless deployment](#serverless-deployment)
- [CockroachDB MCP audit plane](#cockroachdb-mcp-audit-plane)
- [Hackathon submission notes](#hackathon-submission-notes)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

---

## How it works

```
                    agent fleet
                         │  POST /api/memory/submit
                         ▼
   ┌─────────────────────────────────────────────────────────┐
   │                  ADVERSARIAL WRITE-GATE                  │
   │                                                          │
   │  1  archive raw source            ── Amazon S3           │
   │  2  embed the claim               ── Titan Embeddings V2 │
   │  3  confidence fast-path          ── quarantine cheaply  │
   │  4  retrieve nearest beliefs      ── CockroachDB VECTOR  │
   │  5  adjudicate                    ── Claude on Bedrock   │
   │  6  apply in ONE serializable txn ── CockroachDB         │
   └─────────────────────────────────────────────────────────┘
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
   agent_memories                   audit_gate_logs
   (bi-temporal beliefs)            (every decision + reasoning)
        │                                 │
        └──────────────┬──────────────────┘
                       ▼
          CockroachDB Cloud MCP server
             (read-only audit plane)
```

### Why step 6 is the interesting one

The Bedrock adjudication in step 5 takes seconds. Holding row locks across a
model call would serialise the entire fleet, so the gate adjudicates
**optimistically outside** the transaction, then opens a short transaction that
re-reads the neighbours `FOR UPDATE` and re-validates the verdict against the
state it actually finds:

- If a competing agent changed the belief we adjudicated against, the verdict is
  **stale**, and a stale verdict is never applied. The gate re-adjudicates
  against the state that actually exists now (up to 3 rounds) and admits the
  candidate only when nothing contested remains within the threshold.
- If two agents genuinely race to supersede the same belief, CockroachDB aborts
  the loser with `SQLSTATE 40001` and `withRetry` replays it against fresh
  state.

That first rule is subtler than it looks, and getting it wrong is silent. An
earlier version downgraded a stale `CONFLICT` straight to `ALLOWED` on the
reasoning that its target was gone — which admitted the exact contradiction the
gate exists to stop, whenever a concurrent `SUPERSEDE` happened to close the
target first. A vanished target does not mean the candidate is safe; the
replacement may contradict it just as hard.

The memory row and its audit row are written in the **same** transaction, so the
substrate and the audit trail can never disagree about what happened.

The swarm console shows a `↻n` marker on any submission that was aborted and
replayed. Expect to see it rarely — see
[Serializable transactions](#cockroachdb-features-used) for why a well-shaped
gate transaction mostly commits first time.

### Bi-temporality

`agent_memories` is never destructively updated. Superseding a belief stamps
`superseded_at` and flips `status` to `SUPERSEDED`, so `v_belief_timeline` can
answer *"what did the fleet believe about pricing on 3 June, and for how long?"*
— a question a mutable store throws away by construction.

---

## Quickstart

### Prerequisites

- Node.js 20.9+
- CockroachDB **v25.2 or newer** (vector indexes) — Cloud or local
- Optional: AWS credentials with Bedrock model access

> **Aegis runs with zero AWS credentials.** With `AEGIS_BEDROCK_MODE=auto`
> (the default), an unreachable Bedrock endpoint falls back to a deterministic
> local gatekeeper: a lexical feature-hashing embedder and a rule-based
> contradiction detector. Every verdict records which one produced it
> (`evaluator: "bedrock"` vs `"heuristic"`), and the header shows a live/fallback
> badge, so a demo is never mistaken for a live run. **A database is still
> required** — the vector search and the serializable write path are the point.
>
> The fallback is **self-healing and time-bounded**. Dropping to the local
> gatekeeper latches, so an unreachable endpoint is not re-dialled on every
> submission, but the latch expires: 1 minute after the first failure, backing
> off to a 30-minute ceiling. A transient throttle or network blip therefore
> heals on its own instead of demoting the process until someone restarts it.
> `/api/health` reports the pending retry (`"…(retrying in 42s)"`) rather than
> presenting the outage as terminal, and one live success clears the latch.

### 1. Install

```bash
npm install
cp .env.example .env.local
```

### 2. Get a database

**Option A — CockroachDB Cloud (recommended)**

```bash
# https://cockroachlabs.cloud → create a cluster (v25.2+)
ccloud auth login
ccloud cluster list
ccloud cluster sql <CLUSTER_NAME> --connection-string
```

Paste the result into `DATABASE_URL` in `.env.local` and change the database
name at the end of the path to `aegis` — the migrator creates it if it does not
exist.

**Option B — local single node**

```bash
docker compose up -d          # CockroachDB v25.3, DB Console on :8080
```

```ini
DATABASE_URL="postgresql://root@localhost:26257/aegis?sslmode=disable"
```

### 3. Migrate, seed, run

```bash
npm run doctor      # verifies connection, vector support, model access
npm run db:migrate  # applies db/schema.sql
npm run db:seed     # 14 facts through the real gate, including 3 conflicts
npm run dev         # http://localhost:3000
```

`npm run db:reset` drops and rebuilds everything.

### 4. Try it

Open the dashboard, land on **Swarm console**, press **Launch swarm**. Five
agents hit the same topic simultaneously with a contradiction, a duplicate, a
correction, a novel fact and a hallucination. Watch four different verdicts land
in real time.

### 5. Run the tests

```bash
npm test        # 33 tests: heuristics, bedrock fallback, write-gate, concurrency, vector index
npm run test:unit   # the offline-gatekeeper unit tests only — no database needed
```

`npm test` needs a live cluster. Every database test works inside its own
generated topic and deletes it afterwards, so the suite never touches the seeded
demo substrate — you can run it against a populated dashboard without disturbing
the demo.

Three of these earn their keep beyond coverage:

| Test | What breaks without it |
| --- | --- |
| `serves the gate's retrieval query from the C-SPANN index` | Drop `status` from the index prefix and the optimizer silently reverts to a scan. Answers stay correct; only `EXPLAIN` shows the latency story collapsing. The test bulk-loads 800 rows first, because on a 14-row demo table a scan genuinely *is* the cheaper plan. |
| `aborts the loser of a read-write cycle with 40001` | The retry loop is the headline CockroachDB claim and was never actually triggered until this test forced a real dependency cycle. |
| `prefers CONFLICT over MERGE for near-identical but incompatible facts` | "42 minutes" and "6 minutes" of downtime sit close enough in vector space to look like duplicates. Check duplication before contradiction and the gate merges the conflict away — which it did, once. |

---

## Configuration

Every setting lives in `.env.example` with inline documentation. The ones worth
knowing:

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — | **Required.** CockroachDB v25.2+ |
| `AWS_REGION` | `us-east-1` | Bedrock + S3 region |
| `BEDROCK_LLM_MODEL_ID` | `us.anthropic.claude-sonnet-5` | Gatekeeper. Cross-region inference profiles (`us.` prefix) recommended |
| `BEDROCK_EMBEDDING_MODEL_ID` | `amazon.titan-embed-text-v2:0` | Titan V2 supports 1024 / 512 / 256 dims |
| `EMBEDDING_DIM` | `1024` | Must match the model. The migrator rewrites `VECTOR(n)` in `schema.sql` to match |
| `AEGIS_BEDROCK_MODE` | `auto` | `auto` \| `live` \| `mock` |
| `AEGIS_S3_MODE` | `auto` | Same semantics |
| `GATE_SIMILARITY_THRESHOLD` | `0.35` | Cosine distance below which a neighbour is adjudicated |
| `GATE_TOP_K` | `5` | Neighbours retrieved per submission |
| `GATE_MIN_CONFIDENCE` | `0.35` | Below this, quarantine without a model call |
| `CRDB_MCP_URL` | `https://cockroachlabs.cloud/mcp` | Managed MCP endpoint |

### Changing embedding model

```bash
# .env.local
BEDROCK_EMBEDDING_MODEL_ID="amazon.titan-embed-text-v1"
EMBEDDING_DIM="1536"
```

```bash
npm run db:migrate -- --drop && npm run db:seed
```

The dimension change must be a rebuild — a `VECTOR(1024)` column cannot hold
1536-wide vectors, and mixing widths in one index is meaningless.

### AWS credentials

Resolved through the standard AWS SDK chain: environment variables, shared
profile, SSO, ECS task role, EC2 IMDS, Lambda execution role. You also need
**model access enabled** in the Bedrock console for your region, and an IAM
principal holding `bedrock:InvokeModel`.

---

## Using the dashboard

**Swarm console** — Pick a scenario, choose how many agents fire concurrently,
launch. Verdicts stream over NDJSON as the gate produces them. Each line shows
the verdict, the reasoning, the adjudication and total latency, the nearest
cosine distance, the audit-log id, and a `↻n` marker for any CockroachDB
serialization retry.

**Inject memory** — Submit a single fact by hand. The response panel shows the
verdict, the belief it clashed with, and every neighbour the gate retrieved with
its distance plotted against the adjudication threshold. Four presets
("Contradict a belief", "Post a correction", …) demonstrate each verdict path.

**Memory explorer** — Semantic search over the substrate. Results carry live
cosine distances. Selecting a topic renders its bi-temporal belief timeline. The
side panel echoes the exact SQL being executed.

**Gatekeeper audit** — The decision stream, filterable by verdict, polling every
4 s. Click a row for the evaluator, model id, nearest distance, latency, and the
row ids on both sides. Alongside it, per-agent trust scores: an agent whose
acceptance rate is falling is an agent that has started drifting.

**MCP inspector** — The read-only audit plane. Run the same tools the
CockroachDB Cloud MCP server exposes, or write your own read-only SQL, against
the live cluster — plus the ready-to-paste MCP client configuration.

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/memory/submit` | The fleet's only write path. `201` admitted, `202` quarantined |
| `GET` | `/api/memories` | Listing, or vector search with `?q=` |
| `GET` | `/api/audit-logs` | Decision stream; `?since=` for incremental polling |
| `POST` | `/api/simulate-swarm` | Launch the fleet. NDJSON stream by default |
| `GET` | `/api/simulate-swarm` | Scenario catalogue |
| `GET` | `/api/stats` | KPIs, agent trust scores, topic breakdown |
| `GET` | `/api/health` | Dependency status; `?probe=1` forces a Bedrock round-trip |
| `GET` | `/api/mcp/inspect` | MCP config + read-only tool catalogue |
| `POST` | `/api/mcp/inspect` | Execute a read-only tool or SQL statement |

### Submit a memory

```bash
curl -X POST http://localhost:3000/api/memory/submit \
  -H 'Content-Type: application/json' \
  -d '{
    "agentId": "recon-alpha",
    "topic": "pricing-model",
    "fact": "Atlas Enterprise is priced at 900 USD per seat per year with a 25 seat minimum commitment.",
    "confidence": 0.7
  }'
```

```jsonc
{
  "verdict": "CONFLICT_REJECTED",
  "reasoning": "Contradicts established fact by ledger-beta: incompatible values for the same measurement (900 vs 2400). No later timestamp or correction marker justifies overwriting it.",
  "evaluator": "bedrock",
  "modelId": "us.anthropic.claude-sonnet-5",
  "memory": { "status": "QUARANTINED", "...": "..." },
  "conflictingMemory": { "distance": 0.0731, "...": "..." },
  "neighbours": [ /* top-k with cosine distances */ ],
  "auditLogId": "...",
  "latencyMs": 1284,
  "totalMs": 1602,
  "serializationRetries": 0
}
```

### Semantic search

```bash
curl 'http://localhost:3000/api/memories?q=what+does+enterprise+cost+per+seat&limit=5'
```

### Run a swarm (NDJSON)

```bash
curl -N -X POST http://localhost:3000/api/simulate-swarm \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"revenue","agentCount":5}'
```

---

## Serverless deployment

The Lambda handler in `serverless/lambda.ts` imports the **same**
`lib/writeGate.ts` the dashboard uses — only the transport differs. The
dashboard is a control plane for humans; a production fleet posts to API
Gateway, and both must adjudicate identically.

```bash
npm run build:lambda

sam deploy \
  --template-file serverless/template.yaml \
  --guided \
  --capabilities CAPABILITY_IAM
```

`template.yaml` provisions an HTTP API with throttling, the function on arm64
with X-Ray tracing, a versioned + encrypted S3 provenance bucket, and a
least-privilege IAM policy scoped to `bedrock:InvokeModel` on foundation models
and inference profiles.

> Keep `DATABASE_POOL_MAX` small (the template sets `3`) — every warm Lambda
> execution environment holds its own pool.

---

## CockroachDB MCP audit plane

Aegis surfaces its governance record through the CockroachDB Cloud **managed MCP
server**. Full setup, all four auth variants, and a set of ready-made audit
queries are in [`mcp/README.md`](./mcp/README.md).

```jsonc
// ~/.claude.json — or copy mcp/cockroach-mcp.config.json
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

```bash
claude mcp add cockroachdb-cloud https://cockroachlabs.cloud/mcp \
  --transport http \
  --header "mcp-cluster-id: {your-cluster-id}"
```

Read-only is the server's default. Write tools exist upstream but require
explicit opt-in — **Aegis never enables them.** An audit plane that can alter the
record it audits is not an audit plane.

The dashboard's MCP inspector mirrors that tool surface in-app, and enforces
read-only twice, independently: a statement allowlist with mutating-keyword
rejection, *and* execution inside `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`
which CockroachDB enforces in the engine regardless of what got past the
allowlist.

---

## Hackathon submission notes

**Live demo:** https://aegis-governed-memory-fleet.vercel.app
**Backed by:** CockroachDB Cloud v26.2.5 (`aws-us-east-2`), Next.js on Vercel


### Required tools at a glance

**CockroachDB tools used — 3 of 4** (two required)

| Tool | Status | What the agent actually did with it |
| --- | --- | --- |
| **Distributed Vector Indexing** | ✅ Used | Two C-SPANN indexes on `agent_memories`. The Write-Gate's nearest-neighbour retrieval runs on `(topic, status, embedding vector_cosine_ops)` **inside the same serializable transaction as the write it guards**. `EXPLAIN`-asserted in CI (`tests/writeGate.test.ts`). |
| **Agent Skills Repo** | ✅ Used | Installed project-scoped (`.agents/skills/`, 34 skills, pinned in `skills-lock.json`). Three were applied to Aegis's own code and **found 3 real defects**, all fixed — see [`docs/AGENT-SKILLS-AUDIT.md`](docs/AGENT-SKILLS-AUDIT.md). |
| **Cloud Managed MCP Server** | ✅ Used | Connected to a live CockroachDB Cloud cluster over `https://cockroachlabs.cloud/mcp` (config in `mcp/cockroach-mcp.config.json`). The in-app read-only audit plane (`/api/mcp/inspect`) mirrors the managed server's tool surface and refuses every write — verified against 11 bypass attempts including stacked statements, CTE-wrapped `DELETE`, and comment-disguised `UPDATE`. |
| **ccloud CLI** | ❌ Not used | Requires a CockroachDB Cloud account. |

**AWS services used — 3 integrated**

| Service | Status | How |
| --- | --- | --- |
| **Amazon Bedrock** | ⚠️ Code complete, unexercised | Titan Text Embeddings V2 via `InvokeModelCommand`; Claude adjudication via `ConverseCommand` with a **forced tool call** so verdicts return schema-validated JSON, not prose. |
| **Amazon S3** | ⚠️ Code complete, unexercised | Raw source documents archived per submission; the returned URI is stored on the memory row as the provenance anchor. |
| **AWS Lambda + API Gateway** | ⚠️ Code complete, undeployed | `serverless/lambda.ts` + SAM template (HTTP API, throttling, arm64, X-Ray, least-privilege IAM). Builds to a 236 kB bundle. |

### Honest status

This project runs **end-to-end today**, but on a local CockroachDB in Docker and
a deterministic local gatekeeper, because no AWS or CockroachDB Cloud credentials
were available on the build machine.

What that means precisely, so nothing here is overclaimed:

- **Everything CockroachDB-side is real and verified.** Serializable write-gating,
  atomic memory+audit commits, `40001` abort-and-replay (forced by a deliberate
  read-write cycle in `tests/concurrency.test.ts`), C-SPANN vector search
  confirmed by `EXPLAIN` at 800 rows, and all six schema constraints proven to
  reject malformed writes.
- **The AWS paths are written and typechecked but have never made a live call.**
  Every verdict records which evaluator produced it (`bedrock` vs `heuristic`),
  and the dashboard's status badges are three-valued (`live` / `unverified` /
  `fallback`) specifically so a fallback run can never be mistaken for a live
  one. Switching is one environment variable.
- **The local fallback is lexical, not semantic.** It matches tokens; it does not
  understand meaning. It exists so the distributed-systems claims can be
  demonstrated without credentials — it is not a substitute for Titan.

### CockroachDB features used

**1. Distributed vector indexing (`VECTOR` + C-SPANN, cosine)**

```sql
embedding VECTOR(1024) NOT NULL

CREATE VECTOR INDEX idx_memories_topic_status_embedding
    ON agent_memories (topic, status, embedding vector_cosine_ops);

CREATE VECTOR INDEX idx_memories_embedding
    ON agent_memories (embedding vector_cosine_ops);
```

The prefixed index is the load-bearing one, and **both** prefix columns matter.
The Write-Gate always searches one topic domain for currently-believed facts, so
`(topic, status, embedding)` matches its query shape exactly and the ANN scan
stays partition-local. Queries use the `<=>` cosine-distance operator
(`lib/vector.ts`).

This was verified rather than assumed. With only `topic` in the prefix, the
residual `status = 'ACTIVE'` filter makes the optimizer abandon the vector index
for a conventional scan plus top-k sort. On a 20k-row table:

```
• vector search
  table: agent_memories@idx_memories_topic_status_embedding
  target count: 5
  prefix spans: [/'pricing-model'/'ACTIVE' - /'pricing-model'/'ACTIVE']
```

Two things to know if you re-run `EXPLAIN` yourself: the probe vector must be a
**bound parameter** (a `(SELECT embedding FROM …)` subquery defeats the index),
and on a small table a plain scan is genuinely cheaper, so the optimizer will
correctly ignore the vector index until the table is large enough to warrant it.

Because the vector index is partitioned and replicated with the table itself,
the nearest-neighbour search runs *inside the same transaction* as the write it
is guarding. There is no sidecar vector database and therefore no dual-write
consistency gap — the thing that makes an external vector store unusable as a
governance primitive.

**2. Serializable transactions with client-side retry**

`lib/db.ts` implements `withRetry`, replaying `SQLSTATE 40001` aborts with
exponential backoff and jitter. The write-gate transaction takes `FOR UPDATE`
row locks on the beliefs it adjudicated against, so two agents cannot both
supersede the same fact.

Worth being precise about how often that retry actually fires, because it is a
design outcome rather than an accident. The gate keeps its transaction short and
takes the row lock as its *first* statement — the slow part, adjudication,
happens outside the transaction entirely. A transaction whose first act is to
lock what it intends to write has little for the optimizer to fail to serialize,
so most swarm runs commit with `r=0` and the `↻n` marker never appears. That is
the retry loop succeeding at the design level, not sitting idle.

It is genuinely exercised, though, and `npm test` proves both halves:

- `tests/concurrency.test.ts` builds a deliberate read-write **cycle** (A reads P
  then writes Q while B reads Q then writes P). No serial order exists, so
  CockroachDB must abort one side, and the test asserts `withRetry` replays it to
  a successful commit.
- The same file races six agents at one belief and asserts the invariant that
  actually matters: **exactly one fact remains ACTIVE**, every submission leaves
  exactly one audit row, and no audit row points at a memory that does not exist.

A note on what does *not* produce `40001`, since it is an easy test to write and
a misleading one to trust: two transactions blind-inserting different rows are
serializable however they interleave — the reader simply orders before the
writer — and CockroachDB is right to commit both.

**3. CockroachDB Cloud managed MCP server**

Read-only audit endpoints (`mcp/`, `app/api/mcp/inspect/route.ts`) plus the
in-app inspector.

**4. Bi-temporal modelling**

`valid_from` / `superseded_at` with a `CHECK` constraint keeping status and
supersession consistent, exposed through four SQL views (`v_active_beliefs`,
`v_belief_timeline`, `v_agent_trust_scores`, `v_gate_verdict_summary`).

### AWS services used

**1. Amazon Bedrock** (`@aws-sdk/client-bedrock-runtime`)

- `InvokeModelCommand` → Amazon Titan Text Embeddings V2, 1024-d, normalised
- `ConverseCommand` → Claude, with a **forced tool call** (`toolChoice: {tool}`)
  so the adjudication returns schema-validated JSON rather than prose that has
  to be parsed hopefully. Falls back to JSON extraction if a model answers in
  text anyway.

**2. AWS Lambda + API Gateway** — `serverless/lambda.ts` and a SAM template
(`serverless/template.yaml`) with HTTP API, throttling, arm64, X-Ray, and
least-privilege IAM.

**3. Amazon S3** — every raw source document is archived before adjudication
with a content-addressed key; the resulting `s3://` URI is stored on the memory
row, making every belief traceable to the bytes it came from.

### What makes it more than a RAG demo

Most agent-memory systems are append-only vector stores: writes always succeed,
and contradictions are resolved (badly) at read time by whatever ranks highest.
Aegis moves the decision to **write time**, makes it **adversarial**, and makes
it **auditable** — and it does so inside one database transaction, which is only
possible because the vector index and the OLTP tables live in the same
distributed store.

---

## Project layout

```
app/
  api/
    memory/submit/     POST — the write-gate entry point
    memories/          GET  — listing + vector search
    audit-logs/        GET  — decision stream
    simulate-swarm/    POST — NDJSON swarm stream
    mcp/inspect/       GET/POST — read-only audit plane
    stats/  health/    GET  — KPIs and dependency status
  page.tsx             dashboard shell (tabs, KPIs, status bar)
  globals.css          design tokens + component layer

components/            SwarmConsole · InjectForm · MemoryExplorer
                       GatekeeperFeed · McpInspector · ui primitives

lib/
  writeGate.ts         ★ the six-step gate, incl. optimistic re-validation
  vector.ts            CockroachDB vector search + memory mutations
  bedrock.ts           Titan embeddings + Claude forced-tool adjudication
  heuristics.ts        deterministic offline embedder + adjudicator
  db.ts                pool, 40001 retry loop, VECTOR literal encoding
  s3.ts  stats.ts  swarm.ts  env.ts  types.ts

db/schema.sql          tables, C-SPANN vector indexes, audit views
scripts/               migrate · seed · doctor · shared env-file loader
tests/
  heuristics.test.ts   offline embedder + contradiction rules (no DB)
  writeGate.test.ts    all four verdicts, audit consistency, EXPLAIN plan
  concurrency.test.ts  forced 40001 replay + swarm cascade invariant
serverless/            Lambda handler + SAM template
mcp/                   MCP client config + audit query cookbook
docker-compose.yml     local CockroachDB v25.3
```

---

## Troubleshooting

Run `npm run doctor` first — it checks every dependency and names the fix.

| Symptom | Cause and fix |
| --- | --- |
| `type "vector" does not exist` | CockroachDB older than v25.2. Upgrade, or use `docker compose up -d`. |
| `at or near "vector": syntax error` on `CREATE VECTOR INDEX` | Same — the release predates C-SPANN vector indexes. |
| Migration warns about `SET CLUSTER SETTING` | Harmless. The SQL user lacks `MODIFYCLUSTERSETTING`, or the setting does not exist on your release. Vector indexes are enabled by default on current versions. |
| Bedrock badge shows "local gatekeeper" | Credentials did not resolve, or model access is not enabled for `BEDROCK_LLM_MODEL_ID` in your region. `npm run doctor` prints the underlying error. Set `AEGIS_BEDROCK_MODE=live` to make it fail loudly instead of falling back. The badge also shows when the fallback will retry; it clears itself once a live call succeeds. |
| Tuning `GATE_SIMILARITY_THRESHOLD` appears to do nothing | You are almost certainly running on the local embedder, which reads `GATE_SIMILARITY_THRESHOLD_LOCAL` (default `0.72`) instead. Thresholds are per-embedding-space — see the Write-Gate tuning block in `.env.example`. |
| `Embedding width mismatch` | `EMBEDDING_DIM` does not match the model's output. Fix it, then `npm run db:migrate -- --drop`. |
| `AccessDeniedException` from Bedrock | Enable model access in the Bedrock console for that region and grant `bedrock:InvokeModel`. Cross-region inference profiles also need `arn:aws:bedrock:*:*:inference-profile/*`. |
| Everything is `ALLOWED`, nothing conflicts | The substrate is empty — the gate has nothing to contradict. Run `npm run db:seed`, or launch a swarm (it plants an anchor belief first). |
| `database "aegis" does not exist` | `npm run db:migrate` creates it. If your SQL user cannot `CREATE DATABASE`, create it in the Cloud Console first. |
| S3 badge shows "provenance minted, not uploaded" | The bucket does not exist or the principal lacks `s3:PutObject`. Provenance URIs are still minted so the chain is unbroken; create the bucket to store the documents. |
| Swarm shows `↻1` or `↻2` markers | Working as intended — those are CockroachDB `40001` aborts being replayed under concurrency. |
| Swarm *never* shows a `↻n` marker | Also working as intended, and the common case. The gate holds its row lock for microseconds and adjudicates outside the transaction, so there is usually nothing to serialize away. `npm test` forces a real abort to prove the path is live. |
| `EXPLAIN` shows `• scan` instead of `• vector search` | Expected on a demo-sized table — reading 14 rows beats descending an index, and CockroachDB costs that correctly. If it persists at thousands of rows, check that `status` is still a prefix column on `idx_memories_topic_status_embedding`. |

---

## License

MIT
