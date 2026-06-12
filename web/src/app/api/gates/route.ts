/**
 * /api/gates — run the DETERMINISTIC catalog/source gates the web can run live,
 * or surface the EXACT command for an AGENT-DRIVEN gate (ADR-0017 §5a).
 *
 *   GET                                          → the GATE CATALOG (which gates
 *                                                  exist + their mode: deterministic
 *                                                  vs agent-driven). Read-only.
 *   POST { gate, target?, strict? }              → run a DETERMINISTIC gate and
 *                                                  return its normalized result
 *                                                  (envelope + verdict).
 *   POST { gate, target, agent:true }            → DO NOT run; return the exact
 *                                                  copy-able command for an
 *                                                  AGENT-DRIVEN gate.
 *
 * Deterministic gates (the web runs them, read-only, active-root scoped):
 *   - validate  : `forge validate` self-validators (whole scope).
 *   - dedup     : `forge catalog dedup` deterministic dedup classification.
 *   - security  : `forge catalog admit <uid>` DRY-RUN — the T2 security-gate
 *                 PREVIEW (layer-1 scanners + gate eval, activates NOTHING).
 *   - eval      : `forge eval-harness --report` STATIC rollup (read-only).
 *
 * Agent-driven gates (NEVER run here — copy the command into a Claude session):
 *   - injection-auditor / repo-safety-auditor → `forge catalog audit …`
 *   - judge                                   → `forge catalog judge …`
 *   - behavioral-eval                         → `forge eval-harness <uid>`
 *
 * The bridge resolves the active scope (getActiveRoot) — no project path is
 * threaded. A failing gate is a 200 with verdict:"fail" in the body (a result,
 * not a transport error); only a bridge/spawn failure maps verdict:"error".
 */
import {
  GATE_CATALOG,
  agentGateCommand,
  runDeterministicGate,
  type AgentGateId,
  type DeterministicGateId,
} from "@/lib/forge-bridge/gates";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

const DETERMINISTIC_GATES: ReadonlySet<DeterministicGateId> = new Set([
  "validate",
  "dedup",
  "security",
  "eval",
]);

const AGENT_GATES: ReadonlySet<AgentGateId> = new Set([
  "injection-auditor",
  "repo-safety-auditor",
  "judge",
  "behavioral-eval",
]);

/** GET — the gate catalog (the UI reads this to render run vs copy-command). */
export function GET(): Response {
  return Response.json({ ok: true, gates: GATE_CATALOG }, { status: 200 });
}

export async function POST(request: Request): Promise<Response> {
  let body: {
    gate?: unknown;
    target?: unknown;
    strict?: unknown;
    agent?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const gate = body.gate;
  if (typeof gate !== "string" || !gate) {
    return bad("Body 'gate' is required.");
  }

  const target =
    typeof body.target === "string" && body.target ? body.target : null;

  // ── AGENT-DRIVEN gate — DO NOT run; return the exact command to copy. ──────
  // The locked decision: never fake an agent gate. The web surfaces the precise
  // `forge catalog audit/judge …` / `forge eval-harness <uid>` invocation so the
  // user runs it in a Claude session.
  if (body.agent === true || AGENT_GATES.has(gate as AgentGateId)) {
    if (!AGENT_GATES.has(gate as AgentGateId)) {
      return bad(
        `Gate '${gate}' is not an agent-driven gate (expected one of ${[...AGENT_GATES].join(", ")}).`,
      );
    }
    if (!target) {
      return bad("Body 'target' (uid) is required for an agent-driven gate command.");
    }
    return Response.json(
      {
        ok: true,
        mode: "agent-driven",
        gate,
        target,
        command: agentGateCommand(gate as AgentGateId, target),
      },
      { status: 200 },
    );
  }

  // ── DETERMINISTIC gate — run it live (read-only) and normalize the result. ──
  if (!DETERMINISTIC_GATES.has(gate as DeterministicGateId)) {
    return bad(
      `Unknown deterministic gate '${gate}' (expected one of ${[...DETERMINISTIC_GATES].join(", ")}).`,
    );
  }

  // The security gate is per-target (a dry-run admit of one uid) — a missing
  // target is a client error, not a transport failure.
  if (gate === "security" && !target) {
    return bad("Body 'target' (catalog record uid) is required for the security gate.");
  }

  const strict = body.strict === true;
  const result = await runDeterministicGate(gate as DeterministicGateId, {
    target,
    strict,
  });

  // A spawn/parse failure (verdict "error") is a transport-level problem → 502;
  // a clean run (pass) or a gate that BLOCKED (fail) is a legitimate result → 200.
  const status = result.verdict === "error" ? 502 : 200;
  return Response.json(
    {
      ok: result.verdict === "pass",
      mode: "deterministic",
      gate: result.gate,
      target: result.target,
      verdict: result.verdict,
      envelope: result.envelope,
    },
    { status },
  );
}
