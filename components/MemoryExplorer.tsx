"use client";

import { useCallback, useEffect, useState } from "react";
import { Database, GitBranch, Search, Sparkles } from "lucide-react";
import type { AgentMemory, ScoredMemory, TimelineEntry } from "@/lib/types";
import {
  cn,
  DistanceBar,
  EmptyState,
  Panel,
  Spinner,
  StatusPill,
  relativeTime,
} from "./ui";

interface Props {
  topics: { topic: string; total: number; active: number }[];
  threshold: number;
}

interface SearchResponse {
  mode: "semantic" | "listing";
  memories: (AgentMemory | ScoredMemory)[];
  timeline: TimelineEntry[];
  embedding?: {
    source: string;
    modelId: string;
    dimensions: number;
    latencyMs: number;
    inputTokens: number | null;
  };
  sql: string;
  error?: string;
}

const STATUSES = ["", "ACTIVE", "QUARANTINED", "SUPERSEDED"] as const;

export function MemoryExplorer({ topics, threshold }: Props) {
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (topic) params.set("topic", topic);
      if (status) params.set("status", status);
      if (topic) params.set("timeline", "1");
      params.set("limit", "20");

      const response = await fetch(`/api/memories?${params.toString()}`);
      const json = (await response.json()) as SearchResponse;
      if (!response.ok) throw new Error(json.error ?? `Search failed with ${response.status}`);
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }, [query, status, topic]);

  // Load the unfiltered listing on mount and whenever a filter changes.
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, status]);

  const memories = data?.memories ?? [];
  const isSemantic = data?.mode === "semantic";

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Panel
        eyebrow={isSemantic ? "Distributed vector search" : "Substrate listing"}
        title="Memory explorer"
        bodyClassName="p-0"
        actions={
          data?.embedding && (
            <span className="chip" title={`${data.embedding.modelId} · ${data.embedding.latencyMs}ms`}>
              <Sparkles className="h-3 w-3 text-[var(--color-brand)]" />
              {data.embedding.dimensions}-d · {data.embedding.source}
            </span>
          )
        }
      >
        <div className="space-y-3 border-b border-[var(--color-line-soft)] p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
            className="flex gap-2"
          >
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-ink-4)]" />
              <input
                className="field pl-9"
                placeholder="Search the substrate semantically — e.g. “what does Enterprise cost per seat?”"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button type="submit" disabled={loading} className="btn btn-primary">
              {loading ? <Spinner /> : <Search className="h-3.5 w-3.5" />}
              Search
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <select className="field w-auto py-1.5 text-xs" value={topic} onChange={(e) => setTopic(e.target.value)}>
              <option value="">All topics</option>
              {topics.map((t) => (
                <option key={t.topic} value={t.topic}>
                  {t.topic} ({t.total})
                </option>
              ))}
            </select>
            <div className="flex gap-1">
              {STATUSES.map((s) => (
                <button
                  key={s || "all"}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={cn(
                    "chip",
                    status === s
                      ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-ink)]"
                      : "",
                  )}
                >
                  {s || "All"}
                </button>
              ))}
            </div>
            <span className="ml-auto text-[11px] text-[var(--color-ink-4)]">
              {memories.length} result{memories.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>

        <div className="max-h-[540px] overflow-y-auto p-4">
          {error && <p className="text-[12px] text-[var(--color-conflict)]">{error}</p>}

          {!error && memories.length === 0 && !loading && (
            <EmptyState
              icon={<Database className="h-6 w-6" />}
              title="Nothing here yet"
              hint="Run `npm run db:seed`, launch a swarm, or inject a memory to populate the substrate."
            />
          )}

          <div className="space-y-2">
            {memories.map((memory) => {
              const scored = "distance" in memory ? memory : null;
              return (
                <article
                  key={memory.id}
                  className="animate-in rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3.5 py-3 transition-colors hover:border-[#2a3242]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-[13px] leading-relaxed text-[var(--color-ink)]">
                      {memory.fact_statement}
                    </p>
                    <StatusPill status={memory.status} />
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-[var(--color-ink-4)]">
                    <span className="mono text-[var(--color-ink-3)]">{memory.agent_id}</span>
                    <span className="chip py-0.5 text-[10px]">{memory.topic}</span>
                    <span title={memory.valid_from}>{relativeTime(memory.valid_from)}</span>
                    <span>conf {Number(memory.confidence_score).toFixed(2)}</span>
                    {memory.superseded_at && (
                      <span className="text-[var(--color-superseded)]">
                        superseded {relativeTime(memory.superseded_at)}
                      </span>
                    )}
                    {scored && (
                      <span className="ml-auto">
                        <DistanceBar distance={scored.distance} threshold={threshold} />
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </Panel>

      <div className="flex min-h-0 flex-col gap-4">
        <Panel eyebrow="Bi-temporal history" title={topic ? `Timeline · ${topic}` : "Belief timeline"}>
          {!topic ? (
            <EmptyState
              icon={<GitBranch className="h-5 w-5" />}
              title="Select a topic"
              hint="Pick a topic above to see how the fleet's understanding of it changed over time — and how long each version was believed."
            />
          ) : data?.timeline.length ? (
            <ol className="max-h-[300px] space-y-0 overflow-y-auto">
              {data.timeline.map((entry, i) => (
                <li key={entry.id} className="relative flex gap-3 pb-4 last:pb-0">
                  <div className="flex flex-col items-center">
                    <span
                      className={cn(
                        "mt-1 h-2 w-2 shrink-0 rounded-full ring-4 ring-[var(--color-panel)]",
                        entry.status === "ACTIVE" && "bg-[var(--color-allowed)]",
                        entry.status === "QUARANTINED" && "bg-[var(--color-conflict)]",
                        entry.status === "SUPERSEDED" && "bg-[var(--color-superseded)]",
                      )}
                    />
                    {i < data.timeline.length - 1 && (
                      <span className="mt-1 w-px flex-1 bg-[var(--color-line)]" />
                    )}
                  </div>
                  <div className="min-w-0 pb-1">
                    <p className="text-[12px] leading-relaxed text-[var(--color-ink-2)]">
                      {entry.fact_statement}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-ink-4)]">
                      <span className="mono">{entry.agent_id}</span>
                      <span>{new Date(entry.valid_from).toLocaleString()}</span>
                      <StatusPill status={entry.status} />
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="No history for this topic" />
          )}
        </Panel>

        <Panel eyebrow="Query plane" title="SQL executed">
          <pre className="mono max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-line-soft)] bg-[var(--color-void)] p-3 text-[10.5px] leading-relaxed text-[var(--color-ink-3)]">
            {data?.sql ?? "—"}
          </pre>
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-ink-4)]">
            <span className="mono text-[var(--color-ink-3)]">&lt;=&gt;</span> is CockroachDB&apos;s
            cosine-distance operator. Ordering by it lets the C-SPANN vector index serve the
            nearest-neighbour scan instead of a full table sort.
          </p>
        </Panel>
      </div>
    </div>
  );
}
