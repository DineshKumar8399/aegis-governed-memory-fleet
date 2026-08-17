"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, ShieldCheck, Users } from "lucide-react";
import type { AgentTrustScore, AuditLog } from "@/lib/types";
import {
  cn,
  EmptyState,
  Panel,
  Spinner,
  VerdictBadge,
  VERDICT_META,
  relativeTime,
} from "./ui";

const FILTERS = ["", "ALLOWED", "CONFLICT_REJECTED", "SUPERSEDED", "MERGED"] as const;
const POLL_MS = 4000;

export function GatekeeperFeed({ refreshKey }: { refreshKey: number }) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [trust, setTrust] = useState<AgentTrustScore[]>([]);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("");
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "60" });
      if (filter) params.set("verdict", filter);
      const response = await fetch(`/api/audit-logs?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error ?? `Feed failed with ${response.status}`);
      if (!mounted.current) return;
      setLogs(data.logs ?? []);
      setTrust(data.agentTrust ?? []);
      setError(null);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Feed failed.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Poll while live so swarm runs and other clients show up without a reload.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [live, load]);

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Panel
        eyebrow="Immutable decision stream"
        title="Gatekeeper audit"
        bodyClassName="p-0"
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setLive((v) => !v)}
              className={cn("chip", live && "border-[var(--color-brand)] text-[var(--color-ink)]")}
              title={live ? "Pause polling" : "Resume polling"}
            >
              {live ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {live ? "Live" : "Paused"}
            </button>
            {loading && <Spinner className="text-[var(--color-ink-4)]" />}
          </div>
        }
      >
        <div className="flex flex-wrap gap-1.5 border-b border-[var(--color-line-soft)] p-3">
          {FILTERS.map((f) => (
            <button
              key={f || "all"}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "chip",
                filter === f && "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-ink)]",
                f && VERDICT_META[f].text,
              )}
            >
              {f ? VERDICT_META[f].label : "All decisions"}
            </button>
          ))}
        </div>

        <div className="max-h-[560px] overflow-y-auto p-3">
          {error && <p className="p-3 text-[12px] text-[var(--color-conflict)]">{error}</p>}

          {!error && logs.length === 0 && !loading && (
            <EmptyState
              icon={<ShieldCheck className="h-6 w-6" />}
              title="No decisions recorded"
              hint="Every adjudication the gate makes — allowed or blocked — is written here in the same transaction as the memory row it governs."
            />
          )}

          <div className="space-y-1.5">
            {logs.map((log) => {
              const open = expanded === log.id;
              return (
                <button
                  key={log.id}
                  type="button"
                  onClick={() => setExpanded(open ? null : log.id)}
                  className={cn(
                    "animate-in block w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
                    VERDICT_META[log.gatekeeper_verdict].bg,
                    open ? "border-[#2a3242]" : "border-[var(--color-line)]",
                    "hover:border-[#2a3242]",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <VerdictBadge verdict={log.gatekeeper_verdict} size="sm" />
                    <span className="mono text-[11px] text-[var(--color-ink-2)]">{log.agent_id ?? "—"}</span>
                    {log.topic && <span className="chip py-0.5 text-[10px]">{log.topic}</span>}
                    <span className="ml-auto text-[10px] text-[var(--color-ink-4)]" title={log.created_at}>
                      {relativeTime(log.created_at)}
                    </span>
                  </div>

                  <p
                    className={cn(
                      "mt-1.5 text-[12px] leading-relaxed text-[var(--color-ink)]",
                      !open && "line-clamp-2",
                    )}
                  >
                    {log.incoming_fact}
                  </p>

                  <p
                    className={cn(
                      "mt-1.5 border-l-2 border-[var(--color-line)] pl-2.5 text-[11px] leading-relaxed text-[var(--color-ink-3)]",
                      !open && "line-clamp-2",
                    )}
                  >
                    {log.reasoning}
                  </p>

                  {open && (
                    <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-[var(--color-ink-4)]">
                      <Meta label="Evaluator" value={log.evaluator ?? "—"} />
                      <Meta label="Model" value={log.model_id ?? "—"} />
                      <Meta
                        label="Nearest distance"
                        value={log.nearest_distance === null ? "—" : log.nearest_distance.toFixed(4)}
                      />
                      <Meta label="Latency" value={log.latency_ms === null ? "—" : `${log.latency_ms}ms`} />
                      <Meta
                        label="Conflicting row"
                        value={log.conflicting_memory_id?.slice(0, 8) ?? "—"}
                      />
                      <Meta label="Resulting row" value={log.resulting_memory_id?.slice(0, 8) ?? "—"} />
                    </dl>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </Panel>

      <Panel eyebrow="Fleet reliability" title="Agent trust scores">
        {trust.length === 0 ? (
          <EmptyState icon={<Users className="h-5 w-5" />} title="No agent activity yet" />
        ) : (
          <div className="max-h-[560px] space-y-2.5 overflow-y-auto">
            {trust.map((agent) => {
              const rate = agent.acceptance_rate_pct ?? 0;
              const tone =
                rate >= 90
                  ? "var(--color-allowed)"
                  : rate >= 65
                    ? "var(--color-superseded)"
                    : "var(--color-conflict)";
              return (
                <div key={agent.agent_id} className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="mono truncate text-[11px] text-[var(--color-ink-2)]">
                      {agent.agent_id}
                    </span>
                    <span className="mono shrink-0 text-[11px] tabular-nums" style={{ color: tone }}>
                      {rate.toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-panel-3)]">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${Math.max(2, rate)}%`, background: tone }}
                    />
                  </div>
                  <div className="flex gap-3 text-[10px] text-[var(--color-ink-4)]">
                    <span>{agent.total_submissions} submitted</span>
                    <span className="text-[var(--color-allowed)]">{agent.active_facts} active</span>
                    {agent.quarantined_facts > 0 && (
                      <span className="text-[var(--color-conflict)]">
                        {agent.quarantined_facts} blocked
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            <p className="hairline pt-3 text-[10px] leading-relaxed text-[var(--color-ink-4)]">
              Acceptance rate is the share of an agent&apos;s submissions that were not quarantined.
              A falling score is the fleet&apos;s early warning that an agent has started drifting.
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-[var(--color-line-soft)] pb-1">
      <dt className="shrink-0">{label}</dt>
      <dd className="mono truncate text-right text-[var(--color-ink-3)]" title={value}>
        {value}
      </dd>
    </div>
  );
}
