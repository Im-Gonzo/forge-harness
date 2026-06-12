/**
 * /api/mcp — the DUAL-SCOPE MCP-servers surface for the /mcp page.
 *
 *   GET  ?scope=machine                              → machine (library) catalog
 *   GET  ?scope=project&project=<absPath>            → that project's catalog
 *   POST { scope:"machine", action, name?, apply? }  → `forge mcp <sub>` (FORGE_ROOT)
 *   POST { scope:"project", project, action, name?, apply? }
 *                                                    → `forge mcp <sub>` (cwd=project)
 *
 * This is the dedicated MCP-management endpoint (the management moved OUT of
 * /settings into /mcp). It runs the SAME `forge mcp` verbs as /api/settings/mcp
 * but for an EXPLICIT scope:
 *   - "machine": the library's own `.claude/settings.json` (cwd pinned to
 *     FORGE_ROOT — independent of the active-harness cookie).
 *   - "project": the SELECTED project's `<project>/.claude` (cwd = the project
 *     path threaded in the body/query; the path is validated as a real, in-scope
 *     `.claude` harness via the harness allowlist before any verb runs).
 *
 * Write verbs (enable/disable) default to a SAFE preview unless { apply:true }
 * (then they merge into / remove from the scope's settings.json — additive,
 * never clobbering an existing same-named server). Each verb returns the raw C3
 * envelope; the client renders a degraded run exactly like any other envelope.
 * Live state — never cached. Server-only: the bridge touches node:child_process.
 */
import {
  mcpMachineDisable,
  mcpMachineEnable,
  mcpMachineList,
  mcpProjectDisable,
  mcpProjectEnable,
  mcpProjectList,
} from "@/lib/forge-bridge/mcp-project";
import { resolveHarness } from "@/lib/harness";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/**
 * Resolve + VALIDATE a posted project path into its canonical `.claude` root, or
 * null if it is not a trustworthy in-scope project harness. We never spawn the
 * CLI against an arbitrary cwd: the path must resolve to a real `.claude` harness
 * that is either under SCAN_ROOT or in the persisted added-projects allowlist
 * (the same guard the harness cookie uses). resolveHarness accepts either the
 * project dir or its `.claude` dir; we return the `.claude` root to spawn in.
 */
async function resolveProjectRoot(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || !value) return null;
  const harness = await resolveHarness(value);
  if (!harness || harness.kind !== "project") return null;
  return harness.root;
}

// ──────────────────────────────────────────────────────────────────────────
// GET — read-side refresh (list) for a scope. Defaults to scope=machine.
// ──────────────────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") ?? "machine";

  if (scope === "machine") {
    return Response.json(await mcpMachineList(), { status: 200 });
  }

  if (scope === "project") {
    const root = await resolveProjectRoot(url.searchParams.get("project"));
    if (!root) {
      return bad(
        "Query 'project' must be a valid, in-scope project path for scope=project.",
      );
    }
    return Response.json(await mcpProjectList(root), { status: 200 });
  }

  return bad(`Unknown scope '${scope}' (expected machine | project).`);
}

// ──────────────────────────────────────────────────────────────────────────
// POST — actions (list | enable | disable) for a scope. Write verbs (enable/
// disable) default to a SAFE preview unless { apply:true }.
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: {
    scope?: unknown;
    action?: unknown;
    name?: unknown;
    apply?: unknown;
    project?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const scope = body.scope;
  const action = body.action;
  const apply = body.apply === true;

  if (scope !== "machine" && scope !== "project") {
    return bad(`Body 'scope' must be machine | project (got ${String(scope)}).`);
  }

  // For the project scope, resolve + validate the project path ONCE up front.
  let projectRoot: string | null = null;
  if (scope === "project") {
    projectRoot = await resolveProjectRoot(body.project);
    if (!projectRoot) {
      return bad("Body 'project' must be a valid, in-scope project path.");
    }
  }

  if (action === "list") {
    const env =
      scope === "machine"
        ? await mcpMachineList()
        : await mcpProjectList(projectRoot as string);
    return Response.json(env, { status: 200 });
  }

  if (action === "enable" || action === "disable") {
    const { name } = body;
    if (typeof name !== "string" || !name) {
      return bad(`Body 'name' (mcp server name) is required for ${action}.`);
    }
    let env;
    if (scope === "machine") {
      env =
        action === "enable"
          ? await mcpMachineEnable(name, { apply })
          : await mcpMachineDisable(name, { apply });
    } else {
      const root = projectRoot as string;
      env =
        action === "enable"
          ? await mcpProjectEnable(root, name, { apply })
          : await mcpProjectDisable(root, name, { apply });
    }
    return Response.json(env, { status: 200 });
  }

  return bad(
    `Unknown action '${String(action)}' (expected list | enable | disable).`,
  );
}
