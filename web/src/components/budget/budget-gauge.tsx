"use client";

import { useMemo } from "react";
import { Gauge, Minus, Plus, Scissors, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface BudgetGaugeProps {
  /** Always-on token total forge computed (the budget's current floor). */
  alwaysOnTotal: number;
  /** Tokens the current what-if selection would drop from the floor. */
  savings: number;
  /** User-set token ceiling, or null when unset. Persisted by the workspace. */
  ceiling: number | null;
  /** Set / clear the ceiling. */
  onCeilingChange: (n: number | null) => void;
  className?: string;
}

const fmt = new Intl.NumberFormat("en-US");

/**
 * Threshold palette. The theme only ships `--destructive` + greyscale chart
 * tokens, so — like kind-colors.ts — we use explicit OKLCH for the
 * green/amber bands and lean on `--destructive` for the over-budget red.
 */
const BAND = {
  green: "oklch(0.70 0.15 145)", // under budget, comfortable headroom
  amber: "oklch(0.75 0.15 80)", //  approaching the ceiling (75–100%)
  red: "var(--destructive)", //     at/over the ceiling
} as const;

type Band = keyof typeof BAND;

function bandFor(pct: number): Band {
  if (pct > 100) return "red";
  if (pct >= 75) return "amber";
  return "green";
}

// ── Semicircle arc geometry ──────────────────────────────────────────────
const VB_W = 200; // viewBox width
const VB_H = 110; // viewBox height (semicircle + a little label room)
const CX = 100; // arc center x
const CY = 100; // arc center y (baseline)
const R = 86; // arc radius
const STROKE = 14;

/** Point on the upper semicircle for a 0..1 fraction (left→right). */
function arcPoint(t: number): { x: number; y: number } {
  const angle = Math.PI * (1 - t); // π (left) → 0 (right)
  return { x: CX + R * Math.cos(angle), y: CY - R * Math.sin(angle) };
}

/** SVG path for the arc covering [from, to] (each 0..1). */
function arcPath(from: number, to: number): string {
  const a = arcPoint(from);
  const b = arcPoint(to);
  const largeArc = to - from > 0.5 ? 1 : 0;
  return `M ${a.x} ${a.y} A ${R} ${R} 0 ${largeArc} 1 ${b.x} ${b.y}`;
}

/**
 * Ceiling gauge (B3). Shows the always-on floor against an editable token
 * ceiling as a semicircle arc with threshold colors, the % of budget used, and
 * — when the current what-if selection would trim tokens — an "after trim"
 * projection (secondary arc + marker) so you can see a pending change land
 * inside (or still outside) budget before committing to it.
 *
 * The arc fraction is value / ceiling, clamped to [0, 1] for drawing; the % and
 * headroom copy report the true (uncapped) figure so over-budget is unambiguous.
 */
export function BudgetGauge({
  alwaysOnTotal,
  savings,
  ceiling,
  onCeilingChange,
  className,
}: BudgetGaugeProps) {
  const hasCeiling = ceiling !== null && ceiling > 0;
  const trimmed = Math.max(0, alwaysOnTotal - savings);
  const willTrim = savings > 0;

  // Stepper increment: a tidy 10% of the floor (min 100), rounded to 100s.
  const step = useMemo(() => {
    const raw = Math.max(100, Math.round(alwaysOnTotal / 10));
    return Math.max(100, Math.round(raw / 100) * 100);
  }, [alwaysOnTotal]);

  function commit(next: number | null) {
    onCeilingChange(next === null ? null : Math.max(0, Math.round(next)));
  }

  // ── No ceiling set: arc has no denominator. Show the floor + a prompt. ──
  if (!hasCeiling) {
    return (
      <Card className={cn(className)}>
        <CardContent className="flex flex-col items-center gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              <Gauge className="size-3" />
              ceiling
            </span>
            <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
              {fmt.format(trimmed)} tok
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              always-on floor
              {willTrim ? ` · −${fmt.format(savings)} after trim` : null}
            </span>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <CeilingStepper
              ceiling={ceiling}
              step={step}
              floor={alwaysOnTotal}
              onCommit={commit}
            />
            <p className="font-mono text-[11px] text-muted-foreground">
              Set a token budget to track headroom.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Ceiling set: draw the arc. ──────────────────────────────────────────
  const usedPct = (alwaysOnTotal / ceiling) * 100;
  const trimmedPct = (trimmed / ceiling) * 100;
  const band = bandFor(usedPct);
  const trimmedBand = bandFor(trimmedPct);

  const usedFrac = Math.min(1, alwaysOnTotal / ceiling);
  const trimmedFrac = Math.min(1, trimmed / ceiling);
  const over = usedPct > 100;
  const headroom = ceiling - alwaysOnTotal;

  // When trimming pulls the value DOWN, the trimmed arc is the shorter one and
  // sits "under" the current arc; draw current first (lighter) then trimmed on
  // top so the saved span reads as the segment between them.
  return (
    <Card className={cn(className)}>
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
        {/* Arc dial */}
        <div className="relative mx-auto w-[180px] shrink-0 sm:mx-0">
          <svg
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            className="w-full overflow-visible"
            role="img"
            aria-label={`${usedPct.toFixed(0)} percent of token budget used`}
          >
            {/* track */}
            <path
              d={arcPath(0, 1)}
              fill="none"
              stroke="var(--muted)"
              strokeWidth={STROKE}
              strokeLinecap="round"
            />
            {/* current usage (faded when a trim is pending so the trimmed arc reads on top) */}
            {usedFrac > 0 ? (
              <path
                d={arcPath(0, usedFrac)}
                fill="none"
                stroke={BAND[band]}
                strokeWidth={STROKE}
                strokeLinecap="round"
                opacity={willTrim ? 0.35 : 1}
                style={{ transition: "stroke 200ms" }}
              />
            ) : null}
            {/* projected after-trim usage, drawn on top */}
            {willTrim && trimmedFrac > 0 ? (
              <path
                d={arcPath(0, trimmedFrac)}
                fill="none"
                stroke={BAND[trimmedBand]}
                strokeWidth={STROKE}
                strokeLinecap="round"
                style={{ transition: "stroke 200ms" }}
              />
            ) : null}
            {/* ceiling tick at the right end */}
            <ArcTick frac={1} color="var(--border)" />
            {/* center readout */}
            <text
              x={CX}
              y={CY - 26}
              textAnchor="middle"
              className="font-mono"
              fontSize={26}
              fontWeight={600}
              fill={over ? "var(--destructive)" : "var(--foreground)"}
            >
              {(willTrim ? trimmedPct : usedPct).toFixed(0)}%
            </text>
            <text
              x={CX}
              y={CY - 8}
              textAnchor="middle"
              className="font-mono"
              fontSize={10}
              fill="var(--muted-foreground)"
            >
              of budget
            </text>
          </svg>
        </div>

        {/* Numbers + ceiling control */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              <Gauge className="size-3" />
              ceiling
            </span>
            <CeilingStepper
              ceiling={ceiling}
              step={step}
              floor={alwaysOnTotal}
              onCommit={commit}
            />
          </div>

          {/* always-on floor vs ceiling */}
          <div className="flex items-baseline gap-1.5 font-mono">
            <span
              className={cn(
                "text-2xl font-semibold tabular-nums",
                over ? "text-destructive" : "text-foreground",
              )}
            >
              {fmt.format(alwaysOnTotal)}
            </span>
            <span className="text-[11px] text-muted-foreground">
              / {fmt.format(ceiling)} tok always-on
            </span>
          </div>

          {/* headroom / over-budget copy */}
          <p
            className={cn(
              "font-mono text-[11px]",
              over ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {over
              ? `${fmt.format(alwaysOnTotal - ceiling)} tok over ceiling`
              : `${fmt.format(headroom)} tok headroom`}
          </p>

          {/* after-trim projection line */}
          {willTrim ? (
            <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              <Scissors className="size-3 shrink-0" />
              after trim:{" "}
              <span
                className={cn(
                  "tabular-nums",
                  trimmedPct > 100 ? "text-destructive" : "text-foreground",
                )}
              >
                {fmt.format(trimmed)} tok → {trimmedPct.toFixed(0)}%
              </span>
              <span className="text-muted-foreground">
                (−{fmt.format(savings)})
              </span>
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** Small radial tick mark across the arc band at fraction `frac`. */
function ArcTick({ frac, color }: { frac: number; color: string }) {
  const angle = Math.PI * (1 - frac);
  const inner = R - STROKE / 2 - 2;
  const outer = R + STROKE / 2 + 2;
  const x1 = CX + inner * Math.cos(angle);
  const y1 = CY - inner * Math.sin(angle);
  const x2 = CX + outer * Math.cos(angle);
  const y2 = CY - outer * Math.sin(angle);
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
    />
  );
}

/** − / numeric input / + ceiling control. `null` ⇒ no target. */
function CeilingStepper({
  ceiling,
  step,
  floor,
  onCommit,
}: {
  ceiling: number | null;
  step: number;
  floor: number;
  onCommit: (n: number | null) => void;
}) {
  const dec = () => {
    const base = ceiling ?? floor;
    onCommit(Math.max(0, base - step));
  };
  const inc = () => {
    const base = ceiling ?? floor;
    onCommit(base + step);
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        onClick={dec}
        aria-label={`Decrease ceiling by ${step}`}
      >
        <Minus />
      </Button>
      <Input
        type="number"
        min={0}
        step={step}
        inputMode="numeric"
        placeholder="ceiling"
        value={ceiling ?? ""}
        onChange={(e) => {
          const v = e.target.value.trim();
          onCommit(v === "" ? null : Math.max(0, Number(v)));
        }}
        className="h-6 w-24 px-2 text-center font-mono text-[11px] tabular-nums"
        aria-label="Token ceiling"
      />
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        onClick={inc}
        aria-label={`Increase ceiling by ${step}`}
      >
        <Plus />
      </Button>
      {ceiling !== null ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onCommit(null)}
          aria-label="Clear ceiling"
          className="text-muted-foreground"
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}
