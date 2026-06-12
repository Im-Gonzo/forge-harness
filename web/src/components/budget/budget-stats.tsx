import type { ReactNode } from "react";
import { Gauge, Layers, Coins, Percent } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { kindColor } from "@/components/budget/kind-colors";
import type { AnalyzeArtifact } from "@/app/budget/analyze-types";

interface BudgetStatsProps {
  alwaysOnTotal: number;
  alwaysOnArtifacts: AnalyzeArtifact[];
  totalArtifacts: number;
}

const fmt = new Intl.NumberFormat("en-US");

function Stat({
  icon,
  label,
  value,
  caption,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  caption?: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="font-mono text-2xl font-semibold tabular-nums text-foreground">
          {value}
        </span>
        {caption ? (
          <span className="font-mono text-[11px] text-muted-foreground">{caption}</span>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function BudgetStats({
  alwaysOnTotal,
  alwaysOnArtifacts,
  totalArtifacts,
}: BudgetStatsProps) {
  // Heaviest single always-on artifact and the dominant kind.
  const heaviest = alwaysOnArtifacts.reduce<AnalyzeArtifact | null>(
    (m, a) => (m === null || a.estTokens > m.estTokens ? a : m),
    null,
  );

  const byKind = new Map<string, number>();
  for (const a of alwaysOnArtifacts) {
    byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + a.estTokens);
  }
  const dominant = [...byKind.entries()].sort((a, b) => b[1] - a[1])[0];
  const dominantShare =
    dominant && alwaysOnTotal > 0 ? (dominant[1] / alwaysOnTotal) * 100 : 0;

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Stat
        icon={<Gauge className="size-3" />}
        label="always-on total"
        value={`${fmt.format(alwaysOnTotal)} tok`}
        caption={`${alwaysOnArtifacts.length} resident · ${totalArtifacts} catalogued`}
      />
      <Stat
        icon={<Layers className="size-3" />}
        label="dominant kind"
        value={
          dominant ? (
            <span className="flex items-center gap-2">
              <span
                className="inline-block size-3 rounded-[3px]"
                style={{ background: kindColor(dominant[0]) }}
              />
              {dominant[0]}
            </span>
          ) : (
            "—"
          )
        }
        caption={
          dominant
            ? `${fmt.format(dominant[1])} tok · ${dominantShare.toFixed(0)}% of budget`
            : undefined
        }
      />
      <Stat
        icon={<Coins className="size-3" />}
        label="heaviest artifact"
        value={heaviest ? `${fmt.format(heaviest.estTokens)} tok` : "—"}
        caption={heaviest ? `${heaviest.kind}:${heaviest.id}` : undefined}
      />
      <Stat
        icon={<Percent className="size-3" />}
        label="avg per artifact"
        value={
          alwaysOnArtifacts.length
            ? `${fmt.format(Math.round(alwaysOnTotal / alwaysOnArtifacts.length))} tok`
            : "—"
        }
        caption="mean always-on cost"
      />
    </div>
  );
}
