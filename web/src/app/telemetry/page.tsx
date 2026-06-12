import { AlertTriangle } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TelemetryWorkspace } from "@/components/telemetry/telemetry-workspace";
import type { TelemetryStatData } from "@/components/telemetry/types";
import { runForge, getRegistry } from "@/lib/forge-bridge";
import type { AnalyzeData } from "@/app/budget/analyze-types";
import type { RegistryArtifact, RegistryLsData } from "@/lib/types";

// Live forge state — render on every request, never cache.
export const dynamic = "force-dynamic";

interface TelemetryPageProps {
  // Next 16: searchParams is async. The since window scopes the first stat read.
  searchParams: Promise<{ since?: string | string[] }>;
}

export default async function TelemetryPage({
  searchParams,
}: TelemetryPageProps) {
  const sp = await searchParams;
  const sinceRaw = Array.isArray(sp.since) ? sp.since[0] : sp.since;
  const since = sinceRaw && sinceRaw.trim() !== "" ? sinceRaw.trim() : null;

  // Three reads in parallel, all FAIL-SOFT:
  //  - stat: the rollup the charts consume (alias of `telemetry stat`). Telemetry
  //    is opt-in/default-OFF, so a successful read can still return data:null.
  //  - registry: the full artifact catalog, to derive the UNUSED worklist.
  //  - analyze: per-artifact always-on cost, to weight the worklist.
  // Only the stat bridge failure blocks the page; registry/analyze degrade to
  // empty so the worklist simply shows fewer rows.
  const [statEnvelope, registryEnvelope, analyzeEnvelope] = await Promise.all([
    runForge<TelemetryStatData | null>(
      "stat",
      since ? ["--since", since] : [],
    ),
    getRegistry().catch(() => null),
    runForge<AnalyzeData>("analyze").catch(() => null),
  ]);

  const bridgeFailed = !statEnvelope.ok && statEnvelope.bridgeError;
  // OFF / empty: the CLI sets data to null (TEL-OFF or TEL-EMPTY finding).
  // NOTE: there is NO sample/placeholder data anywhere — `stat` is either the
  // real rollup (ON + events) or null. The workspace renders charts ONLY when
  // hasData; the OFF/empty branch shows an explicit empty state, never charts.
  const stat = statEnvelope.ok ? statEnvelope.data : null;
  const hasData = !!stat && stat.enabled === true && stat.events > 0;

  // Distinguish OFF from ON-but-EMPTY off the CLI finding text (the data is null
  // for both, so `stat?.enabled` can't tell them apart). The CLI emits "telemetry
  // is off …" (OFF) vs "telemetry on but empty …" (ON, no events yet) — surface
  // the accurate label so an empty window never reads as a placeholder chart.
  const offFinding = statEnvelope.findings.find((f) =>
    f.message?.toLowerCase().includes("telemetry"),
  );
  const offMessageRaw = offFinding?.message ?? null;
  const enabledButEmpty =
    !hasData &&
    !!offMessageRaw &&
    offMessageRaw.toLowerCase().includes("on but empty");
  const offMessage =
    offMessageRaw ?? "telemetry is off — enable with `forge telemetry on`";

  // ── Derive the evidence cross-references (best-effort, server-side) ────────
  const registryArtifacts: RegistryArtifact[] =
    registryEnvelope && registryEnvelope.ok
      ? (registryEnvelope.data as RegistryLsData).artifacts ?? []
      : [];

  // usedKeys: the telemetry invocation keys. `mostInvoked[].key` is an
  // artifact_id (or, for non-artifact events, an event_type). We can only join
  // artifacts when telemetry is ON + non-empty; otherwise it stays empty.
  const usedKeys = new Set<string>(
    (stat?.mostInvoked ?? []).map((m) => m.key),
  );

  // UNUSED heuristic: a registry artifact is "unused" when NEITHER its kind-local
  // `id` NOR its `uid` ("<kind>:<id>") appears in usedKeys. mostInvoked keys are
  // emitted as artifact_id, so the `id` match is primary and `uid` is a fallback
  // for any uid-keyed events. When usedKeys is empty (OFF/empty telemetry) every
  // artifact is technically "unused" — that's why the worklist only renders in
  // the ON+has-events branch of the workspace.
  const unused: RegistryArtifact[] = registryArtifacts.filter(
    (a) => !usedKeys.has(a.id) && !usedKeys.has(a.uid),
  );

  // costByUid: uid → estimated always-on token cost from analyze (null when the
  // artifact carries no always-on figure). Lets a worklist weight an unused
  // artifact by what it costs to keep resident.
  const analyzeArtifacts =
    analyzeEnvelope && analyzeEnvelope.ok
      ? analyzeEnvelope.data.artifacts ?? []
      : [];
  const costByUid: Record<string, { alwaysOn: number | null }> = {};
  for (const a of analyzeArtifacts) {
    costByUid[a.uid] = {
      alwaysOn: a.residency === "always-on" ? a.estTokens : null,
    };
  }

  return (
    <PageShell
      title="Telemetry"
      description="Time-series + usage evidence over the opt-in JSONL telemetry log (forge stat)."
      actions={
        <Badge
          variant={hasData ? "default" : "outline"}
          className="font-mono text-[10px]"
        >
          {hasData ? `${stat!.events} events` : "telemetry off"}
        </Badge>
      }
    >
      {bridgeFailed ? (
        <Card className="mb-4 border-red-500/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-mono text-sm text-red-500">
              <AlertTriangle className="size-4" />
              Bridge could not reach the forge CLI
            </CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xs text-muted-foreground">
            {statEnvelope.findings.map((f, i) => (
              <p key={i}>{f.message}</p>
            ))}
          </CardContent>
        </Card>
      ) : (
        <TelemetryWorkspace
          initialStat={stat}
          initialSince={since}
          initialEnabledButEmpty={enabledButEmpty}
          offMessage={offMessage}
          unused={unused}
          costByUid={costByUid}
        />
      )}
    </PageShell>
  );
}
