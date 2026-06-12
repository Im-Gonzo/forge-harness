/**
 * /api/composition — the per-project COMPOSITION (adopt) surface for the active harness.
 *
 *   GET                                          → `forge compose list` (read-only)
 *   POST { action:"adopt", uid, sourceId? }      → `forge compose adopt <uid> [--source <s>] --apply`
 *   POST { action:"remove", uid, sourceId? }     → `forge compose remove <uid> [--source <s>] --apply`
 *
 * Mirrors /api/slices: the verbs run with NO explicit cwd, so the bridge spawns
 * them against the ACTIVE root (getActiveRoot — the library, or the selected
 * project's `.claude/`). No project path is threaded; the active scope is resolved
 * inside the bridge. Each verb returns the raw C3 envelope. Live state — never cached.
 *
 * COMPOSITION is a SEPARATE, additive layer from the global library: adopt != admit
 * — it records a per-project selection in .forge/composition.json and never writes
 * the library or runs the admission/T2 gate. `sourceId` selects which copy to
 * adopt/remove (omit / null = the library-local copy).
 *
 * NOTE: this serves the adopt COMPOSITION (Slice 2 / ADR-0019). The unrelated
 * GRAPH composition (profiles→modules→components) used to live here and now lives
 * at /api/graph-composition.
 *
 * The CLI mutating verbs PREVIEW by default and write only under `--apply`; these
 * POST actions are the APPLY path (the UI confirms before calling), so the bridge
 * wrappers pass `--apply` — the same `{ apply }` convention as /api/slices.
 */
import {
  getComposition,
  compositionAdopt,
  compositionRemove,
} from "@/lib/forge-bridge";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export async function GET() {
  const envelope = await getComposition();
  return Response.json(envelope, { status: 200 });
}

// ──────────────────────────────────────────────────────────────────────────
// POST — actions (adopt | remove) against the ACTIVE root. Each applies (the
// CLI verbs preview by default; the wrappers pass --apply).
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: {
    action?: unknown;
    uid?: unknown;
    sourceId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const action = body.action;

  if (action === "adopt" || action === "remove") {
    const { uid } = body;
    if (typeof uid !== "string" || !uid) {
      return bad(`Body 'uid' is required for ${action}.`);
    }
    // sourceId is optional: a string selects a source's copy; absent / null / ""
    // is the library-local copy. Reject any other type defensively.
    const { sourceId } = body;
    if (
      sourceId !== undefined &&
      sourceId !== null &&
      typeof sourceId !== "string"
    ) {
      return bad("Body 'sourceId' must be a string or null when present.");
    }
    const resolvedSource =
      typeof sourceId === "string" && sourceId ? sourceId : null;
    const envelope =
      action === "adopt"
        ? await compositionAdopt(uid, resolvedSource)
        : await compositionRemove(uid, resolvedSource);
    return Response.json(envelope, { status: 200 });
  }

  return bad(`Unknown action '${String(action)}' (expected adopt | remove).`);
}
