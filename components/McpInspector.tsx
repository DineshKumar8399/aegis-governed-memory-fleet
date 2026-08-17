"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock, Play, Plug, Table2, Terminal } from "lucide-react";
import { CopyButton, EmptyState, Panel, Spinner, cn } from "./ui";

interface ToolSpec {
  name: string;
  description: string;
  requiresArg: boolean;
  argLabel: string | null;
  mayBeRestricted: boolean;
  sql: string;
}

interface Catalogue {
  mcp: {
    endpoint: string;
    transport: string;
    authMode: string;
    clusterScoped: boolean;
    json: unknown;
    cli: string;
    readOnlyByDefault: boolean;
    note: string;
  };
  tools: ToolSpec[];
  upstreamReadOnlyTools: string[];
}

interface ExecResult {
  tool: string;
  sql: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  latencyMs?: number;
  error?: string;
  hint?: string;
}

export function McpInspector() {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [selected, setSelected] = useState<string>("list_tables");
  const [arg, setArg] = useState("agent_memories");
  const [sql, setSql] = useState(
    "SELECT topic, status, count(*) AS n\nFROM agent_memories\nGROUP BY topic, status\nORDER BY topic",
  );
  const [tab, setTab] = useState<"tools" | "sql">("tools");
  const [result, setResult] = useState<ExecResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/mcp/inspect")
      .then((r) => r.json())
      .then(setCatalogue)
      .catch(() => undefined);
  }, []);

  const execute = useCallback(
    async (payload: { tool?: string; arg?: string; sql?: string }) => {
      setBusy(true);
      try {
        const response = await fetch("/api/mcp/inspect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        setResult((await response.json()) as ExecResult);
      } catch (err) {
        setResult({
          tool: payload.tool ?? "select_query",
          sql: payload.sql ?? "",
          error: err instanceof Error ? err.message : "Request failed.",
        });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const tool = catalogue?.tools.find((t) => t.name === selected);
  const configJson = catalogue ? JSON.stringify(catalogue.mcp.json, null, 2) : "";

  return (
    <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-h-0 flex-col gap-4">
        <Panel
          eyebrow="Read-only audit plane"
          title="MCP inspector"
          bodyClassName="p-0"
          actions={
            <span className="chip text-[var(--color-allowed)]">
              <Lock className="h-3 w-3" />
              read-only enforced
            </span>
          }
        >
          <div className="flex gap-1 border-b border-[var(--color-line-soft)] p-3">
            <button
              type="button"
              onClick={() => setTab("tools")}
              className={cn("chip", tab === "tools" && "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-ink)]")}
            >
              <Table2 className="h-3 w-3" />
              Inspector tools
            </button>
            <button
              type="button"
              onClick={() => setTab("sql")}
              className={cn("chip", tab === "sql" && "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-ink)]")}
            >
              <Terminal className="h-3 w-3" />
              select_query
            </button>
          </div>

          <div className="space-y-3 p-4">
            {tab === "tools" ? (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {catalogue?.tools.map((t) => (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => setSelected(t.name)}
                      className={cn(
                        "chip mono",
                        selected === t.name &&
                          "border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-ink)]",
                      )}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>

                {tool && (
                  <>
                    <p className="text-[12px] leading-relaxed text-[var(--color-ink-3)]">
                      {tool.description}
                      {tool.mayBeRestricted && (
                        <span className="text-[var(--color-superseded)]">
                          {" "}
                          Not available on CockroachDB Basic clusters.
                        </span>
                      )}
                    </p>

                    {tool.requiresArg && (
                      <div>
                        <label htmlFor="tool-arg" className="eyebrow mb-1.5 block">
                          {tool.argLabel}
                        </label>
                        <input
                          id="tool-arg"
                          className="field mono"
                          value={arg}
                          onChange={(e) => setArg(e.target.value)}
                        />
                      </div>
                    )}

                    <pre className="mono overflow-x-auto rounded-md border border-[var(--color-line-soft)] bg-[var(--color-void)] p-3 text-[10.5px] leading-relaxed text-[var(--color-ink-3)]">
                      {tool.sql}
                    </pre>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => execute({ tool: tool.name, arg: tool.requiresArg ? arg : undefined })}
                      className="btn btn-primary"
                    >
                      {busy ? <Spinner /> : <Play className="h-3.5 w-3.5" />}
                      Run tool
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                <p className="text-[12px] leading-relaxed text-[var(--color-ink-3)]">
                  Arbitrary read-only SQL. Statements are allowlisted to{" "}
                  <span className="mono">SELECT</span>, <span className="mono">WITH</span>,{" "}
                  <span className="mono">SHOW</span>, <span className="mono">EXPLAIN</span> and{" "}
                  <span className="mono">TABLE</span>, then executed inside a{" "}
                  <span className="mono">SET TRANSACTION READ ONLY</span> transaction that always
                  rolls back — so the engine enforces immutability even if the allowlist were bypassed.
                </p>
                <textarea
                  className="field mono min-h-[140px] resize-y text-[12px] leading-relaxed"
                  value={sql}
                  onChange={(e) => setSql(e.target.value)}
                  spellCheck={false}
                />
                <button
                  type="button"
                  disabled={busy || sql.trim().length === 0}
                  onClick={() => execute({ sql })}
                  className="btn btn-primary"
                >
                  {busy ? <Spinner /> : <Play className="h-3.5 w-3.5" />}
                  Execute
                </button>
              </>
            )}
          </div>
        </Panel>

        <Panel eyebrow="Result set" title={result ? result.tool : "Awaiting execution"} bodyClassName="p-0">
          <div className="max-h-[320px] overflow-auto">
            {!result && (
              <EmptyState
                icon={<Table2 className="h-5 w-5" />}
                title="No query run yet"
                hint="Pick an inspector tool or write read-only SQL, then execute it against the live cluster."
              />
            )}

            {result?.error && (
              <div className="p-4">
                <p className="text-[12px] text-[var(--color-conflict)]">{result.error}</p>
                {result.hint && (
                  <p className="mt-2 text-[11px] text-[var(--color-ink-4)]">{result.hint}</p>
                )}
              </div>
            )}

            {result && !result.error && (
              <>
                <div className="flex items-center gap-3 border-b border-[var(--color-line-soft)] px-4 py-2 text-[10px] text-[var(--color-ink-4)]">
                  <span>{result.rowCount ?? 0} row(s)</span>
                  <span>{result.latencyMs}ms</span>
                  <span className="ml-auto mono truncate" title={result.sql}>
                    {result.sql.split("\n")[0].slice(0, 60)}
                  </span>
                </div>
                {result.rows && result.rows.length > 0 ? (
                  <table className="mono w-full text-[11px]">
                    <thead className="sticky top-0 bg-[var(--color-panel-2)]">
                      <tr>
                        {result.columns?.map((col) => (
                          <th
                            key={col}
                            className="whitespace-nowrap border-b border-[var(--color-line)] px-3 py-2 text-left font-semibold text-[var(--color-ink-3)]"
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((row, i) => (
                        <tr key={i} className="border-b border-[var(--color-line-soft)]">
                          {result.columns?.map((col) => (
                            <td
                              key={col}
                              className="max-w-[280px] truncate px-3 py-1.5 text-[var(--color-ink-2)]"
                              title={String(row[col] ?? "")}
                            >
                              {formatCell(row[col])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="p-4 text-[12px] text-[var(--color-ink-4)]">Query returned no rows.</p>
                )}
              </>
            )}
          </div>
        </Panel>
      </div>

      <div className="flex min-h-0 flex-col gap-4">
        <Panel
          eyebrow="CockroachDB Cloud"
          title="Managed MCP server"
          actions={configJson ? <CopyButton value={configJson} /> : undefined}
        >
          {!catalogue ? (
            <Spinner />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                <span className="chip">
                  <Plug className="h-3 w-3" />
                  {catalogue.mcp.transport}
                </span>
                <span className="chip">{catalogue.mcp.authMode}</span>
                {catalogue.mcp.clusterScoped && <span className="chip">cluster-scoped</span>}
                {catalogue.mcp.readOnlyByDefault && (
                  <span className="chip text-[var(--color-allowed)]">read-only default</span>
                )}
              </div>

              <div>
                <div className="eyebrow mb-1.5">.mcp.json / .claude.json</div>
                <pre className="mono overflow-x-auto rounded-md border border-[var(--color-line-soft)] bg-[var(--color-void)] p-3 text-[10.5px] leading-relaxed text-[var(--color-ink-3)]">
                  {configJson}
                </pre>
              </div>

              <div>
                <div className="eyebrow mb-1.5 flex items-center justify-between">
                  <span>Claude Code CLI</span>
                  <CopyButton value={catalogue.mcp.cli} label="Copy" />
                </div>
                <pre className="mono overflow-x-auto rounded-md border border-[var(--color-line-soft)] bg-[var(--color-void)] p-3 text-[10.5px] leading-relaxed text-[var(--color-ink-3)]">
                  {catalogue.mcp.cli}
                </pre>
              </div>

              <p className="text-[10px] leading-relaxed text-[var(--color-ink-4)]">
                {catalogue.mcp.note}
              </p>
            </div>
          )}
        </Panel>

        <Panel eyebrow="Upstream surface" title="Tools the managed server exposes">
          {!catalogue ? (
            <Spinner />
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {catalogue.upstreamReadOnlyTools.map((name) => (
                  <span key={name} className="chip mono text-[10px]">
                    {name}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-[10px] leading-relaxed text-[var(--color-ink-4)]">
                Write tools (<span className="mono">create_database</span>,{" "}
                <span className="mono">create_table</span>, <span className="mono">insert_rows</span>,{" "}
                <span className="mono">update_rows</span>, <span className="mono">delete_rows</span>)
                exist upstream but require explicit opt-in. Aegis never enables them: the audit plane
                must not be able to alter the record it audits.
              </p>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
