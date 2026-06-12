/**
 * Stable color per artifact kind for the budget charts. The theme only ships
 * five chart tokens but there are nine kinds, so we use an explicit OKLCH ramp
 * (hue-spread, fixed lightness/chroma) that reads on both light and dark.
 */
import type { ArtifactKind } from "@/lib/types";

export const KIND_COLORS: Record<ArtifactKind, string> = {
  rule: "oklch(0.62 0.17 25)", //   red-orange — dominates the always-on budget
  skill: "oklch(0.68 0.15 75)", //  amber
  agent: "oklch(0.70 0.15 140)", // green
  command: "oklch(0.66 0.14 195)", // teal
  hook: "oklch(0.60 0.16 255)", // blue
  bundle: "oklch(0.58 0.18 300)", // violet
  validator: "oklch(0.64 0.17 345)", // magenta
  "meta-test": "oklch(0.55 0.05 240)", // slate
  engine: "oklch(0.60 0.06 110)", // olive-grey
};

const FALLBACK = "oklch(0.55 0.02 0)";

export function kindColor(kind: string): string {
  return KIND_COLORS[kind as ArtifactKind] ?? FALLBACK;
}

/** All kinds that appear in `data`, ordered by descending total token cost. */
export function kindsByCost(
  rows: { kind: string; estTokens: number }[],
): string[] {
  const totals = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.kind, (totals.get(r.kind) ?? 0) + r.estTokens);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind]) => kind);
}
