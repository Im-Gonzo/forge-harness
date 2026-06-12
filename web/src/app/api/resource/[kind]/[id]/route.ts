/**
 * /api/resource/[kind]/[id] — the per-resource CRUD write surface.
 *
 * Delegates straight to the bridge's additive CRUD layer (crud.ts):
 *   GET    → readResource  (current {frontmatter, body, …})
 *   PUT    → updateResource (minimal-diff edit of an EXISTING file)
 *   POST   → createResource (additive — refuses if the file already exists)
 *   DELETE → deleteResource ({ confirm: true } contract; ?confirm=1 / body)
 *
 * Every write op runs the bridge's write cycle (write → `forge validate` →
 * `forge registry build --write`) and returns the uniform CrudResult, so the
 * client surfaces validate findings inline. Advisory WARNs are NON-BLOCKING
 * (ADR-0007): a WARN-only result is still ok:true and a 200. A thrown guard
 * (e.g. "create refuses to overwrite", unsafe id, missing confirm) is a 4xx
 * with `{ ok: false, error }`; a fail-soft bridge envelope (CLI unreachable)
 * comes back ok:false inside a 200 like any other envelope.
 *
 * Server-only: the bridge touches node:fs / child_process. This route is the
 * client's ONLY path to those writes.
 */
import {
  readResource,
  createResource,
  updateResource,
  deleteResource,
  type ResourcePayload,
} from "@/lib/forge-bridge";
import type { ResourceKind } from "@/lib/types";

export const dynamic = "force-dynamic";

const KINDS: readonly ResourceKind[] = [
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "memory",
  "hook",
  "workflow",
  "mcp",
];

/**
 * Kinds the additive CRUD layer can write. `hook` is INCLUDED: although hooks
 * live as matcher-groups inside the shared hooks/hooks.json (not one-file-per-
 * resource markdown), the CRUD layer addresses a group by its stable id and
 * edits it in place — PUT replaces the group, DELETE removes it, POST appends a
 * new one — running the identical validate → registry-build write cycle.
 */
const WRITABLE_KINDS: readonly ResourceKind[] = KINDS;

type Params = { params: Promise<{ kind: string; id: string }> };

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function asKind(raw: string): ResourceKind | null {
  return (KINDS as readonly string[]).includes(raw)
    ? (raw as ResourceKind)
    : null;
}

/** A submitted editor payload must be `{ frontmatter: object, body: string }`. */
function asPayload(value: unknown): ResourcePayload | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    !v.frontmatter ||
    typeof v.frontmatter !== "object" ||
    Array.isArray(v.frontmatter)
  ) {
    return null;
  }
  if (typeof v.body !== "string") return null;
  return {
    frontmatter: v.frontmatter as Record<string, unknown>,
    body: v.body,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// GET — read the current resource
// ──────────────────────────────────────────────────────────────────────────

export async function GET(_request: Request, { params }: Params) {
  const { kind: rawKind, id } = await params;
  const kind = asKind(rawKind);
  if (!kind) return bad(`Unknown resource kind: ${rawKind}`, 404);

  try {
    const resource = await readResource(kind, decodeURIComponent(id));
    return Response.json(resource, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return bad(message, 404);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// POST — create a new resource (additive, never overwrites)
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request, { params }: Params) {
  const { kind: rawKind, id } = await params;
  const kind = asKind(rawKind);
  if (!kind) return bad(`Unknown resource kind: ${rawKind}`, 404);
  if (!(WRITABLE_KINDS as readonly string[]).includes(kind)) {
    return bad(`Resource kind '${kind}' is not writable through this route.`);
  }

  let payload: ResourcePayload | null;
  try {
    payload = asPayload(await request.json());
  } catch {
    return bad("Request body must be valid JSON.");
  }
  if (!payload) {
    return bad("Body must be { frontmatter: object, body: string }.");
  }

  try {
    const result = await createResource(kind, decodeURIComponent(id), payload);
    // WARN-only validate is still a 200 (advisory, non-blocking).
    return Response.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Guard refusals (already exists / unsafe id) are client errors.
    return bad(message, 409);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// PUT — minimal-diff update of an existing resource
// ──────────────────────────────────────────────────────────────────────────

export async function PUT(request: Request, { params }: Params) {
  const { kind: rawKind, id } = await params;
  const kind = asKind(rawKind);
  if (!kind) return bad(`Unknown resource kind: ${rawKind}`, 404);
  if (!(WRITABLE_KINDS as readonly string[]).includes(kind)) {
    return bad(`Resource kind '${kind}' is not writable through this route.`);
  }

  let payload: ResourcePayload | null;
  try {
    payload = asPayload(await request.json());
  } catch {
    return bad("Request body must be valid JSON.");
  }
  if (!payload) {
    return bad("Body must be { frontmatter: object, body: string }.");
  }

  try {
    const result = await updateResource(kind, decodeURIComponent(id), payload);
    return Response.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A "does not exist" refusal / "Hook group not found" is a 404; malformed
    // payloads and other guards are 400.
    const status = /does not exist|not found/i.test(message) ? 404 : 400;
    return bad(message, status);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// DELETE — guarded removal ({ confirm: true })
// ──────────────────────────────────────────────────────────────────────────

export async function DELETE(request: Request, { params }: Params) {
  const { kind: rawKind, id } = await params;
  const kind = asKind(rawKind);
  if (!kind) return bad(`Unknown resource kind: ${rawKind}`, 404);
  if (!(WRITABLE_KINDS as readonly string[]).includes(kind)) {
    return bad(`Resource kind '${kind}' is not writable through this route.`);
  }

  // Confirmation may arrive as ?confirm=1|true or in a JSON body { confirm }.
  const url = new URL(request.url);
  const q = url.searchParams.get("confirm");
  let confirm = q === "1" || q === "true";
  if (!confirm) {
    try {
      const body = (await request.json()) as { confirm?: boolean } | null;
      confirm = body?.confirm === true;
    } catch {
      // No/!JSON body — confirm stays as derived from the query string.
    }
  }

  try {
    const result = await deleteResource(kind, decodeURIComponent(id), {
      confirm,
    });
    return Response.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /without explicit confirmation/.test(message) ? 400 : 404;
    return bad(message, status);
  }
}
