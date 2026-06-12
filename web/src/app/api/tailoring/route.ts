/**
 * /api/tailoring — the per-project TAILORING + OVERLAYS surface for the active harness.
 *
 *   GET                                                       → `forge tailor list` (read-only)
 *   POST { action:"add", uid, type, detail?, sourceId? }      → `forge tailor add <uid> --type <t> [--detail <s>] [--source <s>] --apply`
 *   POST { action:"remove", uid, type, detail?, sourceId? }   → `forge tailor remove <uid> --type <t> [--detail <s>] [--source <s>] --apply`
 *
 * Mirrors /api/conflicts and /api/composition: the verbs run with NO explicit cwd,
 * so the bridge spawns them against the ACTIVE root (getActiveRoot — the library, or
 * the selected project's `.claude/`). No project path is threaded; the active scope
 * is resolved inside the bridge. Each verb returns the raw C3 envelope. Live state —
 * never cached.
 *
 * A TAILORING OVERLAY is a per-adopted-resource modifier (only an ADOPTED resource
 * may be tailored). Overlays are RECORDED INTENTIONS in a SEPARATE additive store
 * (.forge/tailoring.json) — they are NEVER applied to real .claude/ files here (that
 * is Slice 5). The CLI computes a deterministic RESOLVED PREVIEW (a VIEW only).
 * `type` is pin | override | layer | gate | fork | disable; `detail` is the
 * type-specific short string (optional for fork/disable). `sourceId` selects which
 * copy to tailor (omit / null = the library-local copy).
 *
 * The CLI mutating verbs PREVIEW by default and write only under `--apply`; these
 * POST actions are the APPLY path (the UI confirms before calling), so the bridge
 * wrappers pass `--apply` — the same convention as /api/conflicts and /api/composition.
 */
import {
  getTailoring,
  tailorAdd,
  tailorRemove,
} from "@/lib/forge-bridge";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/** The valid overlay types (ADR-0021). */
const OVERLAY_TYPES = [
  "pin",
  "override",
  "layer",
  "gate",
  "fork",
  "disable",
] as const;

export async function GET() {
  const envelope = await getTailoring();
  return Response.json(envelope, { status: 200 });
}

// ──────────────────────────────────────────────────────────────────────────
// POST — actions (add | remove) against the ACTIVE root. Each applies (the CLI
// verbs preview by default; the wrappers pass --apply).
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: {
    action?: unknown;
    uid?: unknown;
    type?: unknown;
    detail?: unknown;
    sourceId?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const action = body.action;

  if (action === "add" || action === "remove") {
    const { uid, type } = body;
    if (typeof uid !== "string" || !uid) {
      return bad(`Body 'uid' is required for ${action}.`);
    }
    if (
      typeof type !== "string" ||
      !(OVERLAY_TYPES as readonly string[]).includes(type)
    ) {
      return bad(
        `Body 'type' must be one of ${OVERLAY_TYPES.join(" | ")} for ${action}.`,
      );
    }
    // detail is optional: a string narrows (remove) or sets (add) the overlay
    // detail; absent / null / "" omits the flag (valid for fork/disable on add,
    // and for "remove all of this type" on remove). Reject any other type.
    const { detail } = body;
    if (detail !== undefined && detail !== null && typeof detail !== "string") {
      return bad("Body 'detail' must be a string or null when present.");
    }
    const resolvedDetail =
      typeof detail === "string" && detail ? detail : undefined;
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
      action === "add"
        ? await tailorAdd(uid, type, resolvedDetail, resolvedSource)
        : await tailorRemove(uid, type, resolvedDetail, resolvedSource);
    return Response.json(envelope, { status: 200 });
  }

  return bad(`Unknown action '${String(action)}' (expected add | remove).`);
}
