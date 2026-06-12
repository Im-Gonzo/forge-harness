/**
 * /api/sources — the federated SOURCE-registry surface for the active harness.
 *
 *   GET                                              → `forge source list` (read-only)
 *   POST { action:"add", id, url, ref?, kind? }      → `forge source add … --apply`
 *   POST { action:"sync", id? }                      → `forge source sync [id] --apply`
 *   POST { action:"trust", id }                      → `forge source trust <id> --apply`
 *   POST { action:"remove", id }                     → `forge source remove <id> --apply`
 *
 * Mirrors /api/memory: the verbs run with NO explicit cwd, so the bridge spawns
 * them against the ACTIVE root (getActiveRoot — the library, or the selected
 * project's `.claude/`). No project path is threaded; the active scope is resolved
 * inside the bridge. Each verb returns the raw C3 envelope. Live state — never cached.
 *
 * The CLI mutating verbs PREVIEW by default and write only under `--apply`; these
 * POST actions are the APPLY path (the UI confirms before calling), so the bridge
 * wrappers pass `--apply` — the same `{ apply }` convention as /api/memory.
 */
import {
  getSources,
  sourceAdd,
  sourceRemove,
  sourceSync,
  sourceTrust,
} from "@/lib/forge-bridge";
import type { SourceKind } from "@/lib/types";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export async function GET() {
  const envelope = await getSources();
  return Response.json(envelope, { status: 200 });
}

// ──────────────────────────────────────────────────────────────────────────
// POST — actions (add | sync | trust | remove) against the ACTIVE root. Each
// applies (the CLI verbs preview by default; the wrappers pass --apply).
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: {
    action?: unknown;
    id?: unknown;
    url?: unknown;
    ref?: unknown;
    kind?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const action = body.action;

  if (action === "add") {
    const { id, url, ref, kind } = body;
    if (typeof id !== "string" || !id) {
      return bad("Body 'id' (source id) is required for add.");
    }
    if (typeof url !== "string" || !url) {
      return bad("Body 'url' (clone url or local path) is required for add.");
    }
    if (ref !== undefined && typeof ref !== "string") {
      return bad("Body 'ref' must be a string when provided.");
    }
    if (kind !== undefined && kind !== "git" && kind !== "local") {
      return bad("Body 'kind' must be 'git' or 'local' when provided.");
    }
    const envelope = await sourceAdd(id, url, {
      ref: typeof ref === "string" ? ref : undefined,
      kind: kind as SourceKind | undefined,
    });
    return Response.json(envelope, { status: 200 });
  }

  if (action === "sync") {
    const { id } = body;
    if (id !== undefined && typeof id !== "string") {
      return bad("Body 'id' must be a string when provided.");
    }
    const envelope = await sourceSync(typeof id === "string" ? id : undefined);
    return Response.json(envelope, { status: 200 });
  }

  if (action === "trust") {
    const { id } = body;
    if (typeof id !== "string" || !id) {
      return bad("Body 'id' (source id) is required for trust.");
    }
    const envelope = await sourceTrust(id);
    return Response.json(envelope, { status: 200 });
  }

  if (action === "remove") {
    const { id } = body;
    if (typeof id !== "string" || !id) {
      return bad("Body 'id' (source id) is required for remove.");
    }
    const envelope = await sourceRemove(id);
    return Response.json(envelope, { status: 200 });
  }

  return bad(
    `Unknown action '${String(action)}' (expected add | sync | trust | remove).`,
  );
}
