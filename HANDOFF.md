# Handoff — where to pick up

_Last session: 2026-08-17. The demo is live; AWS is the one thing left._

## Live right now

- **Demo:** https://aegis-governed-memory-fleet.vercel.app — `status: ok`, `db: true`
- **Repo:** https://github.com/DineshKumar8399/aegis-governed-memory-fleet (public, MIT, `main`)
- **Database:** CockroachDB Cloud v26.2.5, `aws-us-east-2`, substrate `ACTIVE=11 QUARANTINED=3`

```bash
docker compose up -d      # local CockroachDB (independent of Cloud)
npm run doctor            # green except Bedrock
npm test                  # 33 tests
npm run dev               # http://localhost:3000
```

Local dev still points at Docker via `.env.local`. The Cloud connection string
lives in `.env.cloud.local` (gitignored) — `set -a; . ./.env.cloud.local; set +a`
to run any script against Cloud.

## Hackathon status

| Requirement | State |
| --- | --- |
| Public repo + detectable licence | Done — MIT, shows in About |
| >= 2 CockroachDB tools | **3 of 4** — Vector Indexing, Agent Skills, Managed MCP Server |
| >= 1 AWS service | **NOT MET** — Bedrock/S3/Lambda are code-complete but have never made a live call |
| Functional demo URL | Done |
| Video < 3 min | Not started |
| Devpost form | Not started |

## Tomorrow, in order

### 1. AWS — the only compliance blocker

Console work (yours):

- **Bedrock -> Model access**, region **us-east-1**: enable `amazon.titan-embed-text-v2:0`
  and any Claude model. Note the exact Claude model ID you get approved.
- **IAM -> new user**, inline policy allowing `bedrock:InvokeModel` on both
  `arn:aws:bedrock:*::foundation-model/*` **and**
  `arn:aws:bedrock:*:*:inference-profile/*`. The second ARN is not optional for
  `us.anthropic.*` model IDs — without it you get `AccessDeniedException` with no
  hint as to why. Add `s3:PutObject`/`s3:GetObject` on
  `arn:aws:s3:::aegis-memory-provenance/*`.
- **S3 -> create bucket** `aegis-memory-provenance` in `us-east-1`, private.

Then hand over `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and the Claude model ID.

What happens next (~15 min): set them locally and in Vercel, `npm run doctor` to
prove both models respond, **re-seed** so embeddings live in Titan's semantic
space rather than the lexical fallback's, recalibrate
`GATE_SIMILARITY_THRESHOLD` (0.35 is an untested guess — the local embedder
needs 0.72 and Titan's real value is unknown), redeploy, flip the README's
warning rows.

Cost is under five cents total.

### 2. ccloud CLI — 4th tool, needs one interactive step

Installed at `%APPDATA%\ccloud\ccloud.exe` and added to the user PATH. Version
0.6.12 has **no API-key auth** — only a browser login — so it could not be
automated:

```bash
ccloud auth login          # opens a browser
ccloud cluster list
ccloud cluster sql dindinproduct --connection-string
```

Run those, and the fourth tool is genuinely exercised.

### 3. Video and Devpost

Strongest three-minute cut: launch the swarm (four verdicts in ~200ms) ->
Gatekeeper audit showing `probe-epsilon` at 0% acceptance -> the injection demo
where adding the single word `Updated:` flips `CONFLICT_REJECTED` into
`SUPERSEDED`. That last beat is the clearest evidence the gate reasons about
claims rather than string-matching.

## Fixed today

- **`db:migrate` could never bootstrap a fresh Cloud cluster.** The probe used
  `connect()` to test whether the target database existed, but Cloud accepts a
  connection to a database that does not resolve, and `SELECT current_database()`
  echoes back the requested name regardless. Both probes returned success, the
  create was skipped, and migration died on the first `CREATE TABLE` with
  "no database or schema specified". Replaced with an unconditional idempotent
  create gated on `SHOW DATABASES`.
- **Vercel Deployment Protection was on by default**, 302-ing every visitor to an
  SSO login. A judge would have hit a wall, not the app. Disabled.
- **Config errors gave local-only advice.** The deployed app said "copy
  .env.example to .env.local", meaningless on serverless. Now detects `VERCEL` /
  `AWS_LAMBDA_FUNCTION_NAME` and names the right remedy.
- **Serverless connection pooling.** `DATABASE_POOL_MAX` now defaults to 3 on
  Vercel/Lambda: pool size is per-process, so 50 warm instances at the old
  default would open 500 connections and exhaust the cluster limit.
- **CockroachDB password rotated** via `ALTER USER` and verified; old credential
  confirmed dead. New value is in `.env.cloud.local` and Vercel only.

## Deliberate deviations from the brief

- **`VECTOR(1024)`, not 1536.** Titan V2 maxes at 1024; 1536 is Titan V1.
- **C-SPANN vector index syntax, not `USING HNSW`.** HNSW is pgvector and does
  not parse on CockroachDB.
- **Default gatekeeper is `us.anthropic.claude-sonnet-5`**, not Claude 3.5
  Sonnet v2 — swap via `BEDROCK_LLM_MODEL_ID`, no code change.
