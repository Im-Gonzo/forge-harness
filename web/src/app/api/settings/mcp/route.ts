/**
 * /api/settings/mcp — the SCOPED MCP-servers surface for the active harness.
 *
 *   GET  ?action=list                          → refresh the catalog list
 *   POST { action:"list"|"enable"|"disable", name?, apply? }
 *                                              → run `forge mcp <sub>` (ACTIVE root)
 *
 * This is the SCOPED analogue of /api/fleet/mcp: it runs the `forge mcp` verbs
 * with NO explicit cwd, so the bridge spawns them against the ACTIVE root
 * (getActiveRoot — the library, or the selected project's `.claude/`). No project
 * path is threaded; the active scope is resolved inside the bridge. Write verbs
 * (enable/disable) default to a SAFE preview unless { apply:true } (then they
 * merge into / remove from the active scope's settings.json). Each verb returns
 * the raw C3 envelope. Live state — never cached.
 *
 * Server-only: the bridge touches node:child_process.
 */
// Direct import (NOT the barrel index.ts): the active-root mcp verbs are the
// scoped analogue of the project-scoped surface; both live in mcp-project.
import { mcpDisable, mcpEnable, mcpList } from "@/lib/forge-bridge/mcp-project";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

// ──────────────────────────────────────────────────────────────────────────
// GET — read-side refresh (list). Defaults to list.
// ──────────────────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "list";

  if (action === "list") {
    const envelope = await mcpList();
    return Response.json(envelope, { status: 200 });
  }
  return bad(`Unknown GET action '${action}' (expected list).`);
}

// ──────────────────────────────────────────────────────────────────────────
// POST — actions (list | enable | disable) against the ACTIVE root. Write verbs
// (enable/disable) default to a SAFE preview unless { apply:true }.
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: { action?: unknown; name?: unknown; apply?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const action = body.action;
  const apply = body.apply === true;

  if (action === "list") {
    const envelope = await mcpList();
    return Response.json(envelope, { status: 200 });
  }

  if (action === "enable" || action === "disable") {
    const { name } = body;
    if (typeof name !== "string" || !name) {
      return bad(`Body 'name' (mcp server name) is required for ${action}.`);
    }
    const envelope =
      action === "enable"
        ? await mcpEnable(name, { apply })
        : await mcpDisable(name, { apply });
    return Response.json(envelope, { status: 200 });
  }

  return bad(
    `Unknown action '${String(action)}' (expected list | enable | disable).`,
  );
}
