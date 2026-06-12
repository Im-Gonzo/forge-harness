/**
 * /api/projects — the PROJECT-PLANE selector contract.
 *
 * The project plane scopes the app to ONE project's `<project>/.claude` root.
 * A "project" is EITHER a scanned `.claude/` harness under SCAN_ROOT
 * (FORGE_WEB_SCAN_ROOT, auto-detected by `scanProjects`) OR one the user
 * explicitly ADDED (persisted in the machine-level allowlist under FORGE_HOME).
 * The selected project is stored in the SAME `forge-harness` cookie the bridge
 * reads via getActiveRoot, so selecting one re-scopes every page with no changes.
 *
 *   GET  → getProjects() — scanned ∪ persisted-added projects (deduped) + which
 *          one is selected (selectedRoot/selectedId null when the library is the
 *          active scope). Fail-soft: the scan never throws, so this always
 *          returns at least `[]`.
 *
 *   POST { action:"select", root }  → set the active project. `root` must be a
 *          valid `.claude` path that is EITHER under SCAN_ROOT OR in the persisted
 *          allowlist (or "library" to clear back to the library). VALIDATE via
 *          resolveHarness, then set the cookie — reusing the EXACT cookie-set path
 *          of /api/harness POST.
 *
 *   POST { action:"add", root }     → MANUALLY add a project by path. Accepts the
 *          project dir OR its `.claude` dir (addProject normalizes). Unlike select,
 *          an explicit add ACCEPTS a real `.claude` OUTSIDE SCAN_ROOT (it keeps the
 *          exists + canonical + real-`.claude` checks, drops only containment),
 *          PERSISTS the root to the allowlist, then SELECTS it (sets the cookie).
 *          The persisted root then appears in every later GET and is accepted by
 *          validateRoot/getActiveRoot — so it survives refresh.
 *
 * An invalid root is a 400 — the cookie is NEVER set to an unguarded path. This is
 * the project-plane analogue of /api/harness; both write the one HARNESS_COOKIE.
 *
 * Server-only: reads next/headers cookies() and walks the filesystem (the harness
 * module). Request-time state (the cookie) — never statically render.
 */
import { cookies } from "next/headers";

import {
  HARNESS_COOKIE,
  addProject,
  getProjects,
  resolveHarness,
  type Harness,
} from "@/lib/harness";

export const dynamic = "force-dynamic";

interface PostBody {
  /** "select" (pick a scanned project) | "add" (manually add a project by path). */
  action?: unknown;
  /** "library", a scanned `.claude` path, or (for add) a project dir path. */
  root?: unknown;
}

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/**
 * Persist the resolved project root in the `forge-harness` cookie — the SAME
 * cookie + options /api/harness POST uses (httpOnly:false so the client selector
 * may read it; path "/" so every route scopes consistently). This is the single
 * cookie-set path the whole app shares; the project plane does not invent its own.
 */
async function setActive(harness: Harness): Promise<void> {
  const store = await cookies();
  store.set(HARNESS_COOKIE, harness.root, {
    httpOnly: false,
    path: "/",
    sameSite: "lax",
  });
}

// ──────────────────────────────────────────────────────────────────────────
// GET — the scanned projects + the current selection
// ──────────────────────────────────────────────────────────────────────────

export async function GET(): Promise<Response> {
  try {
    const data = await getProjects();
    return Response.json(data, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

// ──────────────────────────────────────────────────────────────────────────
// POST — select an existing scanned project, or manually add one (both set the
// active-project cookie to a GUARDED root).
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return bad("Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object") {
    return bad("Request body must be a JSON object.");
  }
  if (typeof body.root !== "string") {
    return bad("Missing or invalid 'root' (expected a string).");
  }
  const action = body.action;

  if (action === "select") {
    // VALIDATE before touching the cookie: only "library" / FORGE_ROOT, or a
    // valid scanned `.claude` path under SCAN_ROOT, is accepted (resolveHarness
    // returns null for traversal / outside SCAN_ROOT / missing dir).
    const harness = await resolveHarness(body.root);
    if (!harness) {
      return bad(
        "Invalid project root: must be 'library' or a valid project .claude path.",
      );
    }
    await setActive(harness);
    return Response.json({ ok: true, harness }, { status: 200 });
  }

  if (action === "add") {
    // Manual add: accept the project dir OR its `.claude` dir; addProject
    // normalizes, runs the kept security checks (exists + canonical + real
    // `.claude`, dropping only SCAN_ROOT-containment for this explicit add),
    // and PERSISTS the root to the allowlist. A valid add immediately becomes
    // the selection (sets the cookie) so the UI scopes to it right away.
    const harness = await addProject(body.root);
    if (!harness || harness.kind !== "project") {
      return bad(
        "Invalid project path: must be a real .claude harness (a dir with " +
          "agents/skills/rules/… content) that exists on disk.",
      );
    }
    await setActive(harness);
    return Response.json({ ok: true, harness }, { status: 200 });
  }

  return bad(`Unknown action '${String(action)}' (expected select | add).`);
}
