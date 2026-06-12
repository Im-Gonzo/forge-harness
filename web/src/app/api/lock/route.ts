/**
 * /api/lock — the per-project LOCKFILE surface for the active harness (ADR-0022).
 *
 *   GET                       → `forge lock show`  (read-only; exists/committed/inSync + the lock)
 *   GET ?diff=1               → `forge lock diff`  (read-only; +/~/- changes vs the resolved composition)
 *   POST { action:"write" }   → `forge lock write --apply` (RESOLVE the composition + write forge.lock)
 *
 * Mirrors /api/tailoring and /api/composition: the verbs run with NO explicit cwd,
 * so the bridge spawns them against the ACTIVE root (getActiveRoot — the library, or
 * the selected project's `.claude/`). No project path is threaded; the active scope
 * is resolved inside the bridge. Each verb returns the raw C3 envelope. Live state —
 * never cached.
 *
 * `forge.lock` is the RESOLVED per-project COMPOSITION manifest (the project analogue
 * of package-lock.json): the adopted set JOINed with tailoring overlays + adjudication
 * choices + each entry's pinned version/commit, plus a deterministic content hash. It
 * lives at the ACTIVE PROJECT ROOT, is git-committable, and is DISTINCT from
 * .forge/sources.lock (which pins SOURCE commits).
 *
 * MANIFEST-ONLY. The `write` action writes ONLY the forge.lock manifest — it NEVER
 * materializes/modifies any real .claude/ file, the library, or any resource content
 * (that is the bootstrap composer's job, out of scope). The CLI `write` verb PREVIEWS
 * by default and writes only under `--apply`; this POST action is the APPLY path (the
 * UI confirms before calling), so the bridge wrapper passes `--apply` — the same
 * convention as /api/tailoring and /api/composition.
 */
import { getLock, getLockDiff, lockWrite } from "@/lib/forge-bridge";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

// ──────────────────────────────────────────────────────────────────────────
// GET — read the lock (`?diff=1` for the diff vs the freshly-resolved composition).
// ──────────────────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const envelope = searchParams.get("diff") ? await getLockDiff() : await getLock();
  return Response.json(envelope, { status: 200 });
}

// ──────────────────────────────────────────────────────────────────────────
// POST — actions (write) against the ACTIVE root. `write` applies (the CLI verb
// previews by default; the bridge wrapper passes --apply). MANIFEST-ONLY.
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: { action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const action = body.action;

  if (action === "write") {
    const envelope = await lockWrite();
    return Response.json(envelope, { status: 200 });
  }

  return bad(`Unknown action '${String(action)}' (expected write).`);
}
