# Deploying Aegis

The dashboard is a Next.js app; the write-gate runs in its API routes. It
deploys to Vercel unchanged, and to AWS Lambda + API Gateway through the SAM
template in `serverless/`.

What it needs from you is a **reachable** CockroachDB. Everything else has a
working default.

---

## 1. Provision CockroachDB Cloud

[cockroachlabs.cloud/signup](https://cockroachlabs.cloud/signup) — free, no
credit card. Create a cluster, then **Connect → General connection string**.

You want a URL shaped like:

```
postgresql://<user>:<password>@<cluster>.<region>.cockroachlabs.cloud:26257/aegis?sslmode=verify-full
```

Two notes:

- **`sslmode=verify-full` needs no certificate file.** Cloud presents a
  certificate chained to a public root, so the system trust store validates it.
  `DATABASE_CA_CERT_PATH` exists for self-hosted clusters with a private CA and
  should be left unset here.
- **The database does not have to exist yet.** `npm run db:migrate` connects to
  `defaultdb` first and issues `CREATE DATABASE IF NOT EXISTS` before applying
  the schema.

Then, from your machine:

```bash
DATABASE_URL="postgresql://…" npm run doctor      # confirm vector support
DATABASE_URL="postgresql://…" npm run db:migrate  # schema + C-SPANN indexes
DATABASE_URL="postgresql://…" npm run db:seed     # 14 facts through the real gate
```

`doctor` will tell you immediately if the cluster predates v25.2 and lacks
`VECTOR` support.

---

## 2. Deploy to Vercel

```bash
npx vercel login
npx vercel link          # or `npx vercel` and accept the prompts
npx vercel --prod
```

### Environment variables

Set these in **Project → Settings → Environment Variables**, or with
`npx vercel env add <NAME> production`.

| Variable | Required | Value |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | The Cloud connection string from step 1 |
| `EMBEDDING_DIM` | Recommended | `1024` — must match the width the schema was migrated with |
| `AWS_REGION` | For Bedrock | e.g. `us-east-1` |
| `AWS_ACCESS_KEY_ID` | For Bedrock | IAM principal with `bedrock:InvokeModel` |
| `AWS_SECRET_ACCESS_KEY` | For Bedrock | — |
| `AEGIS_BEDROCK_MODE` | No | `auto` (default). Set `live` to fail loudly instead of falling back |
| `S3_BUCKET` | For provenance | Bucket the principal can `s3:PutObject` into |
| `GATE_SIMILARITY_THRESHOLD_LOCAL` | No | `0.72` — governs the gate whenever Bedrock is unreachable |

Without AWS credentials the deployment still works: it falls back to the
deterministic local gatekeeper and labels every verdict `evaluator: heuristic`.
**A database, by contrast, is mandatory** — the vector search and the
serializable write path are the product.

### Connection pooling on serverless

`DATABASE_POOL_MAX` defaults to **3** when `VERCEL` or
`AWS_LAMBDA_FUNCTION_NAME` is set, and 10 otherwise.

This matters more than it looks. A long-running server has one pool; on Vercel
every warm instance holds its own, so the cluster sees `max × instances`. A
spike fanning out to 50 instances at the non-serverless default would open 500
connections and exhaust a small cluster's limit — failing every request,
including the health check. Raise it only if you have measured headroom.

---

## 3. Verify the deployment

```bash
curl -s https://<your-deployment>/api/health | jq '{status, db: .database.ok, vector: .database.supportsVector, bedrock: .bedrock.state}'
```

Expect `status: "ok"`, `db: true`, `vector: true`. `bedrock` will read `live`,
`unverified`, or `fallback` — all three are honest states, and the dashboard
badge shows which one you are in.

Then open the dashboard and press **Launch swarm**. Five agents write
contradictory, duplicate and novel facts to one topic simultaneously; you should
see four different verdicts land in well under a second.

---

## Deploying to AWS Lambda instead

```bash
npm run build:lambda     # esbuild → dist/lambda.js (~236 kB)
npm run deploy:lambda    # sam deploy --guided
```

`serverless/template.yaml` provisions an HTTP API with throttling, arm64,
X-Ray tracing and least-privilege IAM. Pass `DATABASE_URL` as a parameter; do
not bake it into the template.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `type "vector" does not exist` | Cluster predates v25.2. Vector indexes need v25.2+. |
| Health shows `db: false` on Vercel, works locally | `DATABASE_URL` still points at `localhost`. Vercel cannot reach your Docker container. |
| `connection refused` from Vercel | Cloud cluster IP allowlist. Vercel's egress is dynamic — allow `0.0.0.0/0` for a public demo, or use a private endpoint for anything real. |
| Intermittent `too many connections` | Pool size × instance count exceeds the cluster limit. Lower `DATABASE_POOL_MAX`. |
| Every verdict says `evaluator: heuristic` | No AWS credentials resolved. Expected without Bedrock access; `/api/health` names the underlying error. |
