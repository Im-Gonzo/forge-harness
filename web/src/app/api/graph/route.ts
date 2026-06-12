/**
 * GET /api/graph — the dependency-graph payload.
 *
 * Aggregates three bridge reads into one response the client graph consumes:
 *   - artifacts (registry ls)  → nodes, colored by kind
 *   - dangling refs            → red unresolved edges (from/rawRef/sites)
 *   - orphan uids              → flagged nodes (nothing depends on them)
 *
 * Each artifact carries its resolved `dependsOn[]`, which become the graph's
 * resolved edges. The response is never cached — it must reflect live forge
 * state so an edit round-trips on refetch.
 */
import { getRegistry, getDangling, getOrphans } from "@/lib/forge-bridge";

export const dynamic = "force-dynamic";

export async function GET() {
  const [registry, dangling, orphans] = await Promise.all([
    getRegistry(),
    getDangling(),
    getOrphans(),
  ]);

  const ok = registry.ok && dangling.ok && orphans.ok;

  return Response.json(
    {
      ok,
      ts: new Date().toISOString(),
      artifacts: registry.ok ? registry.data.artifacts : [],
      dangling: dangling.ok ? dangling.data.dangling : [],
      orphans: orphans.ok ? orphans.data.orphans : [],
      findings: [
        ...registry.findings,
        ...dangling.findings,
        ...orphans.findings,
      ],
      bridgeError:
        registry.bridgeError || dangling.bridgeError || orphans.bridgeError
          ? true
          : undefined,
    },
    { status: ok ? 200 : 502 },
  );
}
