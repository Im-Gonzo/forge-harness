/**
 * /api/memory — the SCOPED memory surface for the active harness.
 *
 *   GET  [?vault=<abs>]                         → the read-only memory-vault payload
 *   POST { action:"reindex"|"import"|"validate", srcDir?, apply? }
 *                                               → run `forge memory <sub>` (ACTIVE root)
 *
 * GET reads the flat `*.md` memory vault (entries + `[[wiki-link]]` edges + the
 * MEMORY.md index) the /memory graph consumes (fail-soft, never throws).
 *
 * POST is the SCOPED analogue of /api/fleet/memory: it runs the `forge memory`
 * verbs with NO explicit cwd, so the bridge spawns them against the ACTIVE root
 * (getActiveRoot — the library, or the selected project's `.claude/`). No project
 * path is threaded; the active scope is resolved inside the bridge. Write verbs
 * default to SAFE (reindex = dry-run, import = preview) unless { apply:true }.
 * Each verb returns the raw C3 envelope. Live on-disk state — never cached.
 */
import { readMemoryVault } from "@/lib/forge-bridge";
// Direct import (NOT the barrel index.ts): the active-root memory verbs are the
// scoped analogue of the project-scoped surface; both live in memory-project.
import {
  memoryImport,
  memoryReindex,
  memoryValidate,
} from "@/lib/forge-bridge/memory-project";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const vault = await readMemoryVault(searchParams.get("vault") ?? undefined);
  return Response.json(vault, { status: 200 });
}

// ──────────────────────────────────────────────────────────────────────────
// POST — actions (reindex | import | validate) against the ACTIVE root. Write
// verbs default to safe (reindex = dry-run, import = preview) unless { apply }.
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: { action?: unknown; srcDir?: unknown; apply?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const action = body.action;
  const apply = body.apply === true;

  if (action === "validate") {
    const envelope = await memoryValidate();
    return Response.json(envelope, { status: 200 });
  }

  if (action === "reindex") {
    // `apply` is the explicit write opt-in (reindex --write persists index.md).
    const envelope = await memoryReindex({ write: apply });
    return Response.json(envelope, { status: 200 });
  }

  if (action === "import") {
    const { srcDir } = body;
    if (typeof srcDir !== "string" || !srcDir) {
      return bad("Body 'srcDir' (source vault dir) is required for import.");
    }
    const envelope = await memoryImport(srcDir, { apply });
    return Response.json(envelope, { status: 200 });
  }

  return bad(
    `Unknown action '${String(action)}' (expected reindex | import | validate).`,
  );
}
