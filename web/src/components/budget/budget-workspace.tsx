"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BudgetCharts } from "@/components/budget/budget-charts";
import { BudgetGauge } from "@/components/budget/budget-gauge";
import { BudgetStats } from "@/components/budget/budget-stats";
import { ProfileCosts } from "@/components/budget/profile-costs";
import { computeSavings } from "@/components/budget/whatif";
import type { AnalyzeArtifact, ProfileCost } from "@/app/budget/analyze-types";
import type { ProfilesManifest, ModulesManifest } from "@/lib/forge-bridge";

interface BudgetWorkspaceProps {
  /** Every analyzed artifact (charts filter to always-on themselves). */
  artifacts: AnalyzeArtifact[];
  /** Only the always-on artifacts — the rows that sum to the always-on total. */
  alwaysOnArtifacts: AnalyzeArtifact[];
  /** The headline always-on token total forge computed. */
  alwaysOnTotal: number;
  /** profileName → { alwaysOn, conditionalCeiling }. */
  perProfile: Record<string, ProfileCost>;
  /** profiles manifest from readComposition (fail-soft — may be undefined). */
  profiles?: ProfilesManifest;
  /** modules manifest from readComposition — required by the profile drill-down. */
  modules?: ModulesManifest;
}

const fmt = new Intl.NumberFormat("en-US");

/** localStorage key for the persisted token ceiling. */
const CEILING_KEY = "forge-web:budget:ceiling";

/** Read the persisted ceiling once (SSR-safe). Returns null when unset/invalid. */
function readStoredCeiling(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CEILING_KEY);
    if (raw === null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Client state container for the /budget dashboard — mirrors GraphWorkspace's
 * idiom (lazy useState seeding from props/storage, useCallback setters, no
 * prop→state sync effect). Owns:
 *
 *   selectedUids — the what-if "drop these artifacts" selection (Set<uid>).
 *   ceiling      — the user's token budget ceiling (number | null), persisted
 *                  to localStorage so it survives reloads.
 *
 * Receives ALL data as props from the server page (the forge-bridge is
 * server-only). Lays out the stats, the ceiling gauge, the what-if summary line,
 * the charts (selection wired) and the per-profile drill-down.
 */
export function BudgetWorkspace({
  artifacts,
  alwaysOnArtifacts,
  alwaysOnTotal,
  perProfile,
  profiles,
  modules,
}: BudgetWorkspaceProps) {
  const [selectedUids, setSelectedUids] = useState<Set<string>>(
    () => new Set(),
  );
  // Hydrated once from localStorage (lazy initializer); thereafter state drives
  // storage via the effect below — never the reverse.
  const [ceiling, setCeiling] = useState<number | null>(() =>
    readStoredCeiling(),
  );

  // Persist the ceiling whenever it changes (clear the key when unset).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (ceiling === null) window.localStorage.removeItem(CEILING_KEY);
      else window.localStorage.setItem(CEILING_KEY, String(ceiling));
    } catch {
      // storage unavailable (private mode / quota) — degrade silently.
    }
  }, [ceiling]);

  const toggleSelect = useCallback((uid: string) => {
    setSelectedUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedUids(new Set()), []);

  const savings = useMemo(
    () => computeSavings(selectedUids, artifacts),
    [selectedUids, artifacts],
  );

  const hasSelection = selectedUids.size > 0;

  return (
    <div className="flex flex-col gap-4">
      <BudgetStats
        alwaysOnTotal={alwaysOnTotal}
        alwaysOnArtifacts={alwaysOnArtifacts}
        totalArtifacts={artifacts.length}
      />

      <BudgetGauge
        alwaysOnTotal={alwaysOnTotal}
        savings={savings.tokens}
        ceiling={ceiling}
        onCeilingChange={setCeiling}
      />

      {/* What-if summary line: drop N selected → save M tok (−X%). */}
      {hasSelection ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-[11px]">
          <span className="text-muted-foreground">
            drop{" "}
            <span className="text-foreground">{selectedUids.size}</span> selected
            {" → "}
            save{" "}
            <span className="text-foreground">
              {fmt.format(savings.tokens)}
            </span>{" "}
            tok{" "}
            <span className="text-foreground">
              (−{savings.pct.toFixed(1)}%)
            </span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 font-mono text-[11px]"
            onClick={clearSelection}
          >
            <X className="size-3" />
            clear selection
          </Button>
        </div>
      ) : null}

      <BudgetCharts
        artifacts={alwaysOnArtifacts}
        alwaysOnTotal={alwaysOnTotal}
        selectedUids={selectedUids}
        onToggleSelect={toggleSelect}
      />

      <ProfileCosts
        perProfile={perProfile}
        artifacts={artifacts}
        profiles={profiles}
        modules={modules}
      />
    </div>
  );
}
