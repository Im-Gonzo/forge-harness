/**
 * Stable color per memory-type tag (oklch tokens), mirroring the KIND_COLORS
 * pattern in components/graph/types.ts. Kept in a tiny dependency-free module
 * so every memory component (node, search, triage, detail, the graph shell)
 * can import the palette without a circular dependency on memory-graph.tsx.
 *
 * The richer forge schema's taxonomy (decision/glossary/gotcha/learning/
 * runbook) gets distinct hues; live entries (a coarse domain tag like
 * "project", or no type at all) fall back to default.
 */
export const MEMORY_TYPE_COLORS: Record<string, string> = {
  decision: "oklch(0.74 0.15 150)", // green
  glossary: "oklch(0.72 0.15 200)", // teal
  gotcha: "oklch(0.74 0.16 50)", // orange
  learning: "oklch(0.74 0.17 250)", // blue
  runbook: "oklch(0.7 0.16 300)", // violet
  project: "oklch(0.78 0.16 90)", // amber
  default: "oklch(0.7 0.02 260)", // slate (typeless live entries)
};

/** Resolve a memory-type tag to its oklch token (case-insensitive). */
export function memoryTypeColor(type: string | null | undefined): string {
  if (!type) return MEMORY_TYPE_COLORS.default;
  return MEMORY_TYPE_COLORS[type.toLowerCase()] ?? MEMORY_TYPE_COLORS.default;
}
