"use client";

interface Finding {
  level: string;
  message: string;
  path: string;
  line: number | null;
}

interface Props {
  findings: Finding[];
  summary?: { errors?: number; warnings?: number; info?: number };
}

const LEVEL_STYLE: Record<string, string> = {
  ERROR: "text-destructive",
  WARN: "text-amber-500",
  INFO: "text-muted-foreground",
};

/**
 * Inline render of `forge validate` findings after an edit. ERRORs are
 * blocking; WARN/INFO are advisory (ADR-0007) — shown but never gating.
 */
export function FindingsList({ findings, summary }: Props) {
  const errors = summary?.errors ?? 0;
  const warnings = summary?.warnings ?? 0;
  const relevant = findings.filter((f) => f.level !== "INFO");

  return (
    <div className="rounded-md border border-border bg-muted/40 p-2">
      <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        validate ·{" "}
        <span className={errors > 0 ? "text-destructive" : "text-foreground"}>
          {errors} error{errors === 1 ? "" : "s"}
        </span>
        {" · "}
        <span className={warnings > 0 ? "text-amber-500" : "text-foreground"}>
          {warnings} warn{warnings === 1 ? "" : "s"}
        </span>
        {errors === 0 ? " · advisory only, non-blocking" : ""}
      </p>
      {relevant.length > 0 ? (
        <ul className="max-h-40 space-y-1 overflow-y-auto font-mono text-[10px]">
          {relevant.map((f, i) => (
            <li key={i} className={LEVEL_STYLE[f.level] ?? ""}>
              <span className="font-semibold">{f.level}</span> {f.path}
              {f.line ? `:${f.line}` : ""} — {f.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="font-mono text-[10px] text-muted-foreground">
          No blocking findings.
        </p>
      )}
    </div>
  );
}
