/**
 * Central, validated configuration. Every module reads settings from here so
 * there is exactly one place where an env var name appears.
 */

type Mode = "auto" | "live" | "mock";

function str(name: string, fallback?: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return raw;
}

function optional(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? undefined : raw;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}".`);
  }
  return parsed;
}

function float(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}".`);
  }
  return parsed;
}

function mode(name: string, fallback: Mode): Mode {
  const raw = (process.env[name] ?? fallback).toLowerCase();
  if (raw !== "auto" && raw !== "live" && raw !== "mock") {
    throw new Error(`Environment variable ${name} must be auto | live | mock, got "${raw}".`);
  }
  return raw;
}

/**
 * Embedding width. Interpolated into SQL casts, so it is validated hard —
 * anything that reaches a query string must be provably a small positive int.
 */
function embeddingDim(): number {
  const dim = int("EMBEDDING_DIM", 1024);
  if (!Number.isInteger(dim) || dim < 1 || dim > 16000) {
    throw new Error(`EMBEDDING_DIM must be an integer between 1 and 16000, got ${dim}.`);
  }
  return dim;
}

export const env = {
  // ── CockroachDB ──
  get databaseUrl() {
    return str("DATABASE_URL");
  },
  get databaseCaCertPath() {
    return optional("DATABASE_CA_CERT_PATH");
  },
  get databasePoolMax() {
    return int("DATABASE_POOL_MAX", 10);
  },

  // ── Bedrock ──
  get awsRegion() {
    return str("AWS_REGION", "us-east-1");
  },
  get embeddingModelId() {
    return str("BEDROCK_EMBEDDING_MODEL_ID", "amazon.titan-embed-text-v2:0");
  },
  get llmModelId() {
    return str("BEDROCK_LLM_MODEL_ID", "us.anthropic.claude-sonnet-5");
  },
  get embeddingDim() {
    return embeddingDim();
  },
  get bedrockMode(): Mode {
    return mode("AEGIS_BEDROCK_MODE", "auto");
  },

  // ── S3 ──
  get s3Bucket() {
    return optional("S3_BUCKET") ?? "aegis-memory-provenance";
  },
  get s3Prefix() {
    return process.env.S3_PREFIX ?? "raw/";
  },
  get s3Mode(): Mode {
    return mode("AEGIS_S3_MODE", "auto");
  },

  // ── Write-Gate ──
  get similarityThreshold() {
    return float("GATE_SIMILARITY_THRESHOLD", 0.35);
  },
  /**
   * The local fallback embedder is lexical, not semantic: two facts that mean
   * the same thing but share fewer tokens land further apart than they would in
   * Titan's space. A threshold is a property of the embedding space it is
   * measured in, so the fallback carries its own.
   */
  get similarityThresholdLocal() {
    return float("GATE_SIMILARITY_THRESHOLD_LOCAL", 0.72);
  },
  get mergeThreshold() {
    return float("GATE_MERGE_THRESHOLD", 0.06);
  },
  get mergeThresholdLocal() {
    return float("GATE_MERGE_THRESHOLD_LOCAL", 0.14);
  },
  get topK() {
    return int("GATE_TOP_K", 5);
  },
  get minConfidence() {
    return float("GATE_MIN_CONFIDENCE", 0.35);
  },

  // ── MCP ──
  get mcpUrl() {
    return str("CRDB_MCP_URL", "https://cockroachlabs.cloud/mcp");
  },
  get mcpApiKey() {
    return optional("CRDB_MCP_API_KEY");
  },
  get mcpClusterId() {
    return optional("CRDB_MCP_CLUSTER_ID");
  },
};

/** Distance thresholds calibrated for whichever embedder produced the vector. */
export function gateThresholds(source: "bedrock" | "local"): {
  adjudicate: number;
  merge: number;
} {
  return source === "bedrock"
    ? { adjudicate: env.similarityThreshold, merge: env.mergeThreshold }
    : { adjudicate: env.similarityThresholdLocal, merge: env.mergeThresholdLocal };
}

export type { Mode };
