import { Badge } from "@/components/ui/badge";
import { PageShell } from "@/components/page-shell";
import { ValidationWorkspace } from "@/components/validation/validation-workspace";
import { getValidation } from "@/lib/forge-bridge";
import { getActiveHarness } from "@/lib/harness";

// Live forge state — render on every request, never cache.
export const dynamic = "force-dynamic";

export default async function ValidationPage() {
  // First paint is real, non-strict validate data straight from the bridge.
  // The --strict toggle re-fetches /api/validate?strict=1 on the client.
  // getValidation is scoped to getActiveRoot via the bridge cwd, so the header
  // must name the SELECTED PROJECT (or Library) — not a hardcoded FORGE_ROOT (#4).
  const [initial, harness] = await Promise.all([
    getValidation(),
    getActiveHarness(),
  ]);
  const scopeLabel = harness.kind === "project" ? harness.label : "Library";

  const summary = initial.summary ?? { errors: 0, warnings: 0, info: 0 };
  const pass = !initial.bridgeError && initial.ok && (summary.errors ?? 0) === 0;

  return (
    <PageShell
      title="Validation"
      description={`forge validate · health + findings · scope → ${scopeLabel}`}
      actions={
        <Badge
          variant={pass ? "default" : "destructive"}
          className="font-mono text-[10px]"
        >
          {initial.bridgeError ? "BRIDGE ERROR" : pass ? "PASS" : "FAIL"}
        </Badge>
      }
    >
      {/* The bridge returns the generic envelope; the workspace narrows the
          `data` payload to validate's { validators } shape at its boundary and
          owns the --strict refetch + triage filter state. */}
      <ValidationWorkspace initial={initial} />
    </PageShell>
  );
}
