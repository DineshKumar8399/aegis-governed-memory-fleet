-- ═════════════════════════════════════════════════════════════════════════════
-- Aegis: Governed Memory Fleet — CockroachDB schema
--
-- Requires CockroachDB v25.2+ (VECTOR column type + C-SPANN vector indexes).
--
-- DIMENSIONS: the VECTOR(1024) below matches Amazon Titan Text Embeddings V2's
-- default output width. If you switch embedding models, change EMBEDDING_DIM in
-- your environment and re-run `npm run db:migrate` — scripts/migrate.ts rewrites
-- every VECTOR(1024) in this file to the configured width before executing.
--   amazon.titan-embed-text-v2:0  -> 1024 (also supports 512 / 256)
--   amazon.titan-embed-text-v1    -> 1536
--   cohere.embed-english-v3       -> 1024
-- ═════════════════════════════════════════════════════════════════════════════

-- Vector indexes are gated behind a cluster setting on some releases. Harmless
-- (and skipped by the migrator) where the setting does not exist or the SQL user
-- lacks MODIFYCLUSTERSETTING.
SET CLUSTER SETTING feature.vector_index.enabled = true;

-- ── agent_memories ───────────────────────────────────────────────────────────
-- The shared, bi-temporal knowledge substrate written by the agent fleet.
--
--   valid_from     — when the fact became true for the world (event time)
--   superseded_at  — when a later fact replaced it (NULL = currently believed)
--
-- A row is never destructively updated: supersession sets `superseded_at` and
-- flips `status`, so the full belief history of every topic stays queryable.
CREATE TABLE IF NOT EXISTS agent_memories (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id          VARCHAR(64)  NOT NULL,
    fact_statement    TEXT         NOT NULL,
    topic             VARCHAR(64)  NOT NULL,
    embedding         VECTOR(1024) NOT NULL,
    valid_from        TIMESTAMPTZ  NOT NULL DEFAULT clock_timestamp(),
    superseded_at     TIMESTAMPTZ  NULL,
    confidence_score  FLOAT        NOT NULL,
    source_s3_uri     TEXT         NOT NULL,
    status            VARCHAR(32)  NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT chk_status
        CHECK (status IN ('ACTIVE', 'QUARANTINED', 'SUPERSEDED')),
    CONSTRAINT chk_confidence
        CHECK (confidence_score >= 0 AND confidence_score <= 1),
    -- An ACTIVE row is by definition not superseded, and vice versa.
    CONSTRAINT chk_supersession_consistency
        CHECK (
            (status = 'SUPERSEDED' AND superseded_at IS NOT NULL)
            OR (status <> 'SUPERSEDED' AND superseded_at IS NULL)
        )
);

-- ── audit_gate_logs ──────────────────────────────────────────────────────────
-- Every adjudication the Write-Gate makes, allowed or not. This is the table the
-- read-only MCP audit plane is pointed at.
CREATE TABLE IF NOT EXISTS audit_gate_logs (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incoming_fact          TEXT        NOT NULL,
    conflicting_memory_id  UUID        NULL REFERENCES agent_memories(id) ON DELETE SET NULL,
    gatekeeper_verdict     VARCHAR(32) NOT NULL,
    reasoning              TEXT        NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    -- Denormalised provenance so the audit feed is self-contained: an auditor
    -- can read this table alone without joining back into the memory substrate.
    agent_id               VARCHAR(64) NULL,
    topic                  VARCHAR(64) NULL,
    resulting_memory_id    UUID        NULL,
    nearest_distance       FLOAT       NULL,
    latency_ms             INT         NULL,
    model_id               VARCHAR(128) NULL,
    evaluator              VARCHAR(32) NULL,

    CONSTRAINT chk_verdict
        CHECK (gatekeeper_verdict IN ('ALLOWED', 'CONFLICT_REJECTED', 'SUPERSEDED', 'MERGED'))
);

-- ── Distributed vector indexes (C-SPANN) ─────────────────────────────────────
-- CockroachDB's vector index is partitioned and replicated with the rest of the
-- table, so approximate-nearest-neighbour search runs inside the same
-- serializable transaction as the write it is guarding — no sidecar vector DB,
-- no dual-write consistency gap.
--
-- Index 1 carries BOTH of the Write-Gate's equality predicates as prefix
-- columns. The gate always searches one topic domain for currently-believed
-- facts, so `(topic, status, embedding)` matches its query shape exactly and the
-- ANN scan stays partition-local.
--
-- The `status` column is load-bearing here, not decorative: with only `topic` in
-- the prefix, a residual `status = 'ACTIVE'` filter makes the optimizer fall
-- back to a conventional index scan plus a top-k sort, and the vector index is
-- never touched. (Verified on 20k rows: `EXPLAIN` shows `• vector search` with
-- this definition and a plain `• scan` without it.)
CREATE VECTOR INDEX IF NOT EXISTS idx_memories_topic_status_embedding
    ON agent_memories (topic, status, embedding vector_cosine_ops);

-- Index 2 is global: powers cross-topic semantic exploration in the dashboard.
CREATE VECTOR INDEX IF NOT EXISTS idx_memories_embedding
    ON agent_memories (embedding vector_cosine_ops);

-- ── Conventional secondary indexes ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_memories_topic_status
    ON agent_memories (topic, status)
    STORING (agent_id, fact_statement, confidence_score, valid_from, superseded_at);

CREATE INDEX IF NOT EXISTS idx_memories_agent
    ON agent_memories (agent_id, valid_from DESC);

CREATE INDEX IF NOT EXISTS idx_memories_timeline
    ON agent_memories (topic, valid_from DESC);

CREATE INDEX IF NOT EXISTS idx_audit_created
    ON audit_gate_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_verdict
    ON audit_gate_logs (gatekeeper_verdict, created_at DESC);

-- ── Read-only audit views (surface these to the MCP server) ──────────────────

-- Currently-believed world state: one row per fact the fleet still stands behind.
CREATE OR REPLACE VIEW v_active_beliefs AS
    SELECT id, agent_id, topic, fact_statement, confidence_score,
           valid_from, source_s3_uri
    FROM agent_memories
    WHERE status = 'ACTIVE' AND superseded_at IS NULL;

-- Bi-temporal belief history: how each topic's understanding evolved, and for
-- how long each version was believed.
CREATE OR REPLACE VIEW v_belief_timeline AS
    SELECT topic,
           id,
           agent_id,
           fact_statement,
           status,
           valid_from,
           superseded_at,
           COALESCE(superseded_at, now()) - valid_from AS believed_for
    FROM agent_memories
    ORDER BY topic, valid_from DESC;

-- Per-agent trust scorecard: which agents produce facts that survive the gate.
CREATE OR REPLACE VIEW v_agent_trust_scores AS
    SELECT m.agent_id,
           count(*)                                                       AS total_submissions,
           count(*) FILTER (WHERE m.status = 'ACTIVE')                    AS active_facts,
           count(*) FILTER (WHERE m.status = 'QUARANTINED')               AS quarantined_facts,
           count(*) FILTER (WHERE m.status = 'SUPERSEDED')                AS superseded_facts,
           round(avg(m.confidence_score)::NUMERIC, 4)                     AS avg_confidence,
           round(
               (count(*) FILTER (WHERE m.status <> 'QUARANTINED'))::NUMERIC
               / NULLIF(count(*), 0) * 100, 2
           )                                                              AS acceptance_rate_pct
    FROM agent_memories m
    GROUP BY m.agent_id;

-- Rolling gate throughput: the shape of the governance decision stream.
CREATE OR REPLACE VIEW v_gate_verdict_summary AS
    SELECT gatekeeper_verdict,
           count(*)                                   AS decisions,
           round(avg(latency_ms)::NUMERIC, 1)         AS avg_latency_ms,
           round(avg(nearest_distance)::NUMERIC, 4)   AS avg_nearest_distance,
           max(created_at)                            AS last_seen
    FROM audit_gate_logs
    GROUP BY gatekeeper_verdict;
