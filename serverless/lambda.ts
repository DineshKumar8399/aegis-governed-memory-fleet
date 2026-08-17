/**
 * AWS Lambda handler — the same Write-Gate, behind API Gateway.
 *
 * The Next.js route handlers and this Lambda share `lib/writeGate.ts` verbatim;
 * only the transport differs. That is deliberate: the dashboard is a control
 * plane for humans, but a production agent fleet posts to an API Gateway
 * endpoint, and both must adjudicate identically.
 *
 * Routes (HTTP API v2 payload format, `$default` integration):
 *   POST /memory/submit
 *   GET  /memories
 *   GET  /audit-logs
 *   POST /simulate-swarm
 *   GET  /health
 *
 * Build:  npx esbuild serverless/lambda.ts --bundle --platform=node \
 *           --target=node20 --format=cjs --outfile=dist/lambda.js \
 *           --external:@aws-sdk/*
 * Deploy: sam deploy --guided  (see serverless/template.yaml)
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
import { processMemorySubmission, SubmissionError } from "../lib/writeGate";
import { listMemories, listTopics, semanticSearch } from "../lib/vector";
import { getAuditLogs, getFleetStats } from "../lib/stats";
import { runSwarm } from "../lib/swarm";
import { bedrockAvailability, embedText } from "../lib/bedrock";
import { probeDatabase } from "../lib/db";
import { s3Availability } from "../lib/s3";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

function reply(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function parseBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) return {} as T;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return raw.trim().length === 0 ? ({} as T) : (JSON.parse(raw) as T);
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> => {
  // The pg pool is kept warm across invocations; do not wait for it to drain.
  context.callbackWaitsForEmptyEventLoop = false;

  const method = event.requestContext?.http?.method ?? "GET";
  const rawPath = event.rawPath ?? "/";
  const path = rawPath.replace(/\/+$/, "") || "/";
  const q = event.queryStringParameters ?? {};

  try {
    if (method === "GET" && (path === "/health" || path === "/")) {
      const database = await probeDatabase();
      return reply(database.ok ? 200 : 503, {
        status: database.ok ? "ok" : "degraded",
        database,
        bedrock: bedrockAvailability(),
        s3: s3Availability(),
        requestId: context.awsRequestId,
      });
    }

    if (method === "POST" && path === "/memory/submit") {
      const body = parseBody<Parameters<typeof processMemorySubmission>[0]>(event);
      const result = await processMemorySubmission(body);
      return reply(result.verdict === "CONFLICT_REJECTED" ? 202 : 201, result);
    }

    if (method === "GET" && path === "/memories") {
      const limit = num(q.limit, 50);
      if (q.q && q.q.trim().length > 0) {
        const embedding = await embedText(q.q.trim());
        const memories = await semanticSearch({
          embedding: embedding.vector,
          topic: q.topic,
          status: q.status?.toUpperCase(),
          limit,
        });
        return reply(200, { mode: "semantic", count: memories.length, memories });
      }
      const memories = await listMemories({
        status: q.status?.toUpperCase(),
        topic: q.topic,
        agentId: q.agentId,
        limit,
      });
      return reply(200, {
        mode: "listing",
        count: memories.length,
        memories,
        topics: await listTopics(),
      });
    }

    if (method === "GET" && path === "/audit-logs") {
      const [logs, stats] = await Promise.all([
        getAuditLogs({
          verdict: q.verdict?.toUpperCase(),
          topic: q.topic,
          agentId: q.agentId,
          since: q.since,
          limit: num(q.limit, 50),
        }),
        getFleetStats(),
      ]);
      return reply(200, { count: logs.length, logs, stats });
    }

    if (method === "POST" && path === "/simulate-swarm") {
      // Lambda responses are not streamed here — the swarm returns the full
      // event log. Use the Next.js NDJSON route for a live console.
      const body = parseBody<{ scenarioId?: string; agentCount?: number }>(event);
      const events = await runSwarm(body);
      return reply(200, { events, gatekeeper: bedrockAvailability() });
    }

    return reply(404, { error: `No route for ${method} ${path}` });
  } catch (err) {
    if (err instanceof SubmissionError) {
      return reply(400, { error: err.message });
    }
    if (err instanceof SyntaxError) {
      return reply(400, { error: "Request body must be valid JSON." });
    }
    console.error("[lambda]", err);
    return reply(500, {
      error: err instanceof Error ? err.message : "Internal error.",
      requestId: context.awsRequestId,
    });
  }
};
