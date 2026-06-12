import { Boxes, GitFork, Gauge, LineChart, FlaskConical, ShieldCheck, Server } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { CopyableCommand, StatusPanelCard } from "@/components/status-panel-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getRegistry, getStatus, getValidation } from "@/lib/forge-bridge";
import type { ArtifactKind } from "@/lib/types";
import { getActiveHarness } from "@/lib/harness";

// Live forge state — render on every request, never cache.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [status, validation, registry, harness] = await Promise.all([
    getStatus(),
    getValidation(),
    // LIVE build (scope-correct): status.panels.registry is cache-based → 0 for a
    // project. Derive the registry card's count/byKind from `registry build`.
    getRegistry(),
    // The ACTIVE scope (#4): every read above is scoped to getActiveRoot via the
    // bridge cwd, so the header must name the SELECTED PROJECT (or Library) — not
    // a hardcoded FORGE_ROOT that always reads as the library.
    getActiveHarness(),
  ]);

  const scopeLabel = harness.kind === "project" ? harness.label : "Library";

  const panels = status.ok ? status.data.panels : undefined;
  const dep = panels?.dependency;
  const fleet = panels?.fleet;
  const tel = panels?.telemetry;
  const eff = panels?.efficiency;
  const ev = panels?.eval;

  // A panel's `.data` is ONLY present for the library; a freshly-scoped project's
  // status panels are `state:"no-data"` (truthy object, but NO `.data`). Guard
  // every `.data` read so switching scope to a project never crashes the page.
  const depData = dep?.data;
  const fleetData = fleet?.data;

  // Registry card metrics from the LIVE build (works for library AND projects),
  // not status.panels.registry (cache-based → 0 in a freshly-scoped project).
  const regArtifacts = registry.ok ? (registry.data.artifacts ?? []) : [];
  const regCount = regArtifacts.length;
  const byKind = regArtifacts.reduce<Partial<Record<ArtifactKind, number>>>(
    (acc, a) => {
      acc[a.kind] = (acc[a.kind] ?? 0) + 1;
      return acc;
    },
    {},
  );
  const nextActions = status.ok ? status.data.nextActions : [];

  const valSummary = validation.summary;
  const valErrors = valSummary?.errors ?? 0;
  const valWarnings = valSummary?.warnings ?? 0;
  const valPassed = (valSummary?.passed as number | undefined) ?? undefined;
  const valFailed = (valSummary?.failed as number | undefined) ?? undefined;

  const bridgeFailed = !status.ok && status.bridgeError;

  return (
    <PageShell
      title="Status"
      description={`forge status · scope → ${scopeLabel}`}
      actions={
        <Badge variant="outline" className="font-mono text-[10px]">
          harness @ {status.forge}
        </Badge>
      }
    >
      {bridgeFailed ? (
        <Card className="mb-4 border-red-500/40">
          <CardHeader>
            <CardTitle className="font-mono text-sm text-red-500">
              Bridge could not reach the forge CLI
            </CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xs text-muted-foreground">
            {status.findings.map((f, i) => (
              <p key={i}>{f.message}</p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {/* Overall + next actions */}
      <Card className="mb-4">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-sm">
            Overall
            <Badge
              variant={status.ok && valErrors === 0 ? "default" : "destructive"}
              className="font-mono text-[10px]"
            >
              {status.ok && valErrors === 0 ? "OK" : "ATTENTION"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {nextActions.length ? (
            <div className="flex flex-col gap-1.5">
              <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                next actions
              </p>
              <ul className="flex flex-col gap-1.5">
                {nextActions.map((a) => (
                  <CopyableCommand key={a} command={a} />
                ))}
              </ul>
            </div>
          ) : (
            <p className="font-mono text-xs text-muted-foreground">
              No suggested actions — harness is healthy.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* REGISTRY */}
        <StatusPanelCard
          title="Registry"
          href="/registry"
          // Live build: count > 0 ⇒ healthy. No fallback to the cache-based
          // status panel (it's no-data for projects, and the live build is the
          // source of truth for the count regardless of scope).
          state={registry.ok ? regCount > 0 : null}
          metric={registry.ok ? regCount : "—"}
          // Count comes from the live `registry build`, which is never "stale"
          // (it's recomputed each request), so drop the cache-only stale figure.
          caption={registry.ok ? `${regCount} artifact(s)` : "no data"}
        >
          <div className="mt-1 flex flex-wrap gap-1.5">
            {Object.entries(byKind).map(([kind, n]) => (
              <span
                key={kind}
                className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                <Boxes className="size-3" />
                {kind}
                <span className="text-foreground">{n}</span>
              </span>
            ))}
          </div>
        </StatusPanelCard>

        {/* DEPENDENCY */}
        <StatusPanelCard
          title="Dependency"
          href="/graph"
          state={dep?.ok ?? null}
          metric={
            <span className="flex items-baseline gap-3">
              <span className={depData && depData.dangling > 0 ? "text-red-500" : ""}>
                {depData?.dangling ?? "—"}
              </span>
              <span className="text-base font-normal text-muted-foreground">
                dangling
              </span>
            </span>
          }
          caption={depData ? `${depData.orphans} orphan(s)` : "no data"}
        >
          <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <GitFork className="size-3" />
            dependency graph health
          </p>
        </StatusPanelCard>

        {/* BUDGET / EFFICIENCY */}
        <StatusPanelCard
          title="Budget"
          href="/budget"
          state={eff?.ok ?? null}
          caption={eff?.lines?.join(" ") ?? "context-budget"}
        >
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Gauge className="size-3" />
            {eff?.hint ? (
              <code className="text-foreground">{eff.hint}</code>
            ) : (
              "always-on token cost"
            )}
          </p>
        </StatusPanelCard>

        {/* TELEMETRY */}
        <StatusPanelCard
          title="Telemetry"
          href="/telemetry"
          state={tel?.ok ?? null}
          caption={tel?.state ? tel.state.toUpperCase() : "off"}
        >
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <LineChart className="size-3" />
            {tel?.hint ? (
              <code className="text-foreground">{tel.hint}</code>
            ) : (
              "opt-in JSONL time-series"
            )}
          </p>
        </StatusPanelCard>

        {/* EVAL */}
        <StatusPanelCard
          title="Eval"
          href="/eval"
          state={ev?.ok ?? null}
          caption={ev?.state ? ev.state : "coverage"}
        >
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <FlaskConical className="size-3" />
            {ev?.hint ? (
              <code className="text-foreground">{ev.hint}</code>
            ) : (
              "coverage + grades"
            )}
          </p>
        </StatusPanelCard>

        {/* VALIDATION */}
        <StatusPanelCard
          title="Validation"
          href="/validation"
          state={validation.bridgeError ? null : valErrors === 0}
          metric={
            <span className="flex items-baseline gap-3">
              <span className={valErrors > 0 ? "text-red-500" : "text-emerald-500"}>
                {valErrors === 0 ? "PASS" : "FAIL"}
              </span>
            </span>
          }
          caption={
            valPassed !== undefined
              ? `${valPassed} passed · ${valFailed ?? 0} failed · ${valWarnings} warn`
              : `${valErrors} error(s) · ${valWarnings} warn`
          }
        >
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <ShieldCheck className="size-3" />
            forge validate
          </p>
        </StatusPanelCard>

        {/* FLEET — de-scoped, minimal read-only card */}
        <StatusPanelCard
          title="Fleet"
          state={fleet?.ok ?? null}
          metric={fleetData?.projects ?? 0}
          caption={
            fleetData
              ? `${fleetData.grades.healthy} healthy · ${fleetData.grades.drift} drift · ${fleetData.grades.unhealthy} unhealthy`
              : "de-scoped"
          }
        >
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Server className="size-3" />
            read-only (fleet de-scoped)
          </p>
        </StatusPanelCard>
      </div>
    </PageShell>
  );
}
