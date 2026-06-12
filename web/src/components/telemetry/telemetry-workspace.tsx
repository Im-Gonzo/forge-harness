"use client";

/**
 * TelemetryWorkspace — the client state container for the /telemetry evidence
 * layer. Mirrors BudgetWorkspace / ValidationWorkspace: it seeds from the server
 * `initial` payload, then owns every interactive concern so the leaf views
 * (charts, worklists) stay presentational and receive plain data.
 *
 * Owns:
 *   stat     — the live `forge stat` rollup (null = OFF/empty), re-fetched on a
 *              since change or after a toggle.
 *   enabled  — whether telemetry is currently ON (derived-then-tracked from the
 *              latest stat read; a successful toggle updates it optimistically).
 *   since    — the --since window string (null = full history), the control the
 *              user drives; a change re-fetches stat scoped to that window.
 *   running  — an in-flight toggle / re-fetch (disables the controls).
 *
 * Toggle flow: onToggle() POSTs /api/telemetry { action } then re-reads stat so
 * the view reflects the new on/off state. Since flow: onSinceChange(s) re-reads
 * /api/telemetry?since=s. Both go through the bridge route (the forge-bridge is
 * server-only); this component never touches forge directly.
 */
import { useCallback, useState, useTransition } from "react";
import { Loader2, LineChart, Power, PowerOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TelemetryCharts } from "@/components/telemetry/telemetry-charts";
import { TelemetryWorklists } from "@/components/telemetry/telemetry-worklists";
import type { TelemetryStatData } from "@/components/telemetry/types";
import type { BridgeEnvelope, RegistryArtifact } from "@/lib/types";

/** Sentinel for "no since filter" — Base UI Select needs a non-empty value. */
const ALL = "__all__";

/** Since-window presets the control offers (value passed to `forge stat`). */
const SINCE_OPTIONS: { value: string; label: string }[] = [
  { value: ALL, label: "all time" },
  { value: "1d", label: "last 1d" },
  { value: "7d", label: "last 7d" },
  { value: "30d", label: "last 30d" },
];

export interface TelemetryWorkspaceProps {
  /** The server's first `forge stat` read (null = OFF/empty). */
  initialStat: TelemetryStatData | null;
  /** The server's first --since window (null = full history). */
  initialSince: string | null;
  /**
   * True when the first read was ON-but-EMPTY (telemetry enabled, no events
   * yet) as opposed to OFF. The CLI returns `data:null` for BOTH, so this is
   * derived server-side from the finding text — it lets the empty state label
   * "on (no events yet)" vs "off" accurately instead of always saying "off".
   */
  initialEnabledButEmpty?: boolean;
  /** Off-state message from the server's stat finding (TEL-OFF / TEL-EMPTY). */
  offMessage: string;
  /** Registry artifacts absent from the invocation keys (worklist input). */
  unused: RegistryArtifact[];
  /** uid → estimated always-on token cost (worklist weighting). */
  costByUid: Record<string, { alwaysOn: number | null }>;
}

/** True when a stat payload is ON and carries at least one event. */
function hasEvents(stat: TelemetryStatData | null): stat is TelemetryStatData {
  return !!stat && stat.enabled === true && stat.events > 0;
}

export function TelemetryWorkspace({
  initialStat,
  initialSince,
  initialEnabledButEmpty = false,
  offMessage,
  unused,
  costByUid,
}: TelemetryWorkspaceProps) {
  const [stat, setStat] = useState<TelemetryStatData | null>(initialStat);
  const [since, setSince] = useState<string | null>(initialSince);
  // Seed `enabled` from the live read when present, else from the server's
  // ON-but-EMPTY hint — so an enabled-but-eventless window is labeled "on (no
  // events yet)" rather than wrongly reading as "off".
  const [enabled, setEnabled] = useState<boolean>(
    initialStat?.enabled === true || initialEnabledButEmpty,
  );
  const [error, setError] = useState<string | null>(null);
  const [running, startTransition] = useTransition();

  /** Re-read `forge stat` scoped to `window` and fold the result into state. */
  const refetchStat = useCallback((window: string | null) => {
    startTransition(async () => {
      setError(null);
      try {
        const qs = window ? `?since=${encodeURIComponent(window)}` : "";
        const res = await fetch(`/api/telemetry${qs}`, { cache: "no-store" });
        const body = (await res.json()) as BridgeEnvelope<
          TelemetryStatData | null
        >;
        if (res.status === 502 || body.bridgeError) {
          setError(
            body.findings?.[0]?.message ??
              "Bridge could not reach the forge CLI.",
          );
          return;
        }
        const next = body.ok ? body.data : null;
        setStat(next);
        // The stat read is the source of truth for on/off.
        setEnabled(next?.enabled === true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error.");
      }
    });
  }, []);

  const onSinceChange = useCallback(
    (next: string | null) => {
      setSince(next);
      refetchStat(next);
    },
    [refetchStat],
  );

  const onToggle = useCallback(() => {
    const action = enabled ? "off" : "on";
    startTransition(async () => {
      setError(null);
      try {
        const res = await fetch("/api/telemetry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
          cache: "no-store",
        });
        const body = (await res.json()) as
          | BridgeEnvelope
          | { ok: false; error: string };
        if (res.status === 502 || ("bridgeError" in body && body.bridgeError)) {
          setError(
            ("findings" in body && body.findings?.[0]?.message) ||
              "Bridge could not reach the forge CLI.",
          );
          return;
        }
        if (!("ok" in body) || body.ok === false) {
          setError(
            ("error" in body && body.error) ||
              `Could not turn telemetry ${action}.`,
          );
          return;
        }
        // Optimistic, then reconcile from a fresh stat read.
        setEnabled(action === "on");
        refetchStat(since);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Network error.");
      }
    });
  }, [enabled, since, refetchStat]);

  const showData = hasEvents(stat);

  // ── OFF / empty state ─────────────────────────────────────────────────────
  if (!showData) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-sm">
            <Power className="size-4 text-muted-foreground" />
            Telemetry is {enabled ? "on (no events yet)" : "off"}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="font-mono text-xs text-muted-foreground">
            {enabled
              ? "Telemetry is enabled but no events have accrued yet. Charts appear once events are recorded."
              : offMessage}
          </p>

          {error ? (
            <p className="font-mono text-[11px] text-red-500">{error}</p>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              {enabled ? "disable" : "enable"}
            </p>
            <Button
              size="sm"
              variant={enabled ? "outline" : "default"}
              onClick={onToggle}
              disabled={running}
              aria-pressed={enabled}
              className="w-fit font-mono text-xs"
            >
              {running ? (
                <Loader2 className="animate-spin" />
              ) : enabled ? (
                <PowerOff />
              ) : (
                <Power />
              )}
              {enabled ? "turn telemetry off" : "turn telemetry on"}
            </Button>
            <code className="rounded bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
              $ forge telemetry {enabled ? "off" : "on"}
            </code>
          </div>

          <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <LineChart className="size-3" />
            Local-only, opt-in usage signals (never networked). Charts of hook
            fires, deny rates, and invocations appear here once events accrue.
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── ON + has-events: controls + charts + worklists ─────────────────────────
  return (
    <div className="flex flex-col gap-4">
      {/* Controls: on/off toggle (T1) + since window (T3). */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onToggle}
          disabled={running}
          aria-pressed={enabled}
          className="font-mono text-xs"
        >
          {running ? (
            <Loader2 className="animate-spin" />
          ) : (
            <PowerOff />
          )}
          telemetry on
        </Button>

        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] uppercase text-muted-foreground">
            since
          </span>
          <Select
            value={since ?? ALL}
            onValueChange={(v) => onSinceChange(v === ALL ? null : v)}
            disabled={running}
          >
            <SelectTrigger size="sm" className="font-mono text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SINCE_OPTIONS.map((o) => (
                <SelectItem
                  key={o.value}
                  value={o.value}
                  className="font-mono text-[11px]"
                >
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {running ? (
          <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            refreshing…
          </span>
        ) : null}

        {error ? (
          <span className="font-mono text-[10px] text-red-500">{error}</span>
        ) : null}
      </div>

      <TelemetryCharts data={stat} />

      <TelemetryWorklists
        unused={unused}
        costByUid={costByUid}
        mostInvoked={stat.mostInvoked}
      />
    </div>
  );
}
