/**
 * /mcp — the dedicated DUAL-SCOPE MCP-servers manager.
 *
 * MCP-server management moved OUT of /settings (which is now harness config)
 * into its own page. It renders TWO clearly-labeled scopes:
 *
 *   MACHINE  — the library's own MCP catalog + which servers are enabled in the
 *              library `.claude/settings.json`. Read via `forge mcp list` pinned
 *              to FORGE_ROOT (independent of the active-harness cookie), so the
 *              machine section is stable regardless of which project is selected.
 *   PROJECT  — the SELECTED project's MCP catalog + enabled state, read via
 *              `forge mcp list` with cwd = the project's `.claude`. When no
 *              project is selected (the library is the active scope) the panel
 *              shows a calm "select a project" state.
 *
 * Both panels preserve the existing enable/disable flow: PREVIEW the plan first,
 * then APPLY writes settings.json — enable merges ADDITIVELY (never clobbers an
 * existing same-named server), disable removes only that component's keys. Every
 * action rides POST /api/mcp with the panel's { scope, project? }.
 *
 * Server component: resolves the active/selected project (for the project scope
 * + label) and reads each scope's catalog in parallel. Fail-soft — a degraded
 * `mcp list` is a bridgeError envelope the panel renders as an empty/disabled
 * state, never a throw.
 */
import { PageShell } from "@/components/page-shell";
import { McpScopePanel } from "@/components/mcp/mcp-scope-panel";
import { getActiveHarness, LIBRARY } from "@/lib/harness";
import {
  mcpMachineList,
  mcpProjectList,
} from "@/lib/forge-bridge/mcp-project";

// Live state — render on every request, never cache.
export const dynamic = "force-dynamic";

export default async function McpPage() {
  // Resolve the active scope: a PROJECT (cookie-scoped selection) drives the
  // project panel; the library means "no project selected".
  const active = await getActiveHarness();
  const project = active.kind === "project" ? active : null;

  // Read both scopes' catalogs in parallel (each fail-soft). The machine read is
  // pinned to FORGE_ROOT inside the bridge; the project read targets the selected
  // project's `.claude` (skipped when no project is selected).
  const [machineMcp, projectMcp] = await Promise.all([
    mcpMachineList(),
    project ? mcpProjectList(project.root) : Promise.resolve(null),
  ]);

  return (
    <PageShell
      title="MCP"
      description="Manage MCP servers — machine (library) and the selected project."
    >
      <div className="grid gap-4">
        <McpScopePanel
          scope="machine"
          scopeLabel={LIBRARY.label}
          mcp={machineMcp}
        />
        <McpScopePanel
          scope="project"
          scopeLabel={project?.label ?? "no project selected"}
          projectPath={project?.root ?? null}
          mcp={projectMcp}
        />
      </div>
    </PageShell>
  );
}
