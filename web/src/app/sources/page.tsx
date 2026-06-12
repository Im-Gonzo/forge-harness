import { PageShell } from "@/components/page-shell";
import { SourcesTable } from "@/components/sources/sources-table";
import { getSources } from "@/lib/forge-bridge";

// Live forge state (the federated source registry) — render on every request,
// never cache. The read rides `forge source list` against the ACTIVE root; every
// mutation rides POST /api/sources (the client table → API route → bridge).
export const dynamic = "force-dynamic";

export default async function SourcesPage() {
  // Fail-soft: a bridge/CLI failure yields a non-ok envelope (never throws); the
  // client table renders it as a banner.
  const sources = await getSources();

  return (
    <PageShell
      title="Sources"
      description="Federated catalog sources — external Git/local repos the catalog can sync from (ADR-0017)."
      scope="global"
    >
      <SourcesTable sources={sources} />
    </PageShell>
  );
}
