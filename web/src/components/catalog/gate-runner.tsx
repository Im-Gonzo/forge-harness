"use client";

/**
 * GateRunner — the deterministic-gate run panel + agent-gate command surface.
 *
 * A Dialog that, for a TARGET (a catalog record's uid, or a source id), offers:
 *
 *   - DETERMINISTIC gates the web RUNS live (read-only) via POST /api/gates and
 *     renders the returned findings + a pass/fail/error headline:
 *       · validate  (whole scope)        — `forge validate`
 *       · dedup     (catalog)            — `forge catalog dedup`
 *       · security  (per record)         — `forge catalog admit <uid>` DRY-RUN
 *       · eval      (static rollup)      — `forge eval-harness --report`
 *
 *   - AGENT-DRIVEN gates the web does NOT run — it shows the EXACT command to
 *     copy into a Claude session (the locked decision: never fake an agent gate):
 *       · injection-auditor / repo-safety-auditor → `forge catalog audit …`
 *       · judge                                   → `forge catalog judge …`
 *       · behavioral-eval (live)                  → `forge eval-harness <uid>`
 *
 * Which gates appear depends on the target kind:
 *   - "record" (catalog uid): security + dedup + validate + eval-static (run),
 *     and audit/judge/behavioral-eval (copy-command).
 *   - "source" (source id):   validate + eval-static (run; these assess the
 *     active scope after a sync), and the injection/repo-safety auditor commands
 *     framed for the source. A per-SOURCE deterministic security scan is NOT a
 *     clean per-target CLI verb (the scanners run during `catalog build|dedup`),
 *     so we surface dedup/validate + the auditor commands rather than fake one.
 *
 * Server-free: this client component only fetches /api/gates; the bridge resolves
 * the active scope. Co-located types live in lib/forge-bridge/gates.ts.
 */
import * as React from "react";
import {
  Check,
  ClipboardCopy,
  Gavel,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  TestTubes,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusPill } from "@/components/forge";
import { cn } from "@/lib/utils";
import type { BridgeEnvelope, Finding } from "@/lib/types";

/** Which kind of thing the gates target. */
export type GateTargetKind = "record" | "source";

/** A deterministic gate the panel can run for this target. */
type RunGate = "validate" | "dedup" | "security" | "eval";
/** An agent-driven gate the panel shows the command for. */
type AgentGate =
  | "injection-auditor"
  | "repo-safety-auditor"
  | "judge"
  | "behavioral-eval";

/** The normalized POST /api/gates deterministic-run response. */
interface GateRunResponse {
  ok: boolean;
  mode: "deterministic";
  gate: RunGate;
  target: string | null;
  verdict: "pass" | "fail" | "error";
  envelope: BridgeEnvelope;
}

/** Per-gate run state: idle, in-flight, or a finished result. */
type RunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: GateRunResponse };

const RUN_GATE_META: Record<
  RunGate,
  { label: string; icon: React.ComponentType<{ className?: string }>; hint: string }
> = {
  security: {
    label: "run security",
    icon: ShieldCheck,
    hint: "forge catalog admit <uid> (dry-run) — T2 security gate preview; activates nothing",
  },
  dedup: {
    label: "run dedup",
    icon: TestTubes,
    hint: "forge catalog dedup — deterministic dedup classification",
  },
  validate: {
    label: "run validate",
    icon: Check,
    hint: "forge validate — self-validators across the active scope",
  },
  eval: {
    label: "run eval (static)",
    icon: TestTubes,
    hint: "forge eval-harness --report — read-only static eval rollup",
  },
};

const AGENT_GATE_META: Record<AgentGate, { label: string }> = {
  "injection-auditor": { label: "injection auditor" },
  "repo-safety-auditor": { label: "repo-safety auditor" },
  judge: { label: "conflict judge" },
  "behavioral-eval": { label: "behavioral eval (live)" },
};

/** The deterministic + agent gates offered per target kind. */
function gatesForKind(kind: GateTargetKind): {
  run: RunGate[];
  agent: AgentGate[];
} {
  if (kind === "record") {
    return {
      run: ["security", "dedup", "validate", "eval"],
      agent: ["injection-auditor", "repo-safety-auditor", "judge", "behavioral-eval"],
    };
  }
  // source
  return {
    run: ["validate", "dedup", "eval"],
    agent: ["injection-auditor", "repo-safety-auditor"],
  };
}

export interface GateRunnerProps {
  /** Open state (controlled by the parent table). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the gates target. */
  kind: GateTargetKind;
  /** The target uid (record) or source id (source) — used for per-target gates + commands. */
  target: string;
}

export function GateRunner({ open, onOpenChange, kind, target }: GateRunnerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {/* Key the body by target+kind so each target mounts a FRESH panel (its
            run state starts clean) without a synchronizing reset effect. */}
        <GatePanel key={`${kind}:${target}`} kind={kind} target={target} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The gate-panel body — mounted fresh per target (keyed by the parent), so its
 * per-gate run state always starts idle without an effect.
 */
function GatePanel({ kind, target }: { kind: GateTargetKind; target: string }) {
  const { run, agent } = React.useMemo(() => gatesForKind(kind), [kind]);
  const [state, setState] = React.useState<Record<RunGate, RunState>>(() => ({
    validate: { status: "idle" },
    dedup: { status: "idle" },
    security: { status: "idle" },
    eval: { status: "idle" },
  }));

  const runGate = React.useCallback(
    async (gate: RunGate) => {
      setState((s) => ({ ...s, [gate]: { status: "running" } }));
      try {
        const res = await fetch("/api/gates", {
          method: "POST",
          headers: { "content-type": "application/json" },
          cache: "no-store",
          // security gate is per-target; the others attach target for context.
          body: JSON.stringify({ gate, target }),
        });
        const json = (await res.json()) as
          | GateRunResponse
          | { ok: false; error: string };
        if ("error" in json && typeof json.error === "string") {
          toast.error(json.error);
          setState((s) => ({ ...s, [gate]: { status: "idle" } }));
          return;
        }
        const result = json as GateRunResponse;
        setState((s) => ({ ...s, [gate]: { status: "done", result } }));
        if (result.verdict === "error") {
          toast.error(`Could not run ${gate} — the CLI did not respond.`);
        } else if (result.verdict === "fail") {
          toast.warning(`${gate} reported blocking findings.`);
        } else {
          toast.success(`${gate} passed.`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        setState((s) => ({ ...s, [gate]: { status: "idle" } }));
      }
    },
    [target],
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 font-mono text-sm">
          <ShieldCheck className="size-4 text-state-info" />
          Gates — <span className="text-foreground">{target}</span>
        </DialogTitle>
        <DialogDescription className="font-mono text-xs">
          Run the DETERMINISTIC gates the web can run (read-only — they activate
          nothing), or copy the exact command for an AGENT-DRIVEN gate to run in a
          Claude session. The CLI is authoritative.
        </DialogDescription>
      </DialogHeader>

      {/* ── Deterministic gates — the web RUNS these ─────────────────────── */}
      <section className="flex flex-col gap-2">
        <h3 className="font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
          deterministic — run here
        </h3>
        <div className="flex flex-col gap-2">
          {run.map((gate) => (
            <DeterministicGateRow
              key={gate}
              gate={gate}
              state={state[gate]}
              onRun={() => runGate(gate)}
            />
          ))}
        </div>
      </section>

      {/* ── Agent-driven gates — the web SHOWS the command, never runs it ── */}
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
          <Gavel className="size-3" />
          agent-driven — copy the command (run in a Claude session)
        </h3>
        <div className="flex flex-col gap-2">
          {agent.map((gate) => (
            <AgentGateRow key={gate} gate={gate} target={target} />
          ))}
        </div>
      </section>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Deterministic gate row — a run button + the verdict + the findings list.
// ──────────────────────────────────────────────────────────────────────────

function DeterministicGateRow({
  gate,
  state,
  onRun,
}: {
  gate: RunGate;
  state: RunState;
  onRun: () => void;
}) {
  const meta = RUN_GATE_META[gate];
  const Icon = meta.icon;
  const running = state.status === "running";
  const result = state.status === "done" ? state.result : null;

  return (
    <div className="rounded-lg ring-1 ring-border bg-card/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <Button
          variant="outline"
          size="xs"
          disabled={running}
          onClick={onRun}
          className="font-mono text-[length:var(--text-xs)]"
          title={meta.hint}
        >
          {running ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Icon className="size-3" />
          )}
          {meta.label}
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-2xs)] text-muted-foreground/70">
          {meta.hint}
        </span>
        {result ? <VerdictPill verdict={result.verdict} /> : null}
      </div>

      {result ? (
        <FindingsList
          findings={result.envelope.findings}
          summary={result.envelope.summary}
        />
      ) : null}
    </div>
  );
}

function VerdictPill({ verdict }: { verdict: "pass" | "fail" | "error" }) {
  if (verdict === "pass") {
    return (
      <StatusPill tone="ok" icon={<ShieldCheck className="size-3" />}>
        pass
      </StatusPill>
    );
  }
  if (verdict === "error") {
    return (
      <StatusPill tone="attention" icon={<ShieldAlert className="size-3" />}>
        cli error
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="warn" icon={<ShieldAlert className="size-3" />}>
      blocked
    </StatusPill>
  );
}

function FindingsList({
  findings,
  summary,
}: {
  findings: Finding[];
  summary: BridgeEnvelope["summary"];
}) {
  if (findings.length === 0) {
    return (
      <p className="border-t border-border px-3 py-2 font-mono text-[length:var(--text-2xs)] text-muted-foreground/70">
        No findings. ({summary.errors} error / {summary.warnings} warn /{" "}
        {summary.info} info)
      </p>
    );
  }
  return (
    <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto border-t border-border px-3 py-2">
      {findings.map((f, i) => (
        <li
          key={i}
          className="flex items-start gap-2 font-mono text-[length:var(--text-2xs)] leading-[var(--leading-snug)]"
        >
          <span
            className={cn(
              "mt-0.5 shrink-0 rounded-pill border px-1.5 py-px text-[length:var(--text-2xs)]",
              f.level === "ERROR"
                ? "border-state-attention/40 text-state-attention"
                : f.level === "WARN"
                  ? "border-state-warn/40 text-state-warn"
                  : "border-border text-muted-foreground",
            )}
          >
            {f.level}
          </span>
          <span className="min-w-0 text-foreground">{f.message}</span>
        </li>
      ))}
    </ul>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Agent gate row — the exact command to copy (the web never runs it).
// ──────────────────────────────────────────────────────────────────────────

function AgentGateRow({ gate, target }: { gate: AgentGate; target: string }) {
  const meta = AGENT_GATE_META[gate];
  const command = React.useMemo(
    () => buildAgentCommand(gate, target),
    [gate, target],
  );
  const [copied, setCopied] = React.useState(false);

  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success("Command copied.");
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy to the clipboard.");
    }
  }, [command]);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/[0.12] px-3 py-2">
      <StatusPill tone="info" icon={<Gavel className="size-3" />}>
        {meta.label}
      </StatusPill>
      <code className="min-w-0 flex-1 truncate font-mono text-[length:var(--text-2xs)] text-muted-foreground">
        {command}
      </code>
      <Button
        variant="ghost"
        size="xs"
        onClick={onCopy}
        className="font-mono text-[length:var(--text-xs)]"
        title="Copy the command to run in a Claude session"
      >
        {copied ? <Check className="size-3" /> : <ClipboardCopy className="size-3" />}
        copy
      </Button>
    </div>
  );
}

/** Mirror of lib/forge-bridge/gates.ts#agentGateCommand (client-side copy). */
function buildAgentCommand(gate: AgentGate, uid: string): string {
  switch (gate) {
    case "injection-auditor":
      return `forge catalog audit ${uid} --agent injection-auditor --verdict <clean|suspicious|malicious> [--evidence "<file:line ...>"] --apply`;
    case "repo-safety-auditor":
      return `forge catalog audit ${uid} --agent repo-safety-auditor --verdict <clean|suspicious|malicious> [--evidence "<file:line ...>"] --apply`;
    case "judge":
      return `forge catalog judge ${uid} --verdict <keep|replace|both|quarantine> [--rationale "<why>"] --apply`;
    case "behavioral-eval":
      return `forge eval-harness ${uid}`;
  }
}
