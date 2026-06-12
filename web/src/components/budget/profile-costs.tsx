"use client";

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChevronRight } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { kindColor } from "@/components/budget/kind-colors";
import { groupProfileByModule } from "@/components/budget/whatif";
import { OpenInEditor } from "@/components/open-in-editor";
import type { AnalyzeArtifact, ProfileCost } from "@/app/budget/analyze-types";
import type { ArtifactKind, ResourceKind } from "@/lib/types";
import type { ProfilesManifest, ModulesManifest } from "@/lib/forge-bridge";

interface ProfileCostsProps {
  /** profileName → { alwaysOn, conditionalCeiling }. */
  perProfile: Record<string, ProfileCost>;
  /** All analyzed artifacts — for the per-profile drill-down (looked up by uid). */
  artifacts?: AnalyzeArtifact[];
  /** profiles manifest (profile→modules) — for the drill-down. */
  profiles?: ProfilesManifest;
  /**
   * modules manifest (module→components) — required to resolve a profile's
   * always-on component set. Additive/optional: the workspace's leaf contract
   * does not thread this yet, so the drill-down degrades to an explicit
   * "unavailable" state until `composition.modules` is passed through.
   */
  modules?: ModulesManifest;
}

interface ProfileDatum {
  profile: string;
  alwaysOn: number;
  conditionalCeiling: number;
  materialized: number;
}

const fmt = new Intl.NumberFormat("en-US");

/** recharts v3 LabelList formatter receives RenderableText; coerce to a number string. */
function tokenLabel(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? fmt.format(n) : "";
}

/**
 * The artifact kinds that have an in-app editor route. validator / meta-test /
 * engine are not editable on disk, so they render without an edit affordance.
 * Mirrors budget-charts' EDITABLE_KINDS precedent.
 */
const EDITABLE_KINDS: Record<string, ResourceKind> = {
  agent: "agent",
  skill: "skill",
  command: "command",
  rule: "rule",
  bundle: "bundle",
  hook: "hook",
};

function editorKind(kind: ArtifactKind): ResourceKind | null {
  return EDITABLE_KINDS[kind] ?? null;
}

const FLOOR_COLOR = "oklch(0.62 0.17 25)"; // always-on floor (matches "rule" red — the budget's heavy hitter)
const CEILING_COLOR = "oklch(0.60 0.16 255)"; // conditional ceiling (blue)

function ProfileTooltip({ active, payload, label }: TooltipState) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload as ProfileDatum | undefined;
  if (!d) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 font-mono text-[11px] shadow-md">
      <div className="font-semibold text-foreground">{label}</div>
      <div className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
        <span>
          always-on floor:{" "}
          <span className="text-foreground">{fmt.format(d.alwaysOn)}</span> tok
        </span>
        <span>
          conditional ceiling:{" "}
          <span className="text-foreground">{fmt.format(d.conditionalCeiling)}</span> tok
        </span>
        <span className="border-t border-border pt-0.5">
          max materialized:{" "}
          <span className="text-foreground">{fmt.format(d.materialized)}</span> tok
        </span>
      </div>
    </div>
  );
}

interface TooltipState {
  active?: boolean;
  label?: string;
  payload?: { payload: ProfileDatum }[];
}

export function ProfileCosts({
  perProfile,
  artifacts,
  profiles,
  modules,
}: ProfileCostsProps) {
  const data: ProfileDatum[] = useMemo(
    () =>
      Object.entries(perProfile)
        .map(([profile, c]) => ({
          profile,
          alwaysOn: c.alwaysOn,
          conditionalCeiling: c.conditionalCeiling,
          materialized: c.alwaysOn + c.conditionalCeiling,
        }))
        .sort((a, b) => b.materialized - a.materialized),
    [perProfile],
  );

  const peak = useMemo(
    () => data.reduce((m, d) => (d.materialized > m.materialized ? d : m), data[0]),
    [data],
  );

  // Which profile rows are expanded in the drill-down list.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (profile: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(profile)) next.delete(profile);
      else next.add(profile);
      return next;
    });

  // uid → artifact, so a grouped uid can be rendered (kind/id/cost/edit link).
  const byUid = useMemo(() => {
    const m = new Map<string, AnalyzeArtifact>();
    for (const a of artifacts ?? []) m.set(a.uid, a);
    return m;
  }, [artifacts]);

  // The drill-down can resolve a profile's components only with both manifests
  // and the analyzed artifacts. Without them, expansion shows an explicit
  // "unavailable" note instead of a misleading empty list.
  const canDrillDown = Boolean(profiles && modules && (artifacts?.length ?? 0) > 0);

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-sm">Per-profile materialized cost</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="font-mono text-xs text-muted-foreground">No profiles in this analysis.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="gap-1">
        <CardTitle className="font-mono text-sm">Per-profile materialized cost</CardTitle>
        <CardDescription className="font-mono text-[11px]">
          Always-on floor + conditional ceiling per profile · peak{" "}
          <span className="text-foreground">{peak?.profile}</span> at{" "}
          <span className="text-foreground">{fmt.format(peak?.materialized ?? 0)}</span> tok
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ height: Math.max(220, data.length * 46 + 48) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              layout="vertical"
              margin={{ top: 4, right: 64, bottom: 4, left: 8 }}
              barCategoryGap={10}
            >
              <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis
                type="number"
                tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                stroke="var(--muted-foreground)"
                tickFormatter={(v: number) => fmt.format(v)}
              />
              <YAxis
                type="category"
                dataKey="profile"
                width={150}
                interval={0}
                tick={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                stroke="var(--muted-foreground)"
              />
              <Tooltip
                cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                content={<ProfileTooltip />}
              />
              <Bar
                dataKey="alwaysOn"
                stackId="cost"
                fill={FLOOR_COLOR}
                isAnimationActive={false}
                name="always-on"
              />
              <Bar
                dataKey="conditionalCeiling"
                stackId="cost"
                fill={CEILING_COLOR}
                radius={[0, 3, 3, 0]}
                isAnimationActive={false}
                name="conditional ceiling"
              >
                <LabelList
                  dataKey="materialized"
                  position="right"
                  formatter={tokenLabel}
                  className="fill-muted-foreground"
                  style={{ fontSize: 10, fontFamily: "var(--font-mono)" }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-3 flex items-center gap-4 font-mono text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-[2px]" style={{ background: FLOOR_COLOR }} />
            always-on floor
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-[2px]" style={{ background: CEILING_COLOR }} />
            conditional ceiling
          </span>
        </div>

        {/*
          Per-profile drill-down. Each profile row expands to list the always-on
          components it pulls in (profile → modules → components), resolved by
          intersecting the modules manifest with the analyzed always-on
          artifacts via whatif.groupProfileByModule — grouping forge's own
          numbers, never recomputing cost. Each component links to its editor.
        */}
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-2 font-mono text-[11px] text-muted-foreground">
            Expand a profile for its always-on components
          </p>
          {canDrillDown ? (
            <ul className="flex flex-col gap-0.5">
              {data.map((d) => (
                <ProfileRow
                  key={d.profile}
                  profile={d.profile}
                  alwaysOn={d.alwaysOn}
                  open={expanded.has(d.profile)}
                  onToggle={() => toggleExpanded(d.profile)}
                  profiles={profiles}
                  modules={modules}
                  artifacts={artifacts ?? []}
                  byUid={byUid}
                />
              ))}
            </ul>
          ) : (
            <p className="font-mono text-[11px] text-muted-foreground">
              Component drill-down unavailable — the composition manifests
              (profiles + modules) could not be read.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** One expandable profile in the drill-down list. */
interface ProfileRowProps {
  profile: string;
  alwaysOn: number;
  open: boolean;
  onToggle: () => void;
  profiles?: ProfilesManifest;
  modules?: ModulesManifest;
  artifacts: AnalyzeArtifact[];
  byUid: Map<string, AnalyzeArtifact>;
}

function ProfileRow({
  profile,
  alwaysOn,
  open,
  onToggle,
  profiles,
  modules,
  artifacts,
  byUid,
}: ProfileRowProps) {
  // Flatten the per-module groups into one list of always-on components,
  // de-duplicated by uid (a component shared across a profile's modules counts
  // once) and sorted by descending cost.
  const components = useMemo(() => {
    if (!open) return [];
    const groups = groupProfileByModule(profile, profiles, modules, artifacts);
    const seen = new Set<string>();
    const rows: { uid: string; kind: ArtifactKind; id: string; estTokens: number }[] = [];
    for (const g of groups) {
      for (const uid of g.uids) {
        if (seen.has(uid)) continue;
        const a = byUid.get(uid);
        if (!a) continue;
        seen.add(uid);
        rows.push({ uid, kind: a.kind, id: a.id, estTokens: a.estTokens });
      }
    }
    rows.sort((a, b) => b.estTokens - a.estTokens);
    return rows;
  }, [open, profile, profiles, modules, artifacts, byUid]);

  return (
    <li className="rounded-md">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 font-mono text-[11px] hover:bg-muted/50"
      >
        <ChevronRight
          className={
            "size-3 shrink-0 text-muted-foreground transition-transform " +
            (open ? "rotate-90" : "")
          }
        />
        <span className="truncate text-foreground" title={profile}>
          {profile}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          <span className="text-foreground">{fmt.format(alwaysOn)}</span> tok
          always-on
        </span>
      </button>

      {open ? (
        components.length > 0 ? (
          <ul className="mb-1 ml-4 flex flex-col gap-0.5 border-l border-border pl-3">
            {components.map((c) => {
              const linkKind = editorKind(c.kind);
              return (
                <li
                  key={c.uid}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 font-mono text-[11px] hover:bg-muted/50"
                >
                  <span
                    className="inline-block size-2.5 shrink-0 rounded-[2px]"
                    style={{ background: kindColor(c.kind) }}
                  />
                  <span className="truncate text-foreground" title={c.id}>
                    {c.id}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{c.kind}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    <span className="text-foreground">{fmt.format(c.estTokens)}</span> tok
                  </span>
                  {linkKind ? (
                    <OpenInEditor
                      kind={linkKind}
                      id={c.id}
                      iconOnly
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 text-muted-foreground"
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mb-1 ml-4 border-l border-border py-1 pl-3 font-mono text-[11px] text-muted-foreground">
            No always-on components resolved for this profile.
          </p>
        )
      ) : null}
    </li>
  );
}
