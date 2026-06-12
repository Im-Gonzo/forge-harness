/**
 * forge-bridge/gates — the DETERMINISTIC gate-run surface (ADR-0017 §5a).
 *
 * The federated-catalog admission model has two tiers of gate:
 *
 *   - DETERMINISTIC gates: pure, code-only checks with no model in the loop. The
 *     web CAN run these live and show their findings/verdict, because they are
 *     reproducible and bounded:
 *       · validate  — `forge validate` self-validators (whole active scope).
 *       · dedup     — `forge catalog dedup` deterministic dedup classification
 *                     (per-record class + peers extracted from the catalog).
 *       · security  — `forge catalog admit <uid>` DRY-RUN (no --apply): the T2
 *                     security-gate PREVIEW. It runs the layer-1 scanners +
 *                     gate evaluation and reports the blocking reasons as
 *                     findings WITHOUT activating anything (read-only).
 *       · eval      — `forge eval-harness --report`: the read-only STATIC eval
 *                     rollup (coverage/health). NOT a live behavioral run.
 *
 *   - AGENT-DRIVEN gates: a Claude session (auditor/judge) MUST run them; there
 *     is no clean, deterministic per-target CLI invocation the web can fake.
 *     For these we do NOT run anything — we surface the exact command to copy:
 *       · injection-auditor / repo-safety-auditor  → `forge catalog audit …`
 *       · conflict judge                            → `forge catalog judge …`
 *       · behavioral eval (live)                    → `forge eval-harness <uid>`
 *     (`agentGateCommand` builds these copy-strings; see the GATE_CATALOG below.)
 *
 * Every deterministic run rides `runForge` (active-root scoped, fail-soft) and
 * returns the raw C3 envelope, so callers/UI render a degraded CLI exactly like
 * any other envelope. The CLI remains AUTHORITATIVE — this module never decides
 * a verdict itself; it surfaces what the CLI reported.
 *
 * NOTE: server-only module (runForge → node:child_process). Import from server
 * components and route handlers only — never from a "use client" boundary.
 */
import type { BridgeEnvelope } from "@/lib/types";

import { runForge } from "./run";

// ──────────────────────────────────────────────────────────────────────────
// Gate vocabulary (co-located here — NOT in src/lib/types.ts, per the build
// convention that each bridge owns its own types).
// ──────────────────────────────────────────────────────────────────────────

/**
 * The DETERMINISTIC gates the web can run live, keyed by id. Each names the
 * underlying read-only forge invocation. `security` and `eval` accept a target
 * uid; `validate` and `dedup` assess the whole active scope.
 */
export type DeterministicGateId = "validate" | "dedup" | "security" | "eval";

/**
 * The AGENT-DRIVEN gates: a Claude session runs them. The web NEVER runs these;
 * it shows the exact command. Kept distinct from DeterministicGateId so the UI
 * cannot accidentally route an agent gate through a deterministic runner.
 */
export type AgentGateId =
  | "injection-auditor"
  | "repo-safety-auditor"
  | "judge"
  | "behavioral-eval";

/** Whether a gate is something the web runs, or only shows the command for. */
export type GateMode = "deterministic" | "agent-driven";

/** A single gate's catalog entry — its mode + a short human label. */
export interface GateDescriptor {
  id: DeterministicGateId | AgentGateId;
  mode: GateMode;
  /** Short title for the UI (e.g. "T2 security gate"). */
  label: string;
  /** One-line description of what the gate checks. */
  blurb: string;
}

/**
 * The full gate catalog the UI renders. DETERMINISTIC entries get a run button;
 * AGENT-DRIVEN entries get a copy-the-command affordance. This is the single
 * source of truth for "which gates exist and which can the web run" — be honest
 * about the split (the locked decision: never fake an agent gate).
 */
export const GATE_CATALOG: ReadonlyArray<GateDescriptor> = [
  {
    id: "validate",
    mode: "deterministic",
    label: "validators",
    blurb:
      "forge validate — the self-validators across the active scope (schema, refs, unicode-safety, …). Whole-scope, read-only.",
  },
  {
    id: "dedup",
    mode: "deterministic",
    label: "dedup",
    blurb:
      "forge catalog dedup — deterministic dedup classification (unique / exact-dup / uid-collision / near-dup) vs the rest of the catalog.",
  },
  {
    id: "security",
    mode: "deterministic",
    label: "T2 security gate",
    blurb:
      "forge catalog admit <uid> (dry-run) — the layer-1 deterministic scanners + the T2 admit-gate PREVIEW. Reports blocking reasons WITHOUT activating.",
  },
  {
    id: "eval",
    mode: "deterministic",
    label: "eval (static)",
    blurb:
      "forge eval-harness --report — the read-only STATIC eval rollup (coverage / health). The LIVE behavioral run is agent-driven.",
  },
  {
    id: "injection-auditor",
    mode: "agent-driven",
    label: "injection auditor",
    blurb:
      "A Claude session reads the resource and records a prompt-injection verdict. The web cannot run an auditor — copy the command and run it in a session.",
  },
  {
    id: "repo-safety-auditor",
    mode: "agent-driven",
    label: "repo-safety auditor",
    blurb:
      "A Claude session assesses an executable kind's repo-safety and records a verdict. Agent-driven — copy the command.",
  },
  {
    id: "judge",
    mode: "agent-driven",
    label: "conflict judge",
    blurb:
      "A Claude session adjudicates a uid-collision / near-dup conflict (keep / replace / both / quarantine). Agent-driven — copy the command.",
  },
  {
    id: "behavioral-eval",
    mode: "agent-driven",
    label: "behavioral eval (live)",
    blurb:
      "A LIVE eval run that exercises the artifact. forge eval-harness <uid> is a live command — copy it; only --report is read-only here.",
  },
];

/** A normalized deterministic-gate result, ready for the UI. */
export interface GateRunResult {
  /** The gate that ran. */
  gate: DeterministicGateId;
  /** The target uid (security / eval) or null (validate / dedup are whole-scope). */
  target: string | null;
  /** The raw C3 envelope the CLI emitted (authoritative). */
  envelope: BridgeEnvelope;
  /**
   * A compact verdict derived from the envelope for the UI headline:
   *   - "pass"  — ok && no ERROR finding.
   *   - "fail"  — !ok or an ERROR finding present (e.g. the T2 gate blocked).
   *   - "error" — the bridge could not run the CLI at all.
   * The CLI's own ok/findings remain authoritative; this is display-only.
   */
  verdict: "pass" | "fail" | "error";
}

// ──────────────────────────────────────────────────────────────────────────
// Deterministic gate runners — each rides the read-only CLI path. None mutate.
// ──────────────────────────────────────────────────────────────────────────

/** True when the envelope was synthesized by the bridge (CLI could not run). */
function isBridgeError(env: BridgeEnvelope): boolean {
  return "bridgeError" in env && env.bridgeError === true;
}

/** Derive the display verdict from a finished envelope (CLI authoritative). */
function deriveVerdict(env: BridgeEnvelope): GateRunResult["verdict"] {
  if (isBridgeError(env)) return "error";
  const hasError = env.findings.some((f) => f.level === "ERROR");
  return env.ok && !hasError ? "pass" : "fail";
}

/**
 * `forge validate --json` — run the self-validators across the ACTIVE scope.
 * Whole-scope (not per-target); pass `strict` to count advisory WARNs.
 */
export async function runValidateGate(
  opts?: { strict?: boolean },
): Promise<GateRunResult> {
  const envelope = await runForge("validate", opts?.strict ? ["--strict"] : []);
  return { gate: "validate", target: null, envelope, verdict: deriveVerdict(envelope) };
}

/**
 * `forge catalog dedup --json` — the deterministic dedup classification across
 * the catalog (read-only). Whole-catalog; the per-record verdict is read from
 * data.records[].dedup. Returns the full envelope so the caller can pick out a
 * single record's class when a `target` is supplied (we attach it for the UI).
 */
export async function runDedupGate(
  target?: string | null,
): Promise<GateRunResult> {
  const envelope = await runForge("catalog", ["dedup"]);
  return {
    gate: "dedup",
    target: target ?? null,
    envelope,
    verdict: deriveVerdict(envelope),
  };
}

/**
 * `forge catalog admit <uid>` (NO --apply) — the T2 security-gate DRY-RUN.
 *
 * This is the deterministic security PREVIEW: the CLI runs the layer-1 scanners
 * + evaluates the admit gate and reports the blocking reasons as findings, but
 * — because --apply is omitted — it ACTIVATES NOTHING (read-only). A clear gate
 * is ok:true; a blocked gate is ok:false with the reasons as ERROR findings.
 * The web NEVER passes --apply here: this runner is a preview only. (The actual
 * admit/override path is /api/catalog, which the catalog table owns.)
 */
export async function runSecurityGate(uid: string): Promise<GateRunResult> {
  const envelope = await runForge("catalog", ["admit", uid]);
  return {
    gate: "security",
    target: uid,
    envelope,
    verdict: deriveVerdict(envelope),
  };
}

/**
 * `forge eval-harness --report --json` — the read-only STATIC eval rollup.
 *
 * This is the deterministic eval tier: coverage / health derived from the
 * append-only ledger, NOT a live behavioral run (a live run is agent-driven —
 * see `agentGateCommand("behavioral-eval", uid)`). A `target` is attached for
 * the UI but the rollup is whole-scope; the page can scope to the uid's row.
 */
export async function runEvalStaticGate(
  target?: string | null,
): Promise<GateRunResult> {
  const envelope = await runForge("eval-harness", ["--report"]);
  return {
    gate: "eval",
    target: target ?? null,
    envelope,
    verdict: deriveVerdict(envelope),
  };
}

/** Dispatch a deterministic gate by id (the /api/gates POST entry point). */
export async function runDeterministicGate(
  gate: DeterministicGateId,
  opts?: { target?: string | null; strict?: boolean },
): Promise<GateRunResult> {
  switch (gate) {
    case "validate":
      return runValidateGate({ strict: opts?.strict });
    case "dedup":
      return runDedupGate(opts?.target);
    case "security": {
      const uid = opts?.target;
      if (!uid) {
        // Synthesize a fail-soft result rather than running a bad invocation.
        return {
          gate,
          target: null,
          verdict: "error",
          envelope: syntheticError(
            "catalog admit",
            "The security gate needs a target uid (catalog record).",
          ),
        };
      }
      return runSecurityGate(uid);
    }
    case "eval":
      return runEvalStaticGate(opts?.target);
    default: {
      // Exhaustiveness guard — a new DeterministicGateId must add a case above.
      const never: never = gate;
      return {
        gate: never,
        target: null,
        verdict: "error",
        envelope: syntheticError("gates", `Unknown deterministic gate '${String(never)}'.`),
      };
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Agent-driven gates — the web NEVER runs these. It surfaces the EXACT command
// to copy and run in a Claude session (the locked decision: be honest, never
// fake an agent gate).
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the exact copy-able command for an AGENT-DRIVEN gate on a target uid.
 * The auditor gates invite the session to read the resource and then RECORD its
 * verdict with `forge catalog audit … --apply`; the judge records a conflict
 * decision with `forge catalog judge … --apply`; the behavioral eval is the
 * live `forge eval-harness <uid>` run. These are SHOWN, not executed.
 */
export function agentGateCommand(gate: AgentGateId, uid: string): string {
  switch (gate) {
    case "injection-auditor":
      return `forge catalog audit ${uid} --agent injection-auditor --verdict <clean|suspicious|malicious> [--evidence "<file:line ...>"] --apply`;
    case "repo-safety-auditor":
      return `forge catalog audit ${uid} --agent repo-safety-auditor --verdict <clean|suspicious|malicious> [--evidence "<file:line ...>"] --apply`;
    case "judge":
      return `forge catalog judge ${uid} --verdict <keep|replace|both|quarantine> [--rationale "<why>"] --apply`;
    case "behavioral-eval":
      return `forge eval-harness ${uid}`;
    default: {
      const never: never = gate;
      return String(never);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helper — a fail-soft synthetic envelope for guard paths (mirrors run.ts).
// ──────────────────────────────────────────────────────────────────────────

function syntheticError(command: string, message: string): BridgeEnvelope {
  return {
    forge: "unknown",
    command,
    ok: false,
    ts: new Date().toISOString(),
    data: {},
    findings: [
      { level: "ERROR", path: command, line: null, message, source: "forge-bridge/gates" },
    ],
    summary: { errors: 1, warnings: 0, info: 0 },
    bridgeError: true,
  };
}
