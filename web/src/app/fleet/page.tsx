import { Boxes } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { FleetOverview } from "@/components/fleet/fleet-overview";
// Import from the SPECIFIC bridge path, not the barrel — the barrel's
// `ProjectHealth` is the unrelated fleet-marker type; this is the birds-eye one.
import { scanFleet } from "@/lib/forge-bridge/fleet-health";
import { SCAN_ROOT } from "@/lib/harness";

// Live cross-project state — render on every request, never cache. The birds-eye
// scans the filesystem and spawns forge per project, so it must always reflect
// the projects (and their health) on disk RIGHT NOW.
export const dynamic = "force-dynamic";

interface FleetPageProps {
  // Next 16: searchParams is async. `scan` overrides the default scan root.
  searchParams: Promise<{ scan?: string | string[] }>;
}

export default async function FleetPage({ searchParams }: FleetPageProps) {
  const sp = await searchParams;
  const scanRaw = Array.isArray(sp.scan) ? sp.scan[0] : sp.scan;
  const scanRoot = scanRaw && scanRaw.trim() !== "" ? scanRaw.trim() : SCAN_ROOT;

  // scanFleet is fail-soft end-to-end: scanProjects never throws, and each
  // project's metrics degrade to null rather than blanking the overview.
  const health = await scanFleet(scanRoot);

  return (
    <PageShell
      title="Fleet"
      description="Birds-eye across every tailored harness on this machine — registry size, validation, and always-on token floor, per project."
      actions={
        <Badge variant="outline" className="font-mono text-[10px]">
          <Boxes className="size-3" />
          {health.length} project{health.length === 1 ? "" : "s"}
        </Badge>
      }
    >
      <FleetOverview health={health} scanRoot={scanRoot} />
    </PageShell>
  );
}
