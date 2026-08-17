/**
 * Seeds a realistic starting world state.
 *
 * Every seed fact is pushed through the real Write-Gate rather than inserted
 * directly, so the audit trail, embeddings and bi-temporal history are all
 * genuine from the first page load. Two of the seeds are deliberate
 * contradictions, so the dashboard has blocked claims to show before anyone
 * runs the swarm.
 */

import { c, heading, info, ok, warn } from "./bootstrap";
import { closePool, query } from "../lib/db";
import { processMemorySubmission } from "../lib/writeGate";
import { bedrockAvailability } from "../lib/bedrock";
import type { MemorySubmission } from "../lib/types";

const YEAR = new Date().getFullYear();

const SEEDS: MemorySubmission[] = [
  // ── pricing-model ──
  {
    agentId: "ledger-beta",
    topic: "pricing-model",
    confidence: 0.95,
    fact: "Atlas Enterprise is priced at 2400 USD per seat per year with a 25 seat minimum commitment.",
  },
  {
    agentId: "recon-alpha",
    topic: "pricing-model",
    confidence: 0.82,
    fact: "Atlas Team tier includes 10 seats, 500 GB of managed storage and standard business-hours support.",
  },
  {
    agentId: "probe-epsilon",
    topic: "pricing-model",
    confidence: 0.63,
    // Contradicts the Enterprise seat price with no correction marker.
    fact: "Atlas Enterprise is priced at 900 USD per seat per year with a 25 seat minimum commitment.",
  },

  // ── incident-postmortem ──
  {
    agentId: "ops-gamma",
    topic: "incident-postmortem",
    confidence: 0.93,
    fact: `Incident ATL-4471 on 14 May ${YEAR} caused 42 minutes of write unavailability in us-east-1, triggered by an exhausted connection pool on the ingest tier.`,
  },
  {
    agentId: "scribe-delta",
    topic: "incident-postmortem",
    confidence: 0.9,
    fact: "The remediation for ATL-4471 raised the ingest connection pool ceiling and added a saturation alert at 80 percent utilisation.",
  },
  {
    agentId: "recon-alpha",
    topic: "incident-postmortem",
    confidence: 0.58,
    // Contradicts the duration recorded by the operations agent.
    fact: `Incident ATL-4471 on 14 May ${YEAR} caused 6 minutes of write unavailability in us-east-1, triggered by an exhausted connection pool on the ingest tier.`,
  },

  // ── customer-accounts ──
  {
    agentId: "recon-alpha",
    topic: "customer-accounts",
    confidence: 0.89,
    fact: "Northwind Logistics renewed for 3 years at an annual contract value of 780000 USD, signed in April.",
  },
  {
    agentId: "ledger-beta",
    topic: "customer-accounts",
    confidence: 0.91,
    fact: "Helios Manufacturing is 47 days past due on invoice INV-20881 for 128000 USD and has been placed on credit hold.",
  },
  {
    agentId: "scribe-delta",
    topic: "customer-accounts",
    confidence: 0.86,
    fact: "Northwind Logistics requires a signed data-processing addendum before any workload is migrated to the eu-west-1 region.",
  },

  // ── model-registry ──
  {
    agentId: "ops-gamma",
    topic: "model-registry",
    confidence: 0.94,
    fact: "The Atlas retrieval pipeline embeds documents with Amazon Titan Text Embeddings V2 at 1024 dimensions and normalisation enabled.",
  },
  {
    agentId: "scribe-delta",
    topic: "model-registry",
    confidence: 0.92,
    fact: "The Atlas adjudication step runs on Anthropic Claude via Amazon Bedrock with a forced tool call so verdicts are schema-validated.",
  },
  {
    agentId: "probe-epsilon",
    topic: "model-registry",
    confidence: 0.28,
    // Below the confidence floor — should be quarantined without a model call.
    fact: "The Atlas retrieval pipeline embeds documents with a locally fine-tuned 40 billion parameter model hosted on-premise.",
  },

  // ── data-residency ──
  {
    agentId: "scribe-delta",
    topic: "data-residency",
    confidence: 0.96,
    fact: "EU customer records are stored exclusively in eu-west-1 and are never replicated outside the European Union.",
  },
  {
    agentId: "ops-gamma",
    topic: "data-residency",
    confidence: 0.9,
    fact: "Cross-region backups for US customer records are written to us-west-2 with a 30 day retention window.",
  },
];

async function main(): Promise<void> {
  heading("Aegis · seeding the memory substrate");

  const availability = bedrockAvailability();
  info(`gatekeeper  ${availability.live ? `Bedrock (${availability.llmModelId})` : `local fallback${availability.reason ? ` — ${availability.reason}` : ""}`}`);

  const existing = await query<{ n: number }>("SELECT count(*)::INT AS n FROM agent_memories");
  if ((existing[0]?.n ?? 0) > 0) {
    warn(`agent_memories already holds ${existing[0].n} row(s); seeding on top of it.`);
    info("Run `npm run db:reset` for a clean slate.");
  }

  const tally: Record<string, number> = {};
  let index = 0;

  // Sequential on purpose: seeding builds a coherent world state, and each fact
  // must be adjudicated against the ones already admitted.
  for (const seed of SEEDS) {
    index++;
    const label = `${String(index).padStart(2, "0")}/${SEEDS.length} ${seed.agentId} → ${seed.topic}`;
    try {
      const result = await processMemorySubmission(seed);
      tally[result.verdict] = (tally[result.verdict] ?? 0) + 1;

      const colour =
        result.verdict === "ALLOWED"
          ? c.green
          : result.verdict === "CONFLICT_REJECTED"
            ? c.red
            : result.verdict === "SUPERSEDED"
              ? c.yellow
              : c.blue;

      console.log(
        `  ${colour(result.verdict.padEnd(18))} ${c.dim(label)}  ${c.dim(`${result.totalMs}ms`)}`,
      );
      if (result.verdict !== "ALLOWED") {
        console.log(`      ${c.dim("↳")} ${c.dim(result.reasoning.slice(0, 150))}`);
      }
    } catch (err) {
      console.log(`  ${c.red("ERROR".padEnd(18))} ${label}`);
      console.log(`      ${c.dim(err instanceof Error ? err.message : String(err))}`);
    }
  }

  heading("Seed summary");
  for (const [verdict, count] of Object.entries(tally)) ok(`${verdict}: ${count}`);

  const totals = await query<{ status: string; n: number }>(
    "SELECT status, count(*)::INT AS n FROM agent_memories GROUP BY status ORDER BY status",
  );
  info(`substrate: ${totals.map((t) => `${t.status}=${t.n}`).join("  ")}`);

  console.log(`\n${c.dim("Next:")} ${c.bold("npm run dev")} ${c.dim("→ http://localhost:3000")}\n`);
}

main()
  .catch((err) => {
    console.error(`\n${c.red("Seeding failed:")} ${err instanceof Error ? err.message : err}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
