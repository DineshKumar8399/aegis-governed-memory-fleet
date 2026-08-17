/**
 * Amazon S3 provenance store.
 *
 * Every fact that reaches the Write-Gate gets its raw source document archived
 * to S3 first; the resulting `s3://` URI is stored on the memory row as
 * `source_s3_uri`. That makes every belief in the substrate traceable back to
 * the bytes it was derived from — the audit plane can answer "why did the fleet
 * believe this?" without trusting the agent's own summary.
 *
 * When S3 is unreachable and AEGIS_S3_MODE=auto, we still mint a deterministic
 * URI so the provenance chain is unbroken and the demo keeps running; the audit
 * record makes the difference visible via the `stored` flag.
 */

import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./env";

let client: S3Client | undefined;
let liveDisabledReason: string | null = null;
let liveConfirmed = false;

function getClient(): S3Client {
  if (!client) {
    client = new S3Client({ region: env.awsRegion, maxAttempts: 3 });
  }
  return client;
}

/** Same three-valued honesty as Bedrock — see `BedrockState`. */
export type S3State = "live" | "unverified" | "fallback" | "mock";

export function s3Availability(): {
  mode: string;
  state: S3State;
  live: boolean;
  reason: string | null;
  bucket: string;
} {
  const mode = env.s3Mode;
  const state: S3State =
    mode === "mock"
      ? "mock"
      : liveDisabledReason !== null
        ? "fallback"
        : liveConfirmed
          ? "live"
          : "unverified";

  return {
    mode,
    state,
    live: state === "live",
    reason:
      mode === "mock"
        ? "AEGIS_S3_MODE=mock"
        : (liveDisabledReason ?? (state === "unverified" ? "no upload attempted yet" : null)),
    bucket: env.s3Bucket,
  };
}

/** Content-addressed key so identical source documents dedupe naturally. */
function provenanceKey(agentId: string, topic: string, body: string): string {
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const safeAgent = agentId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeTopic = topic.replace(/[^a-zA-Z0-9._-]/g, "_");
  const day = new Date().toISOString().slice(0, 10);
  return `${env.s3Prefix}${day}/${safeTopic}/${safeAgent}-${digest}.json`;
}

export interface ProvenanceRecord {
  uri: string;
  key: string;
  bucket: string;
  stored: boolean;
  reason?: string;
}

export async function archiveProvenance(args: {
  agentId: string;
  topic: string;
  fact: string;
  rawDocument?: string;
  confidence: number;
}): Promise<ProvenanceRecord> {
  const body = JSON.stringify(
    {
      agentId: args.agentId,
      topic: args.topic,
      fact: args.fact,
      confidence: args.confidence,
      rawDocument: args.rawDocument ?? args.fact,
      capturedAt: new Date().toISOString(),
      schema: "aegis.provenance.v1",
    },
    null,
    2,
  );

  const bucket = env.s3Bucket;
  const key = provenanceKey(args.agentId, args.topic, body);
  const uri = `s3://${bucket}/${key}`;

  if (env.s3Mode === "mock" || liveDisabledReason !== null) {
    return {
      uri,
      key,
      bucket,
      stored: false,
      reason: liveDisabledReason ?? "AEGIS_S3_MODE=mock",
    };
  }

  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        Metadata: {
          "aegis-agent": args.agentId.slice(0, 128),
          "aegis-topic": args.topic.slice(0, 128),
        },
      }),
    );
    liveConfirmed = true;
    return { uri, key, bucket, stored: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (env.s3Mode === "live") {
      throw new Error(`S3 provenance write failed (AEGIS_S3_MODE=live): ${message}`);
    }
    if (liveDisabledReason === null) {
      liveDisabledReason = message;
      console.warn(`[s3] provenance archiving disabled — ${message}`);
    }
    return { uri, key, bucket, stored: false, reason: message };
  }
}

/** Reads a provenance object back — used by the audit inspector. */
export async function fetchProvenance(uri: string): Promise<string | null> {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  if (env.s3Mode === "mock" || liveDisabledReason !== null) return null;

  try {
    const response = await getClient().send(
      new GetObjectCommand({ Bucket: match[1], Key: match[2] }),
    );
    return (await response.Body?.transformToString()) ?? null;
  } catch {
    return null;
  }
}
