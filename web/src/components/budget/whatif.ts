/**
 * whatif — PURE what-if math for the budget dashboard (no React, no IO).
 *
 * CRITICAL BOUNDARY: this does NOT reimplement forge's cost model. The only
 * allowed math is SUMMING / filtering the per-artifact token numbers that
 * `forge analyze` already returned (AnalyzeArtifact.estTokens). "Dropping" a set
 * of selected artifacts simply subtracts their always-on token cost from the
 * always-on total — the headline number forge computed.
 *
 * Identity is the stable artifact `uid` ("<kind>:<id>") — the same key the
 * registry and graph use; selection state is a Set<uid>.
 */
import type { AnalyzeArtifact } from "@/app/budget/analyze-types";
import type { ProfilesManifest, ModulesManifest } from "@/lib/forge-bridge";

/** Result of a what-if drop: tokens removed and the percentage of the always-on total. */
export interface Savings {
  /** Sum of always-on estTokens over the selected artifacts. */
  tokens: number;
  /** `tokens` as a percentage of the always-on total (0 when the total is 0). */
  pct: number;
}

/**
 * Sum the ALWAYS-ON token cost of the selected artifacts and express it as a
 * percentage of the always-on total. Only `residency === "always-on"` artifacts
 * count toward the budget, so a selected conditional/on-demand artifact (should
 * one ever be selectable) contributes nothing — mirroring how the headline total
 * is built. Unknown uids are ignored.
 */
export function computeSavings(
  selectedUids: Set<string>,
  artifacts: AnalyzeArtifact[],
): Savings {
  if (selectedUids.size === 0) return { tokens: 0, pct: 0 };

  let tokens = 0;
  let alwaysOnTotal = 0;
  for (const a of artifacts) {
    if (a.residency !== "always-on") continue;
    alwaysOnTotal += a.estTokens;
    if (selectedUids.has(a.uid)) tokens += a.estTokens;
  }

  const pct = alwaysOnTotal > 0 ? (tokens / alwaysOnTotal) * 100 : 0;
  return { tokens, pct };
}

// ──────────────────────────────────────────────────────────────────────────
// profile → component grouping (pure manifest math)
// ──────────────────────────────────────────────────────────────────────────

/**
 * The manifests address components by their PLURAL kind key (e.g. "skills",
 * "agents", "validators"), while an artifact's `kind` is SINGULAR ("skill",
 * "agent", "validator"). This maps a manifest componentKind back to the artifact
 * kind so a manifest component (kind + id) can be matched to an analyzed
 * artifact by uid. Special cases: "engine" is already singular; "validators" →
 * "validator". Everything else is the key minus a trailing "s".
 */
export function componentKindToArtifactKind(componentKind: string): string {
  if (componentKind === "engine") return "engine";
  if (componentKind === "validators") return "validator";
  return componentKind.endsWith("s") ? componentKind.slice(0, -1) : componentKind;
}

/** The stable uid for an analyzed/registry artifact. */
export function artifactUid(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/** A module a profile pulls in, and the always-on artifacts it contributes. */
export interface ProfileComponentGroup {
  /** Module name (key in modules.json). */
  module: string;
  /** uids of always-on artifacts this module contributes (present in `artifacts`). */
  uids: string[];
  /** Sum of estTokens over `uids`. */
  tokens: number;
}

/**
 * Group a profile's always-on token cost BY MODULE.
 *
 * Walks the profile's module list, expands each module's `components` (plural
 * kind → ids) into candidate uids, intersects with the analyzed always-on
 * artifacts (so we only count what actually exists and is resident), and sums
 * estTokens. This is pure manifest∩analysis math — no cost model, just summing
 * the numbers forge already returned. Modules that contribute no resident
 * artifact are omitted. Result is sorted by descending tokens.
 *
 * Returns an empty array when the profile / manifests are unavailable.
 */
export function groupProfileByModule(
  profileName: string,
  profiles: ProfilesManifest | undefined,
  modules: ModulesManifest | undefined,
  artifacts: AnalyzeArtifact[],
): ProfileComponentGroup[] {
  const profile = profiles?.profiles?.[profileName];
  if (!profile || !modules) return [];

  // Fast lookup of resident always-on artifacts by uid.
  const alwaysOnByUid = new Map<string, AnalyzeArtifact>();
  for (const a of artifacts) {
    if (a.residency === "always-on") alwaysOnByUid.set(a.uid, a);
  }

  const groups: ProfileComponentGroup[] = [];
  for (const moduleName of profile.modules ?? []) {
    const def = modules.modules?.[moduleName];
    if (!def?.components) continue;

    const uids: string[] = [];
    let tokens = 0;
    for (const [componentKind, ids] of Object.entries(def.components)) {
      const artifactKind = componentKindToArtifactKind(componentKind);
      for (const id of ids ?? []) {
        const uid = artifactUid(artifactKind, id);
        const hit = alwaysOnByUid.get(uid);
        if (hit) {
          uids.push(uid);
          tokens += hit.estTokens;
        }
      }
    }

    if (uids.length > 0) groups.push({ module: moduleName, uids, tokens });
  }

  groups.sort((a, b) => b.tokens - a.tokens);
  return groups;
}
