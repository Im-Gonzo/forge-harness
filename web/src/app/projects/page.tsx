import { PageShell } from "@/components/page-shell";
import {
  ProjectsView,
  type ProjectHealthLite,
} from "@/components/projects/projects-view";
import { getProjects } from "@/lib/harness";
// Import from the SPECIFIC bridge path, not the barrel — the barrel's
// `ProjectHealth` is the unrelated fleet-marker type; this is the birds-eye one.
import { scanFleet } from "@/lib/forge-bridge/fleet-health";

/**
 * Projects — the GLOBAL-PLANE cross-project overview AND selector (V2-A merges
 * the old /fleet birds-eye into here). Lists every auto-detected project harness
 * (`.claude/` dirs with real content under the scan root) ∪ explicitly-added
 * ones, plus a manual add-by-path entry. Each row also shows that project's
 * birds-eye HEALTH + drift-vs-library — registry size, per-kind breakdown,
 * validation status, and the always-on token floor — from `scanFleet` (the same
 * data the legacy /fleet page rendered). Selecting a project sets the
 * `forge-harness` cookie (via POST /api/projects) so every Project-plane page
 * re-renders against that project's root; the currently-selected one is
 * highlighted.
 *
 * Request-time state (the active-selection cookie + a live filesystem scan +
 * per-project forge spawns) — never statically render. Fail-soft end-to-end:
 * getProjects wraps scanProjects and scanFleet degrades each metric to null, so
 * this always renders at least an empty list and never blanks on one bad project.
 */
export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  // Project list (scanned ∪ added + the active selection) and the birds-eye
  // health roll-up run in PARALLEL — both are fail-soft and independent. We join
  // them by canonical `.claude` root in the view.
  const [data, fleet] = await Promise.all([getProjects(), scanFleet()]);

  // Reduce the heavy server-only ProjectHealth rows to a client-safe, root-keyed
  // map of just the metrics the row renders (the harness identity already lives
  // in `data.projects`). Keeps the bridge type server-side and the payload lean.
  const health: ProjectHealthLite[] = fleet.map((p) => ({
    root: p.harness.root,
    artifactCount: p.artifactCount,
    byKind: p.byKind,
    validateOk: p.validateOk,
    errors: p.errors,
    warnings: p.warnings,
    alwaysOnTokens: p.alwaysOnTokens,
  }));

  return (
    <PageShell
      title="Projects"
      description="Every detected project harness with its birds-eye health + drift from the library — pick one to scope the Project plane to its .claude root."
    >
      <ProjectsView data={data} health={health} />
    </PageShell>
  );
}
