/**
 * /api/conflicts — the per-project CONFLICT + ADJUDICATION surface for the active harness.
 *
 *   GET                                                  → `forge conflict list` (read-only)
 *   POST { action:"resolve", uid, winner }               → `forge conflict resolve <uid> --winner <w> --apply`
 *   POST { action:"policy", policy:{normal?,compliance?,safety?} }
 *                                                        → `forge conflict policy [--set k=v ...] --apply`
 *
 * Mirrors /api/composition: the verbs run with NO explicit cwd, so the bridge spawns
 * them against the ACTIVE root (getActiveRoot — the library, or the selected project's
 * `.claude/`). No project path is threaded; the active scope is resolved inside the
 * bridge. Each verb returns the raw C3 envelope. Live state — never cached.
 *
 * A CONFLICT is a uid with >= 2 distinct candidate records in the catalog read-view
 * (dedup uid-collision / near-dup). The read path deterministically COLLECTS conflicts
 * and CONSUMES already-recorded judge verdicts + eval scores; it invokes NO model.
 * `resolve` records the human's T2 pick (BR-CAT-013) and, on --apply, also updates the
 * composition. A resolve that REPLACES an already-admitted library resource is a T2
 * human action even under policy "auto" (BR-CAT-003) — only the human's explicit
 * `winner` is forwarded; this route never picks one.
 *
 * The CLI mutating verbs PREVIEW by default and write only under `--apply`; these POST
 * actions are the APPLY path (the UI confirms before calling), so the bridge wrappers
 * pass `--apply` — the same convention as /api/composition.
 */
import {
  conflictResolve,
  conflictSetPolicy,
  getConflicts,
} from "@/lib/forge-bridge";
import type { AdjudicationPolicy } from "@/lib/types";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

const POLICY_KEYS = ["normal", "compliance", "safety"] as const;
const POLICY_VALUES = ["auto", "block"] as const;

export async function GET() {
  const envelope = await getConflicts();
  return Response.json(envelope, { status: 200 });
}

// ──────────────────────────────────────────────────────────────────────────
// POST — actions (resolve | policy) against the ACTIVE root. Each applies (the
// CLI verbs preview by default; the wrappers pass --apply).
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: {
    action?: unknown;
    uid?: unknown;
    winner?: unknown;
    policy?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const action = body.action;

  // resolve — record the human's T2 winner pick for a conflict (BR-CAT-013).
  if (action === "resolve") {
    const { uid, winner } = body;
    if (typeof uid !== "string" || !uid) {
      return bad("Body 'uid' is required for resolve.");
    }
    // winner is a sourceId, or the literal "library" for the library-local copy.
    if (typeof winner !== "string" || !winner) {
      return bad(
        "Body 'winner' is required for resolve (a sourceId or \"library\").",
      );
    }
    const envelope = await conflictResolve(uid, winner);
    return Response.json(envelope, { status: 200 });
  }

  // policy — set the per-criticality adjudication policy (BR-CAT-012).
  if (action === "policy") {
    const { policy } = body;
    if (typeof policy !== "object" || policy === null) {
      return bad("Body 'policy' must be an object for the policy action.");
    }
    const p = policy as Record<string, unknown>;
    const partial: Partial<AdjudicationPolicy> = {};
    for (const key of POLICY_KEYS) {
      const value = p[key];
      if (value === undefined) continue;
      if (
        typeof value !== "string" ||
        !(POLICY_VALUES as readonly string[]).includes(value)
      ) {
        return bad(`Policy '${key}' must be "auto" or "block" when present.`);
      }
      partial[key] = value as "auto" | "block";
    }
    if (Object.keys(partial).length === 0) {
      return bad(
        "Body 'policy' must set at least one of normal | compliance | safety.",
      );
    }
    const envelope = await conflictSetPolicy(partial);
    return Response.json(envelope, { status: 200 });
  }

  return bad(`Unknown action '${String(action)}' (expected resolve | policy).`);
}
