"use client";

/**
 * ValidationWorkspace — the client orchestrator for the /validation inbox.
 *
 * State container (mirrors GraphWorkspace / BudgetWorkspace): seeds its data from
 * the server `initial` envelope, then owns every interactive concern so the two
 * tab views stay presentational:
 *
 *   envelope    — the live validate envelope (re-fetched on demand).
 *   strict      — the --strict lens (re-fetches /api/validate?strict=1).
 *   running     — an in-flight re-validate / strict toggle.
 *   groupBy     — the findings grouping axis (validator | file | severity).
 *   levelFilter — the set of severities to show (empty = all).
 *   query       — free-text finding filter.
 *   lastCounts  — the pre-run error/warn/info counts, so a re-run can render a
 *                 delta ("3 errors → 1").
 *
 * Renders a TRIAGE HEADER (PASS/FAIL + counts + delta + controls) and two TABS:
 * "Findings" (<ValidationView>, driven by the filter state) and "Validators"
 * (<ValidationValidators>).
 */
import { useCallback, useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Info,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { BridgeEnvelope, FindingLevel } from "@/lib/types";

import { ValidationView } from "./validation-view";
import {
  ValidationValidators,
  readValidators,
} from "./validation-validators";
import { LEVEL_ORDER, type GroupBy } from "./grouping";

/** The error/warn/info triple a triage header reports. */
interface LevelCounts {
  errors: number;
  warnings: number;
  info: number;
}

function countsOf(envelope: BridgeEnvelope): LevelCounts {
  const s = envelope.summary ?? { errors: 0, warnings: 0, info: 0 };
  return {
    errors: s.errors ?? 0,
    warnings: s.warnings ?? 0,
    info: s.info ?? 0,
  };
}

const LEVEL_META: Record<
  FindingLevel,
  { Icon: LucideIcon; badge: string; label: string }
> = {
  ERROR: {
    Icon: XCircle,
    badge: "border-red-500/40 bg-red-500/10 text-red-500",
    label: "error",
  },
  WARN: {
    Icon: AlertTriangle,
    badge: "border-amber-500/40 bg-amber-500/10 text-amber-500",
    label: "warn",
  },
  INFO: {
    Icon: Info,
    badge: "border-sky-500/40 bg-sky-500/10 text-sky-500",
    label: "info",
  },
};

export interface ValidationWorkspaceProps {
  /** The non-strict envelope fetched on the server for the first paint. */
  initial: BridgeEnvelope;
}

export function ValidationWorkspace({ initial }: ValidationWorkspaceProps) {
  const [envelope, setEnvelope] = useState<BridgeEnvelope>(initial);
  const [strict, setStrict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, startTransition] = useTransition();

  // Triage filter state — owned here, fed to the presentational findings view.
  const [groupBy, setGroupBy] = useState<GroupBy>("severity");
  const [levelFilter, setLevelFilter] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");

  // The counts from BEFORE the most recent re-run, so the header can show a
  // delta (e.g. "3 errors → 1"). null until the first re-run completes.
  const [lastCounts, setLastCounts] = useState<LevelCounts | null>(null);

  const fetchValidate = useCallback(
    (wantStrict: boolean) => {
      const before = countsOf(envelope);
      startTransition(async () => {
        setError(null);
        try {
          const res = await fetch(
            `/api/validate${wantStrict ? "?strict=1" : ""}`,
            { cache: "no-store" },
          );
          const body = (await res.json()) as BridgeEnvelope;
          setLastCounts(before);
          setEnvelope(body);
          if (res.status === 502 || body.bridgeError) {
            setError(
              body.findings?.[0]?.message ??
                "Bridge could not reach the forge CLI.",
            );
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : "Network error.");
        }
      });
    },
    [envelope],
  );

  const toggleStrict = useCallback(() => {
    const next = !strict;
    setStrict(next);
    fetchValidate(next);
  }, [strict, fetchValidate]);

  const revalidate = useCallback(
    () => fetchValidate(strict),
    [strict, fetchValidate],
  );

  const toggleLevel = useCallback((level: FindingLevel) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);

  const bridgeFailed = Boolean(envelope.bridgeError);
  const counts = countsOf(envelope);
  const findings = useMemo(() => envelope.findings ?? [], [envelope.findings]);
  const validators = useMemo(
    () => readValidators(envelope.data),
    [envelope.data],
  );

  // Overall PASS iff the CLI says ok and no ERROR findings, and the bridge is up.
  const pass = !bridgeFailed && envelope.ok && counts.errors === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* ── TRIAGE HEADER ───────────────────────────────────────────────── */}
      <Card
        className={cn(
          "border-2",
          bridgeFailed
            ? "border-red-500/40"
            : pass
              ? "border-emerald-500/40"
              : "border-red-500/50",
        )}
      >
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 py-2">
          <div className="flex items-center gap-3">
            {pass ? (
              <CheckCircle2 className="size-8 text-emerald-500" aria-hidden />
            ) : (
              <XCircle className="size-8 text-red-500" aria-hidden />
            )}
            <div className="flex flex-col">
              <span
                className={cn(
                  "font-mono text-3xl font-semibold leading-none tracking-tight",
                  pass ? "text-emerald-500" : "text-red-500",
                )}
              >
                {bridgeFailed ? "ERROR" : pass ? "PASS" : "FAIL"}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                forge self-validation{strict ? " (strict)" : ""}
              </span>
            </div>
          </div>

          <Separator orientation="vertical" className="hidden h-10 sm:block" />

          {/* Counts, each with the delta vs. the pre-run snapshot. */}
          <div className="flex flex-wrap items-center gap-2">
            <CountBadge
              level="ERROR"
              n={counts.errors}
              prev={lastCounts?.errors}
            />
            <CountBadge
              level="WARN"
              n={counts.warnings}
              prev={lastCounts?.warnings}
            />
            <CountBadge level="INFO" n={counts.info} prev={lastCounts?.info} />
          </div>

          {/* ── Controls ─────────────────────────────────────────────────── */}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant={strict ? "default" : "outline"}
              size="sm"
              onClick={toggleStrict}
              disabled={running}
              aria-pressed={strict}
              className="font-mono text-xs"
            >
              {strict ? <ShieldAlert /> : <ShieldCheck />}
              {strict ? "--strict ON" : "--strict OFF"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={revalidate}
              disabled={running}
              className="font-mono text-xs"
            >
              {running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Re-validate
            </Button>
          </div>

          <span className="w-full font-mono text-[10px] text-muted-foreground">
            forge validate{strict ? " --strict" : ""} · harness @{" "}
            {envelope.forge}
            {envelope.ts
              ? ` · ${new Date(envelope.ts).toLocaleTimeString()}`
              : ""}
          </span>
        </CardContent>
      </Card>

      {/* ── Bridge failure ───────────────────────────────────────────────── */}
      {bridgeFailed || error ? (
        <Card className="border-red-500/40">
          <CardContent className="flex items-center gap-2 py-2 font-mono text-xs text-red-500">
            <CircleAlert className="size-4 shrink-0" />
            {error ??
              envelope.findings?.[0]?.message ??
              "Bridge could not reach the forge CLI."}
          </CardContent>
        </Card>
      ) : null}

      {/* ── TABS ─────────────────────────────────────────────────────────── */}
      <Tabs defaultValue="findings" className="gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="findings">
              Findings ({findings.length})
            </TabsTrigger>
            <TabsTrigger value="validators">
              Validators ({validators.length})
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="findings" className="flex flex-col gap-3">
          {/* Triage controls: group axis · level filter · free text. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="font-mono text-[10px] uppercase text-muted-foreground">
                group
              </span>
              {(["severity", "validator", "file"] as GroupBy[]).map((g) => (
                <Button
                  key={g}
                  variant={groupBy === g ? "default" : "outline"}
                  size="sm"
                  onClick={() => setGroupBy(g)}
                  aria-pressed={groupBy === g}
                  className="h-7 px-2 font-mono text-[10px]"
                >
                  {g}
                </Button>
              ))}
            </div>

            <Separator orientation="vertical" className="hidden h-5 sm:block" />

            <div className="flex items-center gap-1">
              {LEVEL_ORDER.map((level) => {
                const active =
                  levelFilter.size === 0 || levelFilter.has(level);
                const meta = LEVEL_META[level];
                return (
                  <Button
                    key={level}
                    variant="outline"
                    size="sm"
                    onClick={() => toggleLevel(level)}
                    aria-pressed={levelFilter.has(level)}
                    className={cn(
                      "h-7 gap-1 px-2 font-mono text-[10px]",
                      levelFilter.has(level) && meta.badge,
                      !active && "opacity-40",
                    )}
                  >
                    <meta.Icon className="size-3" />
                    {meta.label}
                  </Button>
                );
              })}
            </div>

            <div className="relative ml-auto min-w-[180px] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter path / message / source…"
                className="h-7 pl-7 font-mono text-[11px]"
              />
            </div>
          </div>

          <ValidationView
            findings={findings}
            groupBy={groupBy}
            levelFilter={levelFilter}
            query={query}
          />
        </TabsContent>

        <TabsContent value="validators">
          <ValidationValidators validators={validators} findings={findings} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** A severity count chip with an optional pre-run delta ("3 → 1"). */
function CountBadge({
  level,
  n,
  prev,
}: {
  level: FindingLevel;
  n: number;
  prev?: number;
}) {
  const meta = LEVEL_META[level];
  const changed = prev !== undefined && prev !== n;
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-mono text-[10px]",
        n > 0 ? meta.badge : "text-muted-foreground",
      )}
    >
      <meta.Icon className="size-3" />
      {changed ? (
        <span className="inline-flex items-center gap-0.5">
          <span className="text-muted-foreground line-through">{prev}</span>
          <ArrowRight className="size-2.5" />
          {n}
        </span>
      ) : (
        n
      )}{" "}
      {meta.label}
      {n === 1 ? "" : "s"}
    </Badge>
  );
}
