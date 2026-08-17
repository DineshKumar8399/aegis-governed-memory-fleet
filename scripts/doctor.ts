/**
 * Pre-flight diagnostics: `npm run doctor`.
 *
 * Checks every dependency Aegis needs and prints exactly what to fix. Safe to
 * run at any time — it makes one tiny Bedrock call and no writes.
 */

import { c, fail, heading, info, ok, warn } from "./bootstrap";
import { closePool, probeDatabase, query } from "../lib/db";
import { env } from "../lib/env";
import { embedText, probeBedrock } from "../lib/bedrock";
import { s3Availability } from "../lib/s3";

let problems = 0;

function required(name: string): boolean {
  if (process.env[name]) {
    ok(`${name} is set`);
    return true;
  }
  fail(`${name} is not set`);
  problems++;
  return false;
}

async function main(): Promise<void> {
  heading("1 · Environment");
  required("DATABASE_URL");
  info(`AWS_REGION                 ${process.env.AWS_REGION ?? c.dim("(unset → us-east-1)")}`);
  info(`BEDROCK_LLM_MODEL_ID       ${env.llmModelId}`);
  info(`BEDROCK_EMBEDDING_MODEL_ID ${env.embeddingModelId}`);
  info(`EMBEDDING_DIM              ${env.embeddingDim}`);
  info(`AEGIS_BEDROCK_MODE         ${env.bedrockMode}`);
  info(`AEGIS_S3_MODE              ${env.s3Mode}`);

  heading("2 · CockroachDB");
  const db = await probeDatabase();
  if (!db.ok) {
    fail(`unreachable: ${db.error}`);
    problems++;
  } else {
    ok(`connected in ${db.latencyMs}ms — ${db.version?.split(" ").slice(0, 3).join(" ")}`);

    if (db.supportsVector) {
      ok("VECTOR type and the <=> cosine operator are available");
    } else {
      fail("VECTOR type unavailable — CockroachDB v25.2 or newer is required");
      problems++;
    }

    if (db.tablesReady) {
      ok("agent_memories and audit_gate_logs exist");

      const indexes = await query<{ index_name: string }>(
        `SELECT DISTINCT index_name FROM [SHOW INDEXES FROM agent_memories]
         WHERE index_name LIKE '%embedding%'`,
      ).catch(() => []);
      if (indexes.length > 0) {
        ok(`vector indexes present: ${indexes.map((i) => i.index_name).join(", ")}`);
      } else {
        warn("no vector index found on agent_memories — searches will fall back to a full scan");
      }

      const counts = await query<{ status: string; n: number }>(
        "SELECT status, count(*)::INT AS n FROM agent_memories GROUP BY status",
      );
      info(
        counts.length === 0
          ? "substrate is empty — run `npm run db:seed`"
          : `substrate: ${counts.map((r) => `${r.status}=${r.n}`).join("  ")}`,
      );
    } else {
      warn("schema not applied — run `npm run db:migrate`");
      problems++;
    }
  }

  heading("3 · Amazon Bedrock");
  if (env.bedrockMode === "mock") {
    warn("AEGIS_BEDROCK_MODE=mock — running entirely on the local gatekeeper");
  } else {
    const probe = await probeBedrock();
    if (probe.ok) {
      ok(`embeddings + adjudication reachable in ${probe.latencyMs}ms`);
    } else {
      if (probe.embedding) ok("embeddings reachable");
      else fail(`embeddings unreachable (${env.embeddingModelId})`);
      if (probe.llm) ok("adjudication reachable");
      else fail(`adjudication unreachable (${env.llmModelId})`);
      if (probe.error) info(probe.error.split("\n")[0]);
      warn(
        env.bedrockMode === "auto"
          ? "AEGIS_BEDROCK_MODE=auto — Aegis will run on the deterministic local gatekeeper"
          : "AEGIS_BEDROCK_MODE=live — requests will fail until this is resolved",
      );
      info("Check: model access is enabled in the Bedrock console for this region,");
      info("       and the IAM principal holds bedrock:InvokeModel.");
      if (env.bedrockMode === "live") problems++;
    }
  }

  heading("4 · Embedding width");
  try {
    const sample = await embedText("dimension check");
    if (sample.vector.length === env.embeddingDim) {
      ok(`${sample.source} embedder returns ${sample.vector.length} dimensions — matches the schema`);
    } else {
      fail(
        `embedder returned ${sample.vector.length} dimensions but the schema expects ${env.embeddingDim}`,
      );
      info("Set EMBEDDING_DIM to match, then re-run `npm run db:migrate -- --drop`.");
      problems++;
    }
  } catch (err) {
    fail(`embedding failed: ${err instanceof Error ? err.message : err}`);
    problems++;
  }

  heading("5 · Amazon S3 provenance");
  const s3 = s3Availability();
  if (s3.mode === "mock") {
    warn("AEGIS_S3_MODE=mock — provenance URIs are minted but nothing is uploaded");
  } else {
    info(`bucket ${s3.bucket} (region ${env.awsRegion})`);
    info("Provenance writes are best-effort; a failure degrades to a minted URI, never a 500.");
  }

  heading("6 · CockroachDB Cloud MCP");
  info(`endpoint ${env.mcpUrl}`);
  info(env.mcpApiKey ? "auth: service-account API key" : "auth: OAuth (no CRDB_MCP_API_KEY set)");
  info(env.mcpClusterId ? `scoped to cluster ${env.mcpClusterId}` : "not scoped to a cluster");

  heading("Result");
  if (problems === 0) {
    ok("All checks passed. Run `npm run dev`.");
  } else {
    fail(`${problems} problem(s) found — see above.`);
    process.exitCode = 1;
  }
  console.log("");
}

main()
  .catch((err) => {
    console.error(`\n${c.red("doctor failed:")} ${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
