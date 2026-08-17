"use client";

import { useCallback, useState } from "react";
import { FlaskConical, Send } from "lucide-react";
import type { GateResult } from "@/lib/types";
import {
  cn,
  DistanceBar,
  Panel,
  Spinner,
  StatusPill,
  VerdictBadge,
  VERDICT_META,
} from "./ui";

interface Props {
  topics: { topic: string; total: number; active: number }[];
  threshold: number;
  onSubmitted: () => void;
}

const PRESETS = [
  {
    label: "Contradict a belief",
    agentId: "probe-epsilon",
    topic: "pricing-model",
    confidence: 0.7,
    fact: "Atlas Enterprise is priced at 1150 USD per seat per year with a 25 seat minimum commitment.",
  },
  {
    label: "Post a correction",
    agentId: "ledger-beta",
    topic: "pricing-model",
    confidence: 0.96,
    fact: "Corrected as of the latest rate card: Atlas Enterprise is priced at 2650 USD per seat per year with a 25 seat minimum commitment.",
  },
  {
    label: "Restate a known fact",
    agentId: "recon-alpha",
    topic: "pricing-model",
    confidence: 0.85,
    fact: "The Atlas Enterprise tier costs 2400 USD per seat annually, minimum 25 seats.",
  },
  {
    label: "Contribute something new",
    agentId: "scribe-delta",
    topic: "pricing-model",
    confidence: 0.9,
    fact: "Atlas Enterprise contracts include a 99.95 percent uptime SLA with service credits capped at 20 percent of monthly fees.",
  },
];

export function InjectForm({ topics, threshold, onSubmitted }: Props) {
  const [agentId, setAgentId] = useState("analyst-zeta");
  const [topic, setTopic] = useState(topics[0]?.topic ?? "pricing-model");
  const [fact, setFact] = useState("");
  const [confidence, setConfidence] = useState(0.85);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GateResult | null>(null);

  const applyPreset = useCallback((preset: (typeof PRESETS)[number]) => {
    setAgentId(preset.agentId);
    setTopic(preset.topic);
    setFact(preset.fact);
    setConfidence(preset.confidence);
    setResult(null);
    setError(null);
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy || fact.trim().length === 0) return;

      setBusy(true);
      setError(null);
      setResult(null);

      try {
        const response = await fetch("/api/memory/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: agentId.trim(),
            topic: topic.trim(),
            fact: fact.trim(),
            confidence,
          }),
        });
        const data = await response.json();

        if (!response.ok && response.status !== 202) {
          throw new Error(data?.error ?? `Submission failed with ${response.status}`);
        }
        setResult(data as GateResult);
        onSubmitted();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Submission failed.");
      } finally {
        setBusy(false);
      }
    },
    [agentId, busy, confidence, fact, onSubmitted, topic],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel eyebrow="Manual agent" title="Inject a memory">
        <form onSubmit={submit} className="space-y-3.5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="agentId" className="eyebrow mb-1.5 block">
                Agent ID
              </label>
              <input
                id="agentId"
                className="field mono"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                maxLength={64}
                required
              />
            </div>
            <div>
              <label htmlFor="topic" className="eyebrow mb-1.5 block">
                Topic domain
              </label>
              <input
                id="topic"
                className="field mono"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                list="topic-options"
                maxLength={64}
                required
              />
              <datalist id="topic-options">
                {topics.map((t) => (
                  <option key={t.topic} value={t.topic} />
                ))}
              </datalist>
            </div>
          </div>

          <div>
            <label htmlFor="fact" className="eyebrow mb-1.5 block">
              Fact statement
            </label>
            <textarea
              id="fact"
              className="field min-h-[104px] resize-y leading-relaxed"
              value={fact}
              onChange={(e) => setFact(e.target.value)}
              placeholder="State one atomic, checkable claim. The gate adjudicates it against everything already believed in this topic."
              maxLength={4000}
              required
            />
            <div className="mt-1 text-right text-[10px] text-[var(--color-ink-4)]">
              {fact.length}/4000
            </div>
          </div>

          <div>
            <label htmlFor="confidence" className="eyebrow mb-1.5 flex items-center justify-between">
              <span>Self-reported confidence</span>
              <span className="mono text-[var(--color-ink-2)]">{confidence.toFixed(2)}</span>
            </label>
            <input
              id="confidence"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={confidence}
              onChange={(e) => setConfidence(Number(e.target.value))}
              className="w-full accent-[var(--color-brand)]"
            />
            <p className="mt-1 text-[10px] text-[var(--color-ink-4)]">
              Below the fleet floor, the gate quarantines without spending a model call.
            </p>
          </div>

          <button type="submit" disabled={busy || fact.trim().length === 0} className="btn btn-primary w-full">
            {busy ? <Spinner /> : <Send className="h-3.5 w-3.5" />}
            {busy ? "Adjudicating…" : "Submit to the write-gate"}
          </button>
        </form>

        <div className="hairline mt-4 pt-3">
          <div className="eyebrow mb-2 flex items-center gap-1.5">
            <FlaskConical className="h-3 w-3" />
            Try one
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => applyPreset(preset)}
                className="chip hover:border-[var(--color-brand)] hover:text-[var(--color-ink)]"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </Panel>

      <Panel eyebrow="Adjudication" title="Gate response" bodyClassName="p-0">
        <div className="max-h-[620px] overflow-y-auto p-4">
          {error && (
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-conflict)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-conflict)_10%,transparent)] px-3 py-2.5 text-[12px] text-[var(--color-conflict)]">
              {error}
            </div>
          )}

          {!error && !result && (
            <div className="flex h-[280px] flex-col items-center justify-center gap-2 text-center">
              <p className="text-[13px] font-medium text-[var(--color-ink-2)]">No submission yet</p>
              <p className="max-w-xs text-xs leading-relaxed text-[var(--color-ink-4)]">
                The verdict, the reasoning that produced it, and every neighbouring belief the gate
                retrieved will appear here.
              </p>
            </div>
          )}

          {result && <GateResponse result={result} threshold={threshold} />}
        </div>
      </Panel>
    </div>
  );
}

function GateResponse({ result, threshold }: { result: GateResult; threshold: number }) {
  const meta = VERDICT_META[result.verdict];

  return (
    <div className="animate-in space-y-4">
      <div className={cn("rounded-lg border px-3.5 py-3", meta.bg, meta.border)}>
        <div className="flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={result.verdict} />
          <span className={cn("text-[13px] font-semibold", meta.text)}>{meta.label}</span>
          <span className="ml-auto mono text-[11px] text-[var(--color-ink-4)]">
            {result.totalMs}ms total
          </span>
        </div>
        <p className="mt-1 text-[11px] text-[var(--color-ink-3)]">{meta.blurb}</p>
        <p className="mt-2.5 text-[12px] leading-relaxed text-[var(--color-ink-2)]">
          {result.reasoning}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
        <Row label="Evaluator" value={result.evaluator} />
        <Row label="Model" value={result.modelId ?? "—"} mono />
        <Row label="Adjudication" value={`${result.latencyMs}ms`} />
        <Row
          label="40001 retries"
          value={String(result.serializationRetries)}
          highlight={result.serializationRetries > 0}
        />
        <Row label="Audit log" value={result.auditLogId.slice(0, 8)} mono />
        <Row label="Memory row" value={result.memory ? result.memory.id.slice(0, 8) : "none written"} mono />
      </dl>

      {result.memory && (
        <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 py-2.5">
          <div className="eyebrow mb-1.5 flex items-center justify-between">
            <span>Row written</span>
            <StatusPill status={result.memory.status} />
          </div>
          <p className="text-[12px] leading-relaxed text-[var(--color-ink-2)]">
            {result.memory.fact_statement}
          </p>
          <p className="mono mt-1.5 truncate text-[10px] text-[var(--color-ink-4)]">
            {result.memory.source_s3_uri}
          </p>
        </div>
      )}

      {result.conflictingMemory && (
        <div className="rounded-lg border border-[color-mix(in_srgb,var(--color-superseded)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-superseded)_8%,transparent)] px-3 py-2.5">
          <div className="eyebrow mb-1.5 text-[var(--color-superseded)]">
            {result.verdict === "SUPERSEDED" ? "Belief it replaced" : "Belief it clashed with"}
          </div>
          <p className="text-[12px] leading-relaxed text-[var(--color-ink-2)]">
            {result.conflictingMemory.fact_statement}
          </p>
          <div className="mt-2 flex items-center gap-3 text-[10px] text-[var(--color-ink-4)]">
            <span className="mono">{result.conflictingMemory.agent_id}</span>
            <DistanceBar distance={result.conflictingMemory.distance} threshold={threshold} />
          </div>
        </div>
      )}

      {result.neighbours.length > 0 && (
        <div>
          <div className="eyebrow mb-2">
            Nearest beliefs retrieved ({result.neighbours.length})
          </div>
          <div className="space-y-1.5">
            {result.neighbours.map((n) => (
              <div
                key={n.id}
                className="rounded-md border border-[var(--color-line-soft)] bg-[var(--color-void)] px-2.5 py-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-[11px] leading-relaxed text-[var(--color-ink-3)]">
                    {n.fact_statement}
                  </p>
                  <StatusPill status={n.status} />
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="mono text-[10px] text-[var(--color-ink-4)]">{n.agent_id}</span>
                  <DistanceBar distance={n.distance} threshold={threshold} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-ink-4)]">
            The marker on each bar is the adjudication threshold ({threshold}). Beliefs left of it
            are sent to the gatekeeper; anything to the right is too semantically distant to conflict.
          </p>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-[var(--color-line-soft)] pb-1.5">
      <dt className="shrink-0 text-[var(--color-ink-4)]">{label}</dt>
      <dd
        className={cn(
          "truncate text-right",
          mono && "mono",
          highlight ? "text-[var(--color-superseded)]" : "text-[var(--color-ink-2)]",
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
