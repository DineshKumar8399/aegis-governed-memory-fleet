/**
 * Central, validated configuration. Every module reads settings from here so
 * there is exactly one place where an env var name appears.
 */

type Mode = "auto" | "live" | "mock";

/**
 * Where this process is running, so a missing-config error can name the fix that
 * actually applies. Telling someone to "copy .env.example to .env.local" is
 * useless advice on a serverless deployment, where there is no local file to
 * edit and the variable belongs in the platform's environment settings.
 */
function runtimeHint(name: string): string {
  if (process.env.VERCEL !== undefined) {
    return (
      `Set it in your Vercel project (Settings -> Environment Variables, or ` +
      `\`vercel env add ${name} production\`), then redeploy.`
    );
  }
  if (process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined) {
    return `Set it in the Lambda function's environment configuration, then redeploy.`;
  }
  return `Copy .env.example to .env.local and fill it in.`;
}

function str(name: string, fallback?: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name}. ${runtimeHint(name)}`);
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
  /**
   * Pool size per *process*, which is the subtlety on serverless.
   *
   * A long-running server has one pool, so 10 connections is one pool of 10. On
   * Vercel or Lambda every warm instance holds its own pool, so the cluster sees
   * `max × instances` — and a traffic spike that fans out to 50 instances would
   * open 500 connections against a cluster whose plan may cap far below that.
   * Exhausting the limit fails requests for everyone, including the health check.
   *
   * So the default is small where instances multiply and generous where they do
   * not. An explicit DATABASE_POOL_MAX always wins.
   */
  get databasePoolMax() {
    const serverless =
      process.env.VERCEL !== undefined || process.env.AWS_LAMBDA_FUNCTION_NAME !== undefined;
    return int("DATABASE_POOL_MAX", serverless ? 3 : 10);
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
