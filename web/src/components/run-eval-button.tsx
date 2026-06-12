"use client";

/**
 * RunEvalButton — the shared trigger for a per-artifact grading pass.
 *
 * One button so the registry drawer and the resource editor fire the SAME
 * deterministic grade. It POSTs /api/eval { target } — the SAFE pure code
 * grader + ledger append (NEVER a model call; see api/eval/route.ts). While the
 * request is in flight the button is disabled and shows a spinner; the result
 * lands as a sonner toast and `onDone` fires afterward so the caller can
 * refetch the report/ledger.
 *
 * "use client": owns request state + onClick. The Button composes nothing here
 * (it is a real <button>, not a link), so no `render` prop — just an onClick.
 */
import * as React from "react";
import { Play, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { BridgeEnvelope } from "@/lib/types";
import type { EvalReportData } from "@/components/eval/types";

type ButtonProps = React.ComponentProps<typeof Button>;

export interface RunEvalButtonProps {
  /** Artifact uid ("<kind>:<id>") — or a verb ("--all" | "--changed"). */
  target: string;
  /** Visible label when not icon-only. Defaults to "Run eval". */
  label?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  /** Render the icon alone (label becomes the aria-label). */
  iconOnly?: boolean;
  /** Fired after the grading pass settles (success OR error). */
  onDone?: () => void;
}

export function RunEvalButton({
  target,
  label = "Run eval",
  size = "sm",
  variant = "outline",
  iconOnly = false,
  onDone,
}: RunEvalButtonProps) {
  const [running, setRunning] = React.useState(false);

  async function handleRun() {
    setRunning(true);
    try {
      const res = await fetch("/api/eval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target }),
        cache: "no-store",
      });
      const json = (await res.json()) as
        | BridgeEnvelope<EvalReportData>
        | { ok: false; error: string };

      if (!res.ok || !json.ok) {
        const message =
          "error" in json
            ? json.error
            : (json.findings.find((f) => f.level === "ERROR")?.message ??
              `Grading failed (${res.status}).`);
        toast.error(message);
        return;
      }

      toast.success(`Graded ${target}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      onDone?.();
    }
  }

  return (
    <Button
      variant={variant}
      size={size}
      disabled={running}
      onClick={handleRun}
      aria-label={iconOnly ? `Run eval for ${target}` : undefined}
    >
      {running ? <Loader2 className="animate-spin" /> : <Play />}
      {!iconOnly && (running ? "Grading…" : label)}
    </Button>
  );
}
