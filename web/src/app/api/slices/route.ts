/**
 * /api/slices — the per-project SLICE subscription surface for the active harness.
 *
 *   GET                                          → `forge slice list` (read-only)
 *   POST { action:"subscribe", sliceId }         → `forge slice subscribe <id> --apply`
 *   POST { action:"unsubscribe", sliceId }       → `forge slice unsubscribe <id> --apply`
 *
 * Mirrors /api/sources: the verbs run with NO explicit cwd, so the bridge spawns
 * them against the ACTIVE root (getActiveRoot — the library, or the selected
 * project's `.claude/`). No project path is threaded; the active scope is resolved
 * inside the bridge. Each verb returns the raw C3 envelope. Live state — never cached.
 *
 * The CLI mutating verbs PREVIEW by default and write only under `--apply`; these
 * POST actions are the APPLY path (the UI confirms before calling), so the bridge
 * wrappers pass `--apply` — the same `{ apply }` convention as /api/sources.
 */
import { getSlices, sliceSubscribe, sliceUnsubscribe } from "@/lib/forge-bridge";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export async function GET() {
  const envelope = await getSlices();
  return Response.json(envelope, { status: 200 });
}

// ──────────────────────────────────────────────────────────────────────────
// POST — actions (subscribe | unsubscribe) against the ACTIVE root. Each
// applies (the CLI verbs preview by default; the wrappers pass --apply).
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: {
    action?: unknown;
    sliceId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const action = body.action;

  if (action === "subscribe" || action === "unsubscribe") {
    const { sliceId } = body;
    if (typeof sliceId !== "string" || !sliceId) {
      return bad(`Body 'sliceId' is required for ${action}.`);
    }
    const envelope =
      action === "subscribe"
        ? await sliceSubscribe(sliceId)
        : await sliceUnsubscribe(sliceId);
    return Response.json(envelope, { status: 200 });
  }

  return bad(
    `Unknown action '${String(action)}' (expected subscribe | unsubscribe).`,
  );
}
