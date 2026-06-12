import type { ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";

import { cn } from "@/lib/utils";

export interface TailoredChipProps {
  /**
   * Optional overlay count. When given (and > 0) it reads "N overlays" (or the
   * compact `N` form); when omitted, the chip is a bare "tailored" marker.
   */
  count?: number;
  /** Render only the count (no "overlays" word) — for dense table cells. */
  compact?: boolean;
  className?: string;
  /** Optional override label (e.g. "tailored"); defaults derived from count. */
  children?: ReactNode;
}

/**
 * TailoredChip — the prototype `.tailor-chip`: a dashed, project-toned pill with
 * a sliders glyph marking a resource that carries one or more tailoring overlays
 * (ADR-0021). The harness rations saturated color to the `--state-*` / `--kind-*`
 * tokens; the prototype's `--src-project` green has no registered web token, so we
 * borrow the closest rationed accent — `--state-ok` (emerald) — and keep the
 * DASHED border + faint wash treatment that visually separates a project overlay
 * from a source-shipped value everywhere it appears (the Tailoring list, the
 * Composition adopted table, and the Catalog rows).
 */
export function TailoredChip({
  count,
  compact = false,
  className,
  children,
}: TailoredChipProps) {
  const label =
    children ??
    (typeof count === "number" && count > 0
      ? compact
        ? String(count)
        : `${count} overlay${count === 1 ? "" : "s"}`
      : "tailored");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-pill border border-dashed border-state-ok/55",
        "bg-state-ok/[0.06] px-2 py-0.5 font-mono text-[length:var(--text-2xs)] text-state-ok [&>svg]:size-3",
        className,
      )}
    >
      <SlidersHorizontal aria-hidden />
      {label}
    </span>
  );
}
