/**
 * SettingsConfig — the READ-ONLY harness metadata/data panel for one scope.
 *
 * Presentational (no data layer, no client state): the /settings server page
 * resolves each scope's facts/marker/registry and hands them here. Surfaces, all
 * READ-ONLY (no write verb exists for these — profile + modules are chosen
 * deterministically by `forge init` from facts + the bootstrap SKILL, so there
 * is nothing to invent):
 *
 *   - PROFILE   — the CHOSEN profile from the applied-harness marker (.forge.json)
 *     when present; else "not applied" (the harness was never `forge init`-ed).
 *   - MODULES   — the marker's resolved module set when applied; otherwise the
 *     DERIVED module set (the distinct modules[] across the live registry).
 *   - CRITICALITY — the registry's per-criticality artifact breakdown (derived).
 *   - STACK FACTS — the deterministic `forge profile` facts (languages, frameworks,
 *     db, ci, monorepo) + the spec-aware "intended" hint.
 *
 * A "read-only" note is rendered so the user knows these are computed/applied,
 * not editable here (the editable config is the adjudication policy panel).
 */
import {
  Boxes,
  FileCog,
  FolderGit2,
  Info,
  Layers,
  ShieldAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  HarnessMarker,
  ProfileFacts,
} from "@/lib/forge-bridge/harness-config";

export interface SettingsConfigProps {
  /** Which scope this panel describes — drives the heading + icon. */
  scope: "machine" | "project";
  /** Human label of the scope (e.g. "Library" or the project dir name). */
  scopeLabel: string;
  /** The applied-harness marker (.forge.json), or null when not applied. */
  marker: HarnessMarker | null;
  /** The deterministic `forge profile` facts, or null on a degraded read. */
  facts: ProfileFacts | null;
  /** Distinct module set DERIVED from the live registry (the computed view). */
  derivedModules: string[];
  /** Per-criticality artifact counts DERIVED from the live registry. */
  criticality: { safety: number; compliance: number; normal: number };
  /** Total artifacts in the scope's registry (0 on a degraded read). */
  artifactCount: number;
  /** scope="project" with no project selected → a calm empty state. */
  noProject?: boolean;
}

/** A small label : value row. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 font-mono text-[10px] uppercase text-muted-foreground/60">
        {label}
      </span>
      <span className="min-w-0 font-mono text-[11px] text-foreground [overflow-wrap:anywhere]">
        {children}
      </span>
    </div>
  );
}

/** A muted chip list (e.g. languages / modules). Empty ⇒ a dash. */
function Chips({ items }: { items: string[] }) {
  if (!items.length)
    return <span className="text-muted-foreground/50">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((it) => (
        <Badge
          key={it}
          variant="outline"
          className="font-mono text-[10px] text-muted-foreground"
        >
          {it}
        </Badge>
      ))}
    </span>
  );
}

export function SettingsConfig({
  scope,
  scopeLabel,
  marker,
  facts,
  derivedModules,
  criticality,
  artifactCount,
  noProject,
}: SettingsConfigProps) {
  const ScopeIcon = scope === "project" ? FolderGit2 : Boxes;
  const modules = marker?.modules?.length ? marker.modules : derivedModules;
  const modulesSource = marker?.modules?.length
    ? "from the applied marker"
    : "derived from the live registry";

  return (
    <Card size="sm">
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center justify-between gap-2 font-mono text-sm">
          <span className="flex items-center gap-1.5">
            <ScopeIcon className="size-3.5" />
            {scope === "project" ? "Project config" : "Machine config"}
            <Badge
              variant="outline"
              className="font-mono text-[10px] uppercase text-muted-foreground"
              title={`scope: ${scopeLabel}`}
            >
              {scope === "project" ? "project" : "machine"}
            </Badge>
          </span>
          <Badge
            variant="outline"
            className="flex items-center gap-1 font-mono text-[10px] uppercase text-muted-foreground/70"
          >
            <Info className="size-3" />
            read-only
          </Badge>
        </CardTitle>
        <CardDescription className="font-mono text-[11px]">
          Harness metadata + data for <span>{scopeLabel}</span>. Profile + modules
          are chosen deterministically by <code>forge init</code> (from facts +
          the bootstrap SKILL) — there is no edit verb, so they are surfaced
          read-only here. The editable config is the adjudication policy below.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {noProject ? (
          <p className="font-mono text-[11px] italic text-muted-foreground/70">
            no project selected — pick a project on the Projects page to inspect
            its config.
          </p>
        ) : (
          <>
            {/* ── Profile + modules ─────────────────────────────────────── */}
            <div className="flex flex-col gap-1.5">
              <Field label="profile">
                {marker?.profile ? (
                  <span className="flex items-center gap-1.5">
                    <FileCog className="size-3 text-muted-foreground/60" />
                    {marker.profile}
                    {marker.forgeVersion ? (
                      <Badge
                        variant="outline"
                        className="font-mono text-[10px] text-muted-foreground/60"
                      >
                        forge {marker.forgeVersion}
                      </Badge>
                    ) : null}
                  </span>
                ) : (
                  <span className="italic text-muted-foreground/60">
                    not applied — run <code>forge init</code> to materialise a
                    profile.
                  </span>
                )}
              </Field>

              <Field label="modules">
                <span className="flex flex-col gap-1">
                  <Chips items={modules} />
                  <span className="font-mono text-[9px] text-muted-foreground/50">
                    {modulesSource}
                  </span>
                </span>
              </Field>
            </div>

            {/* ── Criticality breakdown (registry-derived) ──────────────── */}
            <div className="flex flex-col gap-1.5 border-t border-border pt-2">
              <Field label="criticality">
                <span className="flex flex-wrap items-center gap-1.5">
                  <CritBadge
                    label="safety"
                    n={criticality.safety}
                    tone="border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                  />
                  <CritBadge
                    label="compliance"
                    n={criticality.compliance}
                    tone="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                  />
                  <CritBadge
                    label="normal"
                    n={criticality.normal}
                    tone="border-border bg-muted/40 text-muted-foreground"
                  />
                  <span className="font-mono text-[9px] text-muted-foreground/50">
                    over {artifactCount} artifact{artifactCount === 1 ? "" : "s"}
                  </span>
                </span>
              </Field>
            </div>

            {/* ── Deterministic stack facts ─────────────────────────────── */}
            <div className="flex flex-col gap-1.5 border-t border-border pt-2">
              {facts ? (
                <>
                  <Field label="languages">
                    <Chips items={facts.languages ?? []} />
                  </Field>
                  <Field label="frameworks">
                    <Chips items={facts.frameworks ?? []} />
                  </Field>
                  <Field label="database">
                    {facts.database ? (
                      facts.database
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </Field>
                  <Field label="ci">
                    <Chips items={facts.ci ?? []} />
                  </Field>
                  <Field label="monorepo">
                    <Badge
                      variant="outline"
                      className="font-mono text-[10px] text-muted-foreground"
                    >
                      {facts.monorepo ? "yes" : "no"}
                    </Badge>
                  </Field>
                  {facts.intended &&
                  (facts.intended.languages?.length ||
                    facts.intended.frameworks?.length) ? (
                    <Field label="intended">
                      <span className="flex flex-col gap-1">
                        <Chips
                          items={[
                            ...(facts.intended.languages ?? []),
                            ...(facts.intended.frameworks ?? []),
                          ]}
                        />
                        <span className="font-mono text-[9px] text-muted-foreground/50">
                          spec-aware hint (from docs)
                        </span>
                      </span>
                    </Field>
                  ) : null}
                </>
              ) : (
                <p className="flex items-center gap-1.5 font-mono text-[10px] italic text-amber-600 dark:text-amber-400">
                  <ShieldAlert className="size-3" />
                  could not read the deterministic profile facts for this scope.
                </p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CritBadge({
  label,
  n,
  tone,
}: {
  label: string;
  n: number;
  tone: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("flex items-center gap-1 font-mono text-[10px]", tone)}
    >
      <Layers className="size-3" />
      {label} {n}
    </Badge>
  );
}
