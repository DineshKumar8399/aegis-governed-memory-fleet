"use client";

import { useCallback, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import type { GateVerdict } from "@/lib/types";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ── Verdict vocabulary ───────────────────────────────────────────────────────
// One place defines what each verdict looks like everywhere in the UI.

export const VERDICT_META: Record<
  GateVerdict,
  { label: string; short: string; text: string; bg: string; border: string; dot: string; blurb: string }
> = {
  ALLOWED: {
    label: "Allowed",
    short: "ALLOW",
    text: "text-[var(--color-allowed)]",
    bg: "bg-[color-mix(in_srgb,var(--color-allowed)_11%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--color-allowed)_34%,transparent)]",
    dot: "bg-[var(--color-allowed)]",
    blurb: "Admitted to shared memory",
  },
  CONFLICT_REJECTED: {
    label: "Conflict rejected",
    short: "BLOCK",
    text: "text-[var(--color-conflict)]",
    bg: "bg-[color-mix(in_srgb,var(--color-conflict)_11%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--color-conflict)_34%,transparent)]",
    dot: "bg-[var(--color-conflict)]",
    blurb: "Quarantined — contradicts an established fact",
  },
  SUPERSEDED: {
    label: "Superseded",
    short: "SUPER",
    text: "text-[var(--color-superseded)]",
    bg: "bg-[color-mix(in_srgb,var(--color-superseded)_11%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--color-superseded)_34%,transparent)]",
    dot: "bg-[var(--color-superseded)]",
    blurb: "Replaced a prior belief",
  },
  MERGED: {
    label: "Merged",
    short: "MERGE",
    text: "text-[var(--color-merged)]",
    bg: "bg-[color-mix(in_srgb,var(--color-merged)_11%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--color-merged)_34%,transparent)]",
    dot: "bg-[var(--color-merged)]",
    blurb: "Duplicate — no new row written",
  },
};

export function VerdictBadge({
  verdict,
  size = "md",
}: {
  verdict: GateVerdict;
  size?: "sm" | "md";
}) {
  const meta = VERDICT_META[verdict];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border font-semibold uppercase tracking-wider",
        meta.bg,
        meta.border,
        meta.text,
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-[11px]",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} />
      {meta.short}
    </span>
  );
}

export const STATUS_META: Record<string, { text: string; bg: string; border: string }> = {
  ACTIVE: {
    text: "text-[var(--color-allowed)]",
    bg: "bg-[color-mix(in_srgb,var(--color-allowed)_10%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--color-allowed)_30%,transparent)]",
  },
  QUARANTINED: {
    text: "text-[var(--color-conflict)]",
    bg: "bg-[color-mix(in_srgb,var(--color-conflict)_10%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--color-conflict)_30%,transparent)]",
  },
  SUPERSEDED: {
    text: "text-[var(--color-superseded)]",
    bg: "bg-[color-mix(in_srgb,var(--color-superseded)_10%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--color-superseded)_30%,transparent)]",
  },
};

export function StatusPill({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? {
    text: "text-[var(--color-ink-3)]",
    bg: "bg-[var(--color-panel-2)]",
    border: "border-[var(--color-line)]",
  };
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        meta.bg,
        meta.border,
        meta.text,
      )}
    >
      {status}
    </span>
  );
}

// ── Layout primitives ────────────────────────────────────────────────────────

export function Panel({
  title,
  eyebrow,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode;
  eyebrow?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("panel flex min-h-0 flex-col overflow-hidden", className)}>
      {(title || actions || eyebrow) && (
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-line-soft)] px-4 py-3">
          <div className="min-w-0">
            {eyebrow && <div className="eyebrow mb-0.5">{eyebrow}</div>}
            {title && (
              <h2 className="truncate text-[13px] font-semibold text-[var(--color-ink)]">{title}</h2>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn("min-h-0 flex-1", bodyClassName ?? "p-4")}>{children}</div>
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-3.5 w-3.5 animate-spin", className)} />;
}

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 px-6 text-center">
      {icon && <div className="text-[var(--color-ink-4)]">{icon}</div>}
      <p className="text-[13px] font-medium text-[var(--color-ink-2)]">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-[var(--color-ink-4)]">{hint}</p>}
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* Clipboard is unavailable over plain http on some hosts — ignore. */
    }
  }, [value]);

  return (
    <button type="button" onClick={copy} className="btn px-2 py-1 text-[11px]">
      {copied ? <Check className="h-3 w-3 text-[var(--color-allowed)]" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

// ── Data display ─────────────────────────────────────────────────────────────

/** A distance meter: 0 (identical) on the left, threshold marked. */
export function DistanceBar({
  distance,
  threshold,
}: {
  distance: number;
  threshold?: number;
}) {
  const max = 1;
  const pct = Math.max(2, Math.min(100, (distance / max) * 100));
  const inRange = threshold !== undefined && distance <= threshold;

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 w-20 overflow-hidden rounded-full bg-[var(--color-panel-3)]">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            inRange ? "bg-[var(--color-conflict)]" : "bg-[var(--color-brand)]",
          )}
          style={{ width: `${pct}%` }}
        />
        {threshold !== undefined && (
          <div
            className="absolute top-0 h-full w-px bg-[var(--color-ink-3)]"
            style={{ left: `${Math.min(100, (threshold / max) * 100)}%` }}
            title={`Adjudication threshold ${threshold}`}
          />
        )}
      </div>
      <span className="mono text-[11px] tabular-nums text-[var(--color-ink-3)]">
        {distance.toFixed(4)}
      </span>
    </div>
  );
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "--:--:--";
}
