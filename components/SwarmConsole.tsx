"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Play,
  Radio,
  RotateCcw,
  Square,
  Terminal,
  Zap,
} from "lucide-react";
import type { GateResult, SwarmEvent } from "@/lib/types";

/** The stream opens with a `meta` frame, then emits SwarmEvents. */
type StreamFrame =
  | SwarmEvent
  | {
      type: "meta";
      gatekeeper: {
        state: "live" | "unverified" | "fallback" | "mock";
        llmModelId: string;
        reason: string | null;
      };
      provenance: { state: string; bucket: string };
    };
import {
  cn,
  EmptyState,
  Panel,
  Spinner,
  VerdictBadge,
  VERDICT_META,
  formatClock,
} from "./ui";

interface ScenarioSummary {
  id: string;
  title: string;
  topic: string;
  agents: { agentId: string; role: string; intent: string; fact: string; confidence: number; expectation: string }[];
}

type Line =
  | { kind: "system"; at: string; text: string; tone?: "info" | "warn" | "error" | "good" }
  | {
      kind: "verdict";
      at: string;
      agentId: string;
      intent: string;
      fact: string;
      result: GateResult;
      expectation?: string;
    };

const INTENT_LABEL: Record<string, string> = {
  anchor: "establishing baseline",
  duplicate: "restating a known fact",
  contradiction: "contradicting the baseline",
  supersession: "posting a corrected value",
  novel: "contributing new information",
  drift: "hallucinated / low-confidence",
};

export function SwarmConsole({ onComplete }: { onComplete: () => void }) {
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [scenarioId, setScenarioId] = useState<string>("");
  const [agentCount, setAgentCount] = useState(5);
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/simulate-swarm")
      .then((r) => r.json())
      .then((data: { scenarios?: ScenarioSummary[] }) => {
        if (cancelled || !data.scenarios) return;
        setScenarios(data.scenarios);
        setScenarioId((current) => current || data.scenarios![0]?.id || "");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the newest line in view while the swarm streams.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const push = useCallback((line: Line) => setLines((prev) => [...prev, line]), []);

  const scenario = scenarios.find((s) => s.id === scenarioId);

  const launch = useCallback(async () => {
    if (running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setLines([]);

    const now = () => new Date().toISOString();

    try {
      const response = await fetch("/api/simulate-swarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId, agentCount, stream: true }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail || `Swarm request failed with ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          if (part.trim().length === 0) continue;
          let event: StreamFrame;
          try {
            event = JSON.parse(part) as StreamFrame;
          } catch {
            continue;
          }

          if (event.type === "meta") {
            const gate = event.gatekeeper;
            push({
              kind: "system",
              at: now(),
              tone: gate.state === "live" ? "good" : gate.state === "unverified" ? "info" : "warn",
              text:
                gate.state === "live"
                  ? `gatekeeper online · ${gate.llmModelId}`
                  : gate.state === "unverified"
                    ? `gatekeeper configured · ${gate.llmModelId} · not yet called`
                    : `gatekeeper running on the local fallback${gate.reason ? ` · ${gate.reason}` : ""}`,
            });
            continue;
          }

          switch (event.type) {
            case "start":
              push({ kind: "system", at: now(), tone: "info", text: event.message ?? "swarm dispatched" });
              push({
                kind: "system",
                at: now(),
                tone: "info",
                text: "all agents fire concurrently — CockroachDB serialises the writes",
              });
              break;

            case "result":
              if (event.result) {
                push({
                  kind: "verdict",
                  at: now(),
                  agentId: event.agentId ?? "unknown",
                  intent: event.intent ?? "unknown",
                  fact: event.fact ?? event.result.submission.fact,
                  result: event.result,
                  expectation: scenario?.agents.find((a) => a.agentId === event.agentId && a.intent === event.intent)
                    ?.expectation,
                });
              }
              break;

            case "error":
              push({
                kind: "system",
                at: now(),
                tone: "error",
                text: `${event.agentId ?? "agent"} failed — ${event.message ?? "unknown error"}`,
              });
              break;

            case "done":
              push({
                kind: "system",
                at: now(),
                tone: "good",
                text: `run complete · ${event.total ?? 0} agents · ${event.elapsedMs ?? 0}ms wall clock`,
              });
              break;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        push({
          kind: "system",
          at: new Date().toISOString(),
          tone: "error",
          text: err instanceof Error ? err.message : "Swarm failed.",
        });
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      onComplete();
    }
  }, [agentCount, onComplete, push, running, scenario, scenarioId]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const verdictLines = lines.filter((l): l is Extract<Line, { kind: "verdict" }> => l.kind === "verdict");
  const tally = verdictLines.reduce<Record<string, number>>((acc, line) => {
    acc[line.result.verdict] = (acc[line.result.verdict] ?? 0) + 1;
    return acc;
  }, {});
  const totalRetries = verdictLines.reduce((sum, l) => sum + l.result.serializationRetries, 0);

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* ── Controls ─────────────────────────────────────────────────────── */}
      <Panel eyebrow="Fleet control" title="Swarm launcher" className="h-fit">
        <div className="space-y-4">
          <div>
            <label htmlFor="scenario" className="eyebrow mb-1.5 block">
              Scenario
            </label>
            <select
              id="scenario"
              className="field"
              value={scenarioId}
              onChange={(e) => setScenarioId(e.target.value)}
              disabled={running}
            >
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
            {scenario && (
              <p className="mt-1.5 text-[11px] text-[var(--color-ink-4)]">
                topic <span className="mono text-[var(--color-ink-3)]">{scenario.topic}</span>
              </p>
            )}
          </div>

          <div>
            <label htmlFor="agents" className="eyebrow mb-1.5 flex items-center justify-between">
              <span>Concurrent agents</span>
              <span className="mono text-[var(--color-ink-2)]">{agentCount}</span>
            </label>
            <input
              id="agents"
              type="range"
              min={1}
              max={5}
              step={1}
              value={agentCount}
              disabled={running}
              onChange={(e) => setAgentCount(Number(e.target.value))}
              className="w-full accent-[var(--color-brand)]"
            />
          </div>

          <div className="flex gap-2">
            <button onClick={launch} disabled={running || !scenarioId} className="btn btn-primary flex-1">
              {running ? <Spinner /> : <Play className="h-3.5 w-3.5" />}
              {running ? "Running" : "Launch swarm"}
            </button>
            {running ? (
              <button onClick={stop} className="btn" title="Abort">
                <Square className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                onClick={() => setLines([])}
                disabled={lines.length === 0}
                className="btn"
                title="Clear console"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {scenario && (
            <div className="hairline space-y-2 pt-3">
              <div className="eyebrow">Dispatch plan</div>
              {scenario.agents.slice(0, agentCount).map((agent) => (
                <div key={`${agent.agentId}-${agent.intent}`} className="flex items-start gap-2 text-[11px]">
                  <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-[var(--color-ink-4)]" />
                  <div className="min-w-0">
                    <div className="mono truncate text-[var(--color-ink-2)]">{agent.agentId}</div>
                    <div className="text-[var(--color-ink-4)]">
                      {INTENT_LABEL[agent.intent] ?? agent.intent} · conf{" "}
                      {agent.confidence.toFixed(2)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Panel>

      {/* ── Terminal ─────────────────────────────────────────────────────── */}
      <Panel
        eyebrow="Live gate decisions"
        title="Swarm console"
        bodyClassName="min-h-0 p-0"
        actions={
          <div className="flex items-center gap-2">
            {verdictLines.length > 0 && (
              <>
                {(Object.keys(VERDICT_META) as (keyof typeof VERDICT_META)[]).map((v) =>
                  tally[v] ? (
                    <span key={v} className={cn("chip", VERDICT_META[v].text)}>
                      <span className={cn("h-1.5 w-1.5 rounded-full", VERDICT_META[v].dot)} />
                      {tally[v]}
                    </span>
                  ) : null,
                )}
                {totalRetries > 0 && (
                  <span className="chip" title="CockroachDB SQLSTATE 40001 aborts replayed">
                    <Zap className="h-3 w-3 text-[var(--color-superseded)]" />
                    {totalRetries} retr{totalRetries === 1 ? "y" : "ies"}
                  </span>
                )}
              </>
            )}
            {running && (
              <span className="chip animate-pulse-slow text-[var(--color-brand)]">
                <Radio className="h-3 w-3" />
                streaming
              </span>
            )}
          </div>
        }
      >
        <div
          ref={logRef}
          className="mono h-[520px] overflow-y-auto px-4 py-3 text-[12px] leading-relaxed"
        >
          {lines.length === 0 ? (
            <EmptyState
              icon={<Terminal className="h-6 w-6" />}
              title="Console idle"
              hint="Launch a swarm to watch five autonomous agents write contradictory, duplicate and novel facts to the same topic simultaneously — and watch the gate adjudicate each one."
            />
          ) : (
            <div className="space-y-1.5">
              {lines.map((line, i) =>
                line.kind === "system" ? (
                  <div key={i} className="animate-in flex gap-2">
                    <span className="shrink-0 text-[var(--color-ink-4)]">{formatClock(line.at)}</span>
                    <span
                      className={cn(
                        line.tone === "error" && "text-[var(--color-conflict)]",
                        line.tone === "warn" && "text-[var(--color-superseded)]",
                        line.tone === "good" && "text-[var(--color-allowed)]",
                        (!line.tone || line.tone === "info") && "text-[var(--color-ink-3)]",
                      )}
                    >
                      {line.tone === "error" ? "✘ " : line.tone === "warn" ? "! " : "› "}
                      {line.text}
                    </span>
                  </div>
                ) : (
                  <VerdictLine key={i} line={line} />
                ),
              )}
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}

function VerdictLine({ line }: { line: Extract<Line, { kind: "verdict" }> }) {
  const { result } = line;
  const meta = VERDICT_META[result.verdict];
  const nearest = result.neighbours[0];

  return (
    <div
      className={cn(
        "animate-in rounded-lg border px-3 py-2.5",
        meta.bg,
        "border-[var(--color-line)]",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[var(--color-ink-4)]">{formatClock(line.at)}</span>
        <VerdictBadge verdict={result.verdict} size="sm" />
        <span className="font-semibold text-[var(--color-ink)]">{line.agentId}</span>
        <span className="text-[var(--color-ink-4)]">
          {INTENT_LABEL[line.intent] ?? line.intent}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-[var(--color-ink-4)]">
          {result.serializationRetries > 0 && (
            <span
              className="text-[var(--color-superseded)]"
              title="Aborted with SQLSTATE 40001 and replayed"
            >
              ↻{result.serializationRetries}
            </span>
          )}
          <span title="Adjudication latency">{result.latencyMs}ms</span>
          <span className="text-[var(--color-ink-4)]">/</span>
          <span title="Total gate time">{result.totalMs}ms</span>
        </span>
      </div>

      <p className="mt-1.5 break-words text-[var(--color-ink-2)]">{line.fact}</p>

      <p className="mt-1.5 border-l-2 border-[var(--color-line)] pl-2.5 text-[11px] leading-relaxed text-[var(--color-ink-3)]">
        {result.reasoning}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--color-ink-4)]">
        <span>
          evaluator <span className="text-[var(--color-ink-3)]">{result.evaluator}</span>
        </span>
        {result.modelId && (
          <span className="truncate">
            model <span className="text-[var(--color-ink-3)]">{result.modelId}</span>
          </span>
        )}
        {nearest && (
          <span>
            nearest <span className="text-[var(--color-ink-3)]">{nearest.distance.toFixed(4)}</span>
          </span>
        )}
        {result.conflictingMemory && (
          <span className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3 text-[var(--color-superseded)]" />
            vs {result.conflictingMemory.id.slice(0, 8)}
          </span>
        )}
        <span>
          audit <span className="text-[var(--color-ink-3)]">{result.auditLogId.slice(0, 8)}</span>
        </span>
      </div>
    </div>
  );
}
