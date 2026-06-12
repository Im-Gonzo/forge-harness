import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Status tones map to the rationed `--state-*` accents (plus a calm neutral).
 * These are the only saturated colors the chrome is allowed to use.
 */
export type StatusTone = "ok" | "warn" | "attention" | "info" | "neutral";

export interface StatusPillProps {
  /** Which `--state-*` accent to wear. */
  tone: StatusTone;
  /** Pill label — typically a short mono word ("synced", "blocked", …). */
  children: ReactNode;
  /**
   * Optional leading glyph. When omitted, a small filled dot stands in,
   * matching the prototype's `.pill-sync i` indicator.
   */
  icon?: ReactNode;
  className?: string;
}

/**
 * Per-tone text + hairline border. The border tint mirrors the prototype's
 * `color-mix(... 38%, var(--border))` by layering the state accent at /40 so
 * the ring reads as "tinted hairline", not a saturated outline.
 */
const TONE_CLASS: Record<StatusTone, string> = {
  ok: "text-state-ok border-state-ok/40",
  warn: "text-state-warn border-state-warn/40",
  attention: "text-state-attention border-state-attention/40",
  info: "text-state-info border-state-info/40",
  neutral: "text-muted-foreground border-border",
};

/** Dot background per tone (the implicit indicator when no icon is given). */
const DOT_CLASS: Record<StatusTone, string> = {
  ok: "bg-state-ok",
  warn: "bg-state-warn",
  attention: "bg-state-attention",
  info: "bg-state-info",
  neutral: "bg-muted-foreground",
};

/**
 * StatusPill — the prototype `.pill-sync`: an inline dot (or icon) + label,
 * color-coded by `tone`, wrapped in a hairline-bordered pill.
 */
export function StatusPill({
  tone,
  children,
  icon,
  className,
}: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-pill border px-2.5 py-0.5",
        "font-mono text-[length:var(--text-2xs)] [&>svg]:size-3",
        TONE_CLASS[tone],
        className,
      )}
    >
      {icon ?? (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[tone])}
        />
      )}
      {children}
    </span>
  );
}
