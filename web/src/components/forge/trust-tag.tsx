import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Trust tags are binary: a check that passed reads `ok` (state-ok accent),
 * everything else stays `neutral` (a calm, dimmed hairline tag).
 */
export type TrustTone = "ok" | "neutral";

export interface TrustTagProps {
  /** Short mono label — "scanned", "signed refs", "pinned @ v1.2.0", … */
  label: ReactNode;
  /** Defaults to `neutral`. Use `ok` once the check has cleared. */
  tone?: TrustTone;
  /** Optional leading icon (e.g. a lucide `ShieldCheck` / `Pin`). */
  icon?: ReactNode;
  className?: string;
}

/** Per-tone text + hairline border, mirroring `.trust-tag.ok` / `.trust-tag.no`. */
const TONE_CLASS: Record<TrustTone, string> = {
  ok: "text-state-ok border-state-ok/35",
  neutral: "text-muted-foreground border-border",
};

/**
 * TrustTag — the prototype `.trust-tag`: a small inline icon + label tag used
 * for source trust signals (scanned / signed / pinned). Purely presentational.
 */
export function TrustTag({
  label,
  tone = "neutral",
  icon,
  className,
}: TrustTagProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill border px-2.5 py-0.5",
        "font-mono text-[length:var(--text-2xs)] [&>svg]:size-3",
        TONE_CLASS[tone],
        className,
      )}
    >
      {icon}
      {label}
    </span>
  );
}
