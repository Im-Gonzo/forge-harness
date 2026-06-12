import { Info } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BudgetWorkspace } from "@/components/budget/budget-workspace";
import { runForge, readComposition } from "@/lib/forge-bridge";
import type { ProfilesManifest, ModulesManifest } from "@/lib/forge-bridge";
import type { AnalyzeData } from "@/app/budget/analyze-types";

// Live forge state — recompute the budget on every request, never cache.
export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("en-US");

export default async function BudgetPage() {
  // analyze drives the budget; composition (profiles manifest) feeds the
  // per-profile drill-down. Composition is FAIL-SOFT — a missing/unparsable
  // manifest must not break the budget, so we swallow it and pass undefined.
  const [envelope, composition] = await Promise.all([
    runForge<AnalyzeData>("analyze"),
    readComposition().catch(() => undefined),
  ]);

  const ok = envelope.ok;
  const data = ok ? envelope.data : undefined;

  const artifacts = data?.artifacts ?? [];
  const alwaysOnArtifacts = artifacts.filter((a) => a.residency === "always-on");
  const alwaysOnTotal = data?.alwaysOnTotal ?? 0;
  const perProfile = data?.perProfile ?? {};
  const profiles: ProfilesManifest | undefined = composition?.profiles;
  // modules manifest (module→components) — required by the per-profile
  // drill-down to resolve a profile's always-on components. Fail-soft like
  // profiles; without it the drill-down shows its "unavailable" state.
  const modules: ModulesManifest | undefined = composition?.modules;

  return (
    <PageShell
      title="Context Budget"
      description="Always-on token cost per artifact and per profile (forge analyze)."
      actions={
        ok ? (
          <Badge variant="outline" className="font-mono text-[10px]">
            {fmt.format(alwaysOnTotal)} tok always-on
          </Badge>
        ) : (
          <Badge variant="destructive" className="font-mono text-[10px]">
            analyze failed
          </Badge>
        )
      }
    >
      {!ok ? (
        <Card className="border-red-500/40">
          <CardHeader>
            <CardTitle className="font-mono text-sm text-red-500">
              Could not compute the context budget
            </CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-xs text-muted-foreground">
            {envelope.findings.length ? (
              envelope.findings.map((f, i) => <p key={i}>{f.message}</p>)
            ) : (
              <p>forge analyze returned no data.</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <BudgetWorkspace
            artifacts={artifacts}
            alwaysOnArtifacts={alwaysOnArtifacts}
            alwaysOnTotal={alwaysOnTotal}
            perProfile={perProfile}
            profiles={profiles}
            modules={modules}
          />

          {/* Model provenance — the constants forge used + any analyzer notices. */}
          {data ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 font-mono text-sm">
                  <Info className="size-3.5" />
                  Model
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(data.constants).map(([k, v]) => (
                    <span
                      key={k}
                      className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                    >
                      {k} <span className="text-foreground">{String(v)}</span>
                    </span>
                  ))}
                  <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    telemetry{" "}
                    <span className="text-foreground">
                      {data.telemetry.available ? "on" : "off (static only)"}
                    </span>
                  </span>
                </div>
                {data.notices.length ? (
                  <ul className="flex flex-col gap-1">
                    {data.notices.map((n, i) => (
                      <li
                        key={i}
                        className="font-mono text-[11px] text-muted-foreground"
                      >
                        · {n}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
