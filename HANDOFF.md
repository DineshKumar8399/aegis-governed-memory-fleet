# Handoff — where to pick up

_Last session: 2026-08-17. Everything below is committed to disk and verified working._

## State: fully working end-to-end, now with a test suite

```bash
docker compose up -d      # CockroachDB v25.3.3, already has a persistent volume
npm run doctor            # green except Bedrock (no AWS creds on this machine)
npm test                  # 33 tests, all passing (needs the cluster up)
npm run dev               # http://localhost:3000
```

The seeded substrate is **already in the Docker volume** — verified surviving a
stop/start cycle, so you do not need to re-run `db:migrate` / `db:seed` unless
you want a clean slate.

When shutting down, use `docker compose stop -t 60`. The default 10s timeout is
not enough for CockroachDB to drain and Docker SIGKILLs it (exit 137). The data
survives either way — it is crash-safe — but a clean exit 0 is better.

Typecheck clean, `next build` passes, `npm run build:lambda` passes, all 33
tests pass, and the UI has now been driven in a real browser.

## Closed this session

All three "start here" items from the previous handoff are done except live
Bedrock, which is blocked on credentials rather than on code.

### 1. The `40001` retry path is now proven — and the claim was subtly wrong

The old handoff said "nothing yet forces a 40001" and treated `r=0` as a gap.
Investigating it produced the more interesting answer: **`r=0` is mostly the
design working**, not a missing test. The gate adjudicates outside the
transaction and takes its row lock as the transaction's first statement, so
there is usually nothing left to fail to serialize.

The first test written for this was wrong in an instructive way: two
transactions blind-inserting different rows **cannot** produce `40001`, because
they are serializable however they interleave (the reader just orders before the
writer). CockroachDB was right to commit both. `tests/concurrency.test.ts` now
forces a genuine read-write **cycle** (A reads P → writes Q, B reads Q → writes
P), which has no serial order and must abort one side. That asserts `withRetry`
replays to success.

The six-agent cascade test alongside it asserts the invariant that actually
matters — exactly one ACTIVE belief survives, one audit row per submission, no
dangling references. It intermittently logs 1 retry, so the `↻n` UI marker does
render under real contention.

### 2. The UI works — all five tabs driven in Chrome

Swarm console (NDJSON streaming, live verdict badges, KPIs updating mid-run),
Memory explorer (semantic search ranked by cosine distance, live SQL panel),
Gatekeeper audit (filter chips, agent trust scores), MCP inspector (executed
`list_tables`, 6 rows / 17ms), Inject memory (full gate response with provenance
URI and the clashing belief). No console errors. The `CockroachDB unreachable`
badge on first paint is just the pre-fetch state, not a bug.

### 3. Test suite added

`npm test` (33 tests) / `npm run test:unit` (no database needed).

Every DB test runs inside its own generated topic and cleans up after itself, so
the suite never disturbs the seeded demo substrate. Verified: substrate still
`ACTIVE=11, QUARANTINED=3` with zero leftover rows after a full run.

The `EXPLAIN` test bulk-loads 800 rows before asserting, because **on the
14-row demo table the optimizer correctly picks a plain scan** — an assertion
against the seeded data would only prove CockroachDB costs small tables
sensibly. At 800 rows the plan flips to
`• vector search … agent_memories@idx_memories_topic_status_embedding` with
prefix spans on `(topic, status)`.

### 4. Smaller items

- `npm run build:lambda` works now (esbuild's postinstall is approved on this
  box) — 236kb bundle.
- Env-file loading moved out of `scripts/bootstrap.ts` into
  `scripts/env-files.ts`, shared by scripts and tests. Tests import
  `tests/setup.ts` first, because ESM hoists imports and a bare
  `loadEnvFiles()` call would run *after* `lib/db` had been evaluated.
- README corrected: it still described the stale-verdict bug's old behaviour
  ("downgraded to `ALLOWED`") as if it were current. It now documents the
  re-adjudication loop, plus honest sections on when `40001` fires and when
  `EXPLAIN` shows a scan.

## Start here next

1. **Run it against real Bedrock.** Still the one untested integration —
   everything so far exercises the deterministic local fallback. Set
   credentials, enable model access, `AEGIS_BEDROCK_MODE=live`, then
   `npm run doctor` → `npm run db:reset`. Watch for: the `ConverseCommand`
   forced-tool call, the `thinking: {type:"disabled"}` branch for Claude 4.x/5
   on Bedrock (see `supportsThinkingParam` in `lib/bedrock.ts`), and whether
   `GATE_SIMILARITY_THRESHOLD=0.35` is right for Titan's space — it is currently
   a guess. The local embedder needs ~0.72; a single shared constant made the
   demo show no conflicts at all, which is why `gateThresholds()` is
   per-embedding-space.
2. **CockroachDB Cloud.** The SSL path in `buildSslConfig` handles Cloud's
   public-root cert with no cert file, but has only been exercised against local
   `sslmode=disable`. One `DATABASE_URL` change to test.
3. Compliance scenario's second "novel" agent is still a weak demo beat —
   `ALLOWED` at distance 0.98, correct but uninteresting.

## Deliberate deviations from the original brief

Flagged so they can be reverted if you'd rather match the spec exactly:

- **`VECTOR(1024)`, not 1536.** Titan Text Embeddings V2 maxes out at 1024.
  1536 is Titan **V1**. `EMBEDDING_DIM` drives it and `scripts/migrate.ts`
  rewrites the schema to match, so switching is one env var + `db:migrate --drop`.
- **`CREATE VECTOR INDEX … USING cspann`-style syntax, not HNSW.** CockroachDB
  implements C-SPANN; `USING HNSW` is Postgres/pgvector and does not parse.
- **Default gatekeeper model is `us.anthropic.claude-sonnet-5`**, not Claude 3.5
  Sonnet v2. The legacy ID is documented in `.env.example` as a drop-in
  alternative — one env var, no code change.
