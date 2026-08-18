/**
 * Applies db/schema.sql to the configured CockroachDB cluster.
 *
 *   npm run db:migrate           # create/repair the schema
 *   npm run db:migrate -- --drop # drop everything first (destructive)
 *
 * The VECTOR width in schema.sql is rewritten to match EMBEDDING_DIM before the
 * file is executed, so switching embedding models is a one-env-var change.
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { c, fail, heading, info, ok, ROOT, warn } from "./bootstrap";
import { env } from "../lib/env";
import { closePool, getPool } from "../lib/db";

const DROP = process.argv.includes("--drop");

/** Strips line comments and splits on statement terminators. */
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function label(statement: string): string {
  const first = statement.split("\n")[0].slice(0, 72);
  return first.replace(/\s+/g, " ");
}

/**
 * A fresh CockroachDB Cloud cluster only has `defaultdb`. If DATABASE_URL points
 * at a database that does not exist yet, create it from `defaultdb` first.
 */
async function ensureDatabaseExists(): Promise<void> {
  const url = new URL(env.databaseUrl);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!dbName || dbName === "defaultdb") return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
    warn(`Database name "${dbName}" is unusual; skipping auto-create.`);
    return;
  }

  // Connect to `defaultdb` and issue an idempotent CREATE, rather than probing
  // the target first.
  //
  // Probing does not work here, and both obvious probes give false positives:
  // CockroachDB Cloud accepts a *connection* to a database that does not exist,
  // and `SELECT current_database()` echoes back the name the session asked for
  // regardless of whether it resolves. The failure only surfaces later, on the
  // first real statement, as "no database or schema specified" — which is what
  // a fresh cluster used to fail with on its very first migration.
  const adminUrl = new URL(env.databaseUrl);
  adminUrl.pathname = "/defaultdb";
  const admin = new pg.Client({
    connectionString: adminUrl.toString(),
    ssl: /sslmode=disable/i.test(env.databaseUrl) ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 15_000,
  });

  await admin.connect();
  try {
    const existing = await admin.query(
      `SELECT 1 FROM [SHOW DATABASES] WHERE database_name = $1`,
      [dbName],
    );
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE IF NOT EXISTS "${dbName}"`);
      ok(`Created database "${dbName}".`);
    } else {
      info(`Database "${dbName}" already exists.`);
    }
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  heading("Aegis · CockroachDB migration");
  info(`target      ${env.databaseUrl.replace(/:\/\/[^@]*@/, "://***@")}`);
  info(`vector dim  ${env.embeddingDim} (from EMBEDDING_DIM)`);

  await ensureDatabaseExists();

  const pool = getPool();
  const client = await pool.connect();

  try {
    const versionRow = await client.query<{ version: string }>("SELECT version() AS version");
    info(`server      ${versionRow.rows[0].version.split(" ").slice(0, 3).join(" ")}`);

    if (DROP) {
      heading("Dropping existing objects");
      for (const stmt of [
        "DROP VIEW IF EXISTS v_gate_verdict_summary",
        "DROP VIEW IF EXISTS v_agent_trust_scores",
        "DROP VIEW IF EXISTS v_belief_timeline",
        "DROP VIEW IF EXISTS v_active_beliefs",
        "DROP TABLE IF EXISTS audit_gate_logs",
        "DROP TABLE IF EXISTS agent_memories",
      ]) {
        await client.query(stmt);
        ok(label(stmt));
      }
    }

    const schemaPath = path.join(ROOT, "db", "schema.sql");
    const raw = fs.readFileSync(schemaPath, "utf8");
    const sql = raw.replaceAll("VECTOR(1024)", `VECTOR(${env.embeddingDim})`);
    if (env.embeddingDim !== 1024) {
      info(`rewrote VECTOR(1024) → VECTOR(${env.embeddingDim}) in schema.sql before execution`);
    }

    heading("Applying schema");
    let applied = 0;
    let skipped = 0;

    for (const statement of splitStatements(sql)) {
      const isClusterSetting = /^SET\s+CLUSTER\s+SETTING/i.test(statement);
      const isVectorIndex = /CREATE\s+VECTOR\s+INDEX/i.test(statement);

      try {
        await client.query(statement);
        applied++;
        ok(label(statement));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // Cluster settings need MODIFYCLUSTERSETTING and do not exist on every
        // release. Vector indexing may already be on by default — either way
        // this is advisory, not fatal.
        if (isClusterSetting) {
          skipped++;
          warn(`${label(statement)} — skipped (${message.split("\n")[0]})`);
          continue;
        }

        if (isVectorIndex) {
          fail(`${label(statement)}`);
          console.error(
            `\n${c.red("Vector index creation failed.")}\n` +
              `  ${message}\n\n` +
              `  Vector indexes require CockroachDB v25.2 or newer. Check your version with:\n` +
              `    SELECT version();\n` +
              `  If you are on an older cluster, upgrade it or use the bundled\n` +
              `  docker-compose.yml, which pins a supported release.\n`,
          );
          throw err;
        }

        fail(`${label(statement)}`);
        throw err;
      }
    }

    heading("Result");
    ok(`${applied} statement(s) applied${skipped > 0 ? `, ${skipped} skipped` : ""}.`);

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    info(`objects: ${tables.rows.map((r) => r.table_name).join(", ")}`);
    console.log(`\n${c.dim("Next:")} ${c.bold("npm run db:seed")}\n`);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error(`\n${c.red("Migration failed:")} ${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
  void closePool();
});
