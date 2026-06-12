"use client";

import { useCallback, useState } from "react";
import { Check, Copy, Cpu, Gauge, Loader2, Play, Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Global eval-run controls.
 *
 * Two visually distinct affordances, honestly labelled by what they actually do:
 *
 *  1. GRADE (deterministic, safe to run here). `onRun("--changed" | "--all")`
 *     POSTs /api/eval, which runs `forge eval-harness <target>` — a pure CODE
 *     grader that scores EXISTING transcripts against their golden sets and
 *     appends the ledger. It NEVER calls a model, so there is no token cost and
 *     it is safe to trigger from the UI. (`--report` runs nothing; `--all` /
 *     `--changed` / a uid grade + append.)
 *
 *  2. LIVE REVIEWER RUN (model-calling, MANUAL). The real reviewer agents run
 *     across k throwaway git worktrees — a LIVE model-calling operation. By
 *     design this is done MANUALLY (the `run-eval` skill); this UI deliberately
 *     does NOT auto-run it. We surface the exact command as a copy-able block so
 *     it can be run in a terminal, and say plainly that we will not run it.
 *
 * Contract (owned by EvalWorkspace):
 *   onRun(target)   — POST /api/eval to trigger the SAFE grading pass.
 *   runningTarget   — the target currently grading (or null); used to disable
 *                     triggers + show a spinner.
 *   manualCommand   — the exact MANUAL model-reviewer command to surface as a
 *                     copy-able block (NEVER auto-run by this UI).
 */
export interface EvalRunControlsProps {
  onRun: (target: string) => void;
  runningTarget: string | null;
  /** The honest, copy-able manual model-reviewer command. */
  manualCommand?: string;
}

/**
 * The MANUAL, model-calling live reviewer run. This is NOT `eval-harness --all`
 * (that is the deterministic grader the buttons above trigger) — it is the
 * `run-eval` skill, which drives the real reviewer agents across k worktrees and
 * appends graded results to the ledger. Run by hand; never auto-run by this UI.
 */
const DEFAULT_MANUAL_COMMAND = "forge run-eval --all   # LIVE reviewer across k worktrees (real model calls)";

/** Deterministic grading triggers (code grader + ledger append — no model). */
const GRADE_TRIGGERS: { target: string; label: string }[] = [
  { target: "--changed", label: "Grade changed" },
  { target: "--all", label: "Grade all" },
];

export function EvalRunControls({
  onRun,
  runningTarget,
  manualCommand = DEFAULT_MANUAL_COMMAND,
}: EvalRunControlsProps) {
  const busy = runningTarget !== null;

  const [copied, setCopied] = useState(false);
  const copyManual = useCallback(() => {
    void navigator.clipboard
      ?.writeText(manualCommand)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Fail-soft: clipboard may be unavailable (insecure context); the
        // command stays visible + selectable, so copy is a convenience only.
      });
  }, [manualCommand]);

  return (
    <div className="flex flex-col gap-3">
      {/* ── Deterministic grading pass (safe to run here). ─────────────── */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
            <Gauge className="size-3.5" />
            Grade
          </span>
          {GRADE_TRIGGERS.map(({ target, label }) => {
            const running = runningTarget === target;
            return (
              <Button
                key={target}
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onRun(target)}
                className="font-mono text-[11px]"
              >
                {running ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {running ? "Grading…" : label}
              </Button>
            );
          })}
        </div>
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          Deterministic grading pass — a code grader scores existing transcripts
          against their golden sets and appends the ledger.{" "}
          <span className="text-foreground">No model is called</span> (no token
          cost); this updates grades + run history only.
        </p>
      </div>

      {/* ── FIRST-CLASS manual live-reviewer panel (the UI does NOT run it). */}
      <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
        <div className="flex items-center gap-1.5">
          <Cpu className="size-3.5 text-amber-600 dark:text-amber-400" />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
            Live reviewer run (manual)
          </span>
        </div>
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          The real reviewer agents run across <span className="text-foreground">k throwaway git worktrees</span>
          {" "}— a <span className="text-foreground">live, model-calling</span> operation that produces the
          transcripts the grader scores. By design this is run{" "}
          <span className="text-foreground">manually</span>; this UI deliberately{" "}
          <span className="font-semibold text-amber-700 dark:text-amber-300">
            does not run it
          </span>
          . Copy the command and run it in a terminal:
        </p>
        <div className="flex items-stretch gap-2">
          <code className="flex flex-1 items-center gap-1.5 overflow-x-auto rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground">
            <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="whitespace-pre">{manualCommand}</span>
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copyManual}
            aria-label="Copy the manual live reviewer command"
            className="shrink-0 font-mono text-[11px]"
          >
            {copied ? (
              <>
                <Check className="size-3.5 text-emerald-500" />
                Copied
              </>
            ) : (
              <>
                <Copy className="size-3.5" />
                Copy
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
