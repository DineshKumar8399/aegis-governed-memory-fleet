"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Ban,
  BrainCircuit,
  Database,
  Layers,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Terminal,
  Zap,
} from "lucide-react";
import { GatekeeperFeed } from "@/components/GatekeeperFeed";
import { InjectForm } from "@/components/InjectForm";
import { McpInspector } from "@/components/McpInspector";
import { MemoryExplorer } from "@/components/MemoryExplorer";
import { SwarmConsole } from "@/components/SwarmConsole";
import { Spinner, cn } from "@/components/ui";
import type { FleetStats } from "@/lib/types";

type DependencyState = "live" | "unverified" | "fallback" | "mock";

interface HealthPayload {
  status: string;
  database: { ok: boolean; version: string | null; supportsVector?: boolean; latencyMs: number; error?: string };
  bedrock: {
    state: DependencyState;
    live: boolean;
    mode: string;
    reason: string | null;
    region: string;
    llmModelId: string;
    embeddingModelId: string;
  };
  s3: { state: DependencyState; live: boolean; mode: string; bucket: string; reason: string | null };
  config: { similarityThreshold: number; topK: number; minConfidence: number; embeddingDim: number; region: string };
}

interface StatsPayload {
  stats: FleetStats;
  topics: { topic: string; total: number; active: number }[];
}

const TABS = [
  { id: "swarm", label: "Swarm console", icon: Terminal },
  { id: "inject", label: "Inject memory", icon: Sparkles },
  { id: "explorer", label: "Memory explorer", icon: Database },
  { id: "audit", label: "Gatekeeper audit", icon: ScrollText },
  { id: "mcp", label: "MCP inspector", icon: ShieldCheck },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Dashboard() {
  const [tab, setTab] = useState<TabId>("swarm");
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [healthRes, statsRes] = await Promise.all([
        fetch("/api/health").then((r) => r.json()),
        fetch("/api/stats").then((r) => r.json()),
      ]);
      setHealth(healthRes as HealthPayload);
      if ((statsRes as { error?: string }).error) {
        setBootError((statsRes as { error: string }).error);
      } else {
        setStats(statsRes as StatsPayload);
        setBootError(null);
      }
    } catch (err) {
      setBootError(err instanceof Error ? err.message : "Failed to reach the API.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const bump = useCallback(() => {
    setRefreshKey((k) => k + 1);
    void refresh();
  }, [refresh]);

  const threshold = health?.config.similarityThreshold ?? 0.35;
  const topics = stats?.topics ?? [];
  const s = stats?.stats;

  return (
    <div className="min-h-screen">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-[var(--color-line)] bg-[color-mix(in_srgb,var(--color-void)_88%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-brand)] bg-[var(--color-brand-soft)]">
              <ShieldCheck className="h-4 w-4 text-[var(--color-brand)]" />
            </div>
            <div className="leading-tight">
              <h1 className="text-[15px] font-semibold tracking-tight text-[var(--color-ink)]">
                Aegis
              </h1>
              <p className="text-[10px] text-[var(--color-ink-4)]">Governed Memory Fleet</p>
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <StatusChip
              state={health ? (health.database.ok ? "live" : "fallback") : "unverified"}
              label="CockroachDB"
              downIsError
              detail={
                health?.database.ok
                  ? `${health.database.version ?? "connected"} · ${health.database.latencyMs}ms${
                      health.database.supportsVector ? " · vector" : ""
                    }`
                  : (health?.database.error ?? "unreachable")
              }
            />
            <StatusChip
              state={health?.bedrock.state ?? "unverified"}
              label="Bedrock"
              detail={
                health?.bedrock.state === "live"
                  ? `${health.bedrock.llmModelId} · ${health.bedrock.region}`
                  : health?.bedrock.state === "unverified"
                    ? `configured, not yet called · ${health.bedrock.llmModelId}`
                    : `local gatekeeper${health?.bedrock.reason ? ` · ${health.bedrock.reason}` : ""}`
              }
            />
            <StatusChip
              state={health?.s3.state ?? "unverified"}
              label="S3"
              detail={
                health?.s3.state === "live"
                  ? health.s3.bucket
                  : health?.s3.state === "unverified"
                    ? `configured, nothing uploaded yet · ${health.s3.bucket}`
                    : "provenance URIs minted, documents not uploaded"
              }
            />
            <button onClick={bump} disabled={refreshing} className="btn px-2.5 py-1.5" title="Refresh">
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-5 pb-16 pt-5">
        {bootError && (
          <div className="mb-5 rounded-lg border border-[color-mix(in_srgb,var(--color-conflict)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-conflict)_9%,transparent)] px-4 py-3">
            <p className="text-[13px] font-medium text-[var(--color-conflict)]">
              Cannot reach the memory substrate
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-ink-3)]">{bootError}</p>
            <p className="mono mt-2 text-[11px] text-[var(--color-ink-4)]">
              npm run doctor — diagnoses connection, schema and model-access problems.
            </p>
          </div>
        )}

        {/* ── KPI row ───────────────────────────────────────────────────── */}
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <StatTile
            icon={Layers}
            label="Active beliefs"
            value={s?.activeMemories}
            hint={s ? `${s.totalMemories} rows total` : undefined}
            tone="allowed"
          />
          <StatTile
            icon={Ban}
            label="Quarantined"
            value={s?.quarantinedMemories}
            hint={s ? `${s.conflictBlockRatePct}% of decisions blocked` : undefined}
            tone="conflict"
          />
          <StatTile
            icon={Shuffle}
            label="Superseded"
            value={s?.supersededMemories}
            hint="prior beliefs replaced"
            tone="superseded"
          />
          <StatTile
            icon={Activity}
            label="Gate decisions"
            value={s?.totalDecisions}
            hint={s?.avgGateLatencyMs ? `${s.avgGateLatencyMs}ms avg adjudication` : "no decisions yet"}
          />
          <StatTile
            icon={BrainCircuit}
            label="Agents"
            value={s?.distinctAgents}
            hint={s ? `${s.distinctTopics} topic domains` : undefined}
          />
          <StatTile
            icon={Zap}
            label="Vector width"
            value={health?.config.embeddingDim}
            hint={health ? `top-${health.config.topK} · θ ${health.config.similarityThreshold}` : undefined}
            tone="brand"
          />
        </div>

        {/* ── Tabs ──────────────────────────────────────────────────────── */}
        <nav className="mb-4 flex flex-wrap gap-1.5" aria-label="Sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] font-medium transition-colors",
                tab === id
                  ? "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-ink)]"
                  : "border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-ink-3)] hover:border-[#2a3242] hover:text-[var(--color-ink-2)]",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </nav>

        {tab === "swarm" && <SwarmConsole onComplete={bump} />}
        {tab === "inject" && <InjectForm topics={topics} threshold={threshold} onSubmitted={bump} />}
        {tab === "explorer" && <MemoryExplorer topics={topics} threshold={threshold} />}
        {tab === "audit" && <GatekeeperFeed refreshKey={refreshKey} />}
        {tab === "mcp" && <McpInspector />}

        <footer className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--color-line-soft)] pt-4 text-[10.5px] text-[var(--color-ink-4)]">
          <span>
            CockroachDB — distributed <span className="mono">VECTOR</span> indexing (C-SPANN, cosine)
            + serializable write-gate transactions + Cloud MCP audit plane
          </span>
          <span className="text-[var(--color-line)]">|</span>
          <span>
            AWS — Bedrock (Titan Embeddings V2 · Claude adjudication) + S3 provenance + Lambda /
            API Gateway handlers
          </span>
        </footer>
      </main>
    </div>
  );
}

function StatusChip({
  state,
  label,
  detail,
  downIsError,
}: {
  state: DependencyState;
  label: string;
  detail: string;
  /** A missing database is fatal; a missing model endpoint only degrades. */
  downIsError?: boolean;
}) {
  const tone =
    state === "live"
      ? "var(--color-allowed)"
      : state === "unverified"
        ? "var(--color-ink-3)"
        : downIsError
          ? "var(--color-conflict)"
          : "var(--color-superseded)";

  return (
    <span className="chip" title={`${state} — ${detail}`}>
      <span
        className={cn("h-1.5 w-1.5 rounded-full", state === "live" && "animate-pulse-slow")}
        style={{ background: tone }}
      />
      <span className="text-[var(--color-ink-2)]">{label}</span>
      <span className="hidden max-w-[190px] truncate text-[var(--color-ink-4)] xl:inline">
        {detail}
      </span>
    </span>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Activity;
  label: string;
  value: number | undefined;
  hint?: string;
  tone?: "allowed" | "conflict" | "superseded" | "brand";
}) {
  const colour =
    tone === "allowed"
      ? "var(--color-allowed)"
      : tone === "conflict"
        ? "var(--color-conflict)"
        : tone === "superseded"
          ? "var(--color-superseded)"
          : tone === "brand"
            ? "var(--color-brand)"
            : "var(--color-ink-2)";

  return (
    <div className="panel px-3.5 py-3">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5" style={{ color: colour }} />
        <span className="eyebrow">{label}</span>
      </div>
      <div className="mt-1.5 text-[26px] font-semibold leading-none tabular-nums" style={{ color: colour }}>
        {value === undefined ? <Spinner className="h-4 w-4 text-[var(--color-ink-4)]" /> : value}
      </div>
      {hint && <p className="mt-1.5 truncate text-[10.5px] text-[var(--color-ink-4)]">{hint}</p>}
    </div>
  );
}
