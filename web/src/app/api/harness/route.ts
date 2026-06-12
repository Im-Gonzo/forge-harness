/**
 * /api/harness — the active-harness switcher's contract.
 *
 * A "harness" is a resource root the whole app scopes to: the LIBRARY
 * (FORGE_ROOT), or a scanned project's `<project>/.claude` dir. The active root
 * is stored in the `forge-harness` cookie and resolved INSIDE the bridge
 * (getActiveRoot), so every page auto-scopes with no page changes.
 *
 *   GET  → listHarnesses()  — the library + every scanned project (the switcher
 *          options). Fail-soft: the scan never throws, so this always returns at
 *          least the library.
 *   POST { root } → VALIDATE the posted root (only "library" / FORGE_ROOT, or a
 *          valid scanned `.claude` dir under SCAN_ROOT is accepted) then set the
 *          HARNESS_COOKIE and return { ok, harness }. An invalid root is a 400 —
 *          the cookie is NEVER set to an unguarded path.
 *
 * Server-only: it reads next/headers cookies() and walks the filesystem (the
 * harness module). This route is the client switcher's ONLY path to those.
 */
import { cookies } from "next/headers";

import {
  HARNESS_COOKIE,
  listHarnesses,
  resolveHarness,
} from "@/lib/harness";

// The active root is request-time state (cookie); never statically render.
export const dynamic = "force-dynamic";

interface PostBody {
  /** "library" / FORGE_ROOT, or an absolute project `.claude` path. */
  root?: unknown;
}

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

// ──────────────────────────────────────────────────────────────────────────
// GET — the switcher's option list (library + scanned projects)
// ──────────────────────────────────────────────────────────────────────────

export async function GET(): Promise<Response> {
  try {
    const harnesses = await listHarnesses();
    return Response.json({ harnesses }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// POST — switch the active harness (set the cookie to a GUARDED root)
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return bad("Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || typeof body.root !== "string") {
    return bad("Missing or invalid 'root' (expected a string).");
  }

  // VALIDATE before touching the cookie: only the library, or a valid scanned
  // `.claude` path under SCAN_ROOT, is accepted. resolveHarness returns null
  // for anything else (traversal, a path outside SCAN_ROOT, a missing dir).
  const harness = await resolveHarness(body.root);
  if (!harness) {
    return bad(
      "Invalid harness root: must be 'library' or a valid project .claude path.",
    );
  }

  // Persist the resolved root. httpOnly:false is fine (no secret — the switcher
  // may read it client-side); path "/" so every route is scoped consistently.
  const store = await cookies();
  store.set(HARNESS_COOKIE, harness.root, {
    httpOnly: false,
    path: "/",
    sameSite: "lax",
  });

  return Response.json({ ok: true, harness }, { status: 200 });
}
