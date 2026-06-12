import { cn } from "@/lib/utils";

export interface SourceChipProps {
  /** Source identifier (e.g. "forge-core", "acme-skills", "acme-internal"). */
  source: string;
  /**
   * Render the CORE (curated-baseline) variant — a distinct, fixed accent that
   * sets the library-owned baseline apart from federated sources (whose dot is
   * derived per-sourceId). Used by the catalog SOURCE column for library-local
   * records (provenance "core"). Defaults to false (a federated source chip).
   */
  core?: boolean;
  className?: string;
}

/**
 * A small, fixed palette of accent buckets. Saturated color is rationed, so we
 * reuse the registered `--kind-*` tokens as "source-like" accents rather than
 * inventing new ones. Each entry pairs the dot fill with a matching low-opacity
 * ring (the prototype's `box-shadow: 0 0 0 3px color-mix(... 20%)`).
 */
const ACCENT_BUCKETS = [
  "bg-kind-agent ring-kind-agent/20",
  "bg-kind-hook ring-kind-hook/20",
  "bg-kind-skill ring-kind-skill/20",
  "bg-kind-bundle ring-kind-bundle/20",
  "bg-kind-mcp ring-kind-mcp/20",
  "bg-kind-memory ring-kind-memory/20",
  "bg-kind-validator ring-kind-validator/20",
  "bg-kind-command ring-kind-command/20",
] as const;

/**
 * Deterministic, stable hash → bucket index. The same source id always lands on
 * the same accent across renders and sessions (no randomness, no state).
 */
function bucketFor(source: string): string {
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % ACCENT_BUCKETS.length;
  return ACCENT_BUCKETS[index];
}

/**
 * The CORE (curated-baseline) accent — a single FIXED bucket reserved for the
 * library-owned baseline, distinct from every per-sourceId hashed accent so the
 * core-vs-source origin is obvious at a glance. Uses the info state token (a
 * calm, registered accent) rather than a `--kind-*` bucket a source could land
 * on.
 */
const CORE_ACCENT = "bg-state-info ring-state-info/20";

/**
 * SourceChip — the prototype `.src-chip`: a colored provenance dot (`.sd`, with
 * its soft ring) followed by the mono source id, all in a hairline-bordered
 * pill. For a federated source the dot color is derived deterministically from
 * the source id so a given source reads with a consistent accent everywhere it
 * appears. For the CORE variant (`core`) the dot uses a single fixed accent and
 * the pill carries a distinct info-toned ring/text, marking the curated baseline
 * apart from any federated source.
 */
export function SourceChip({ source, core = false, className }: SourceChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill border px-2 py-0.5",
        "font-mono text-[length:var(--text-2xs)]",
        core
          ? "border-state-info/40 text-state-info"
          : "border-border text-neutral-300",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full ring-[3px]",
          core ? CORE_ACCENT : bucketFor(source),
        )}
      />
      {source}
    </span>
  );
}
