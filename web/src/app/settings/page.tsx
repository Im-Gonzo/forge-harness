/**
 * /settings — the HARNESS METADATA / DATA config surface (DUAL-SCOPE).
 *
 * MCP-server management moved to its own /mcp page; /settings is now the harness
 * config page. It renders, for BOTH scopes (machine/library + the selected
 * project):
 *
 *   - read-only PROFILE + MODULES + CRITICALITY + stack facts (SettingsConfig) —
 *     profile/modules from the applied marker (.forge.json) or derived from the
 *     live registry; criticality + facts derived from registry + `forge profile`.
 *   - read-only ENVIRONMENT (SettingsEnv) — FORGE_ROOT / FORGE_HOME /
 *     FORGE_WEB_SCAN_ROOT, install-wide (shown once).
 *   - the EDITABLE adjudication policy (SettingsPolicy) — the one config with a
 *     write verb; it reuses the existing /api/conflicts policy POST, which
 *     targets the ACTIVE scope, so it edits whichever scope is active.
 *
 * WHAT IS READ-ONLY / DEFERRED (no write verb exists — not invented): profile +
 * modules (chosen deterministically by `forge init` / the bootstrap SKILL, no
 * `set` verb), criticality (a registry property), and the env paths (set at
 * launch). Only the adjudication policy is editable.
 *
 * Server component: resolves the active/selected project + reads each scope's
 * facts/marker/registry/policy in parallel, all fail-soft (a degraded read shows
 * an empty/defaulted panel, never throws).
 */
import { PageShell } from "@/components/page-shell";
import { SettingsConfig } from "@/components/settings/settings-config";
import { SettingsEnv } from "@/components/settings/settings-env";
import { SettingsPolicy } from "@/components/settings/settings-policy";
import { getActiveHarness, LIBRARY } from "@/lib/harness";
import { FORGE_ROOT } from "@/lib/config";
import {
  readConflictsFor,
  readHarnessEnv,
  readHarnessMarker,
  readProfileFacts,
  readRegistryFor,
} from "@/lib/forge-bridge/harness-config";
import type {
  AdjudicationPolicy,
  BridgeEnvelope,
  RegistryLsData,
} from "@/lib/types";

// Live state — render on every request, never cache.
export const dynamic = "force-dynamic";

const DEFAULT_POLICY: AdjudicationPolicy = {
  normal: "block",
  compliance: "block",
  safety: "block",
};

/** Derive the distinct module set + per-criticality counts from a registry read. */
function deriveRegistry(env: BridgeEnvelope<RegistryLsData> | null): {
  modules: string[];
  criticality: { safety: number; compliance: number; normal: number };
  count: number;
} {
  const artifacts = env?.ok ? (env.data.artifacts ?? []) : [];
  const modules = new Set<string>();
  const criticality = { safety: 0, compliance: 0, normal: 0 };
  for (const a of artifacts) {
    for (const m of a.modules ?? []) modules.add(m);
    if (a.criticality === "safety") criticality.safety += 1;
    else if (a.criticality === "compliance") criticality.compliance += 1;
    else criticality.normal += 1;
  }
  return {
    modules: [...modules].sort((x, y) => x.localeCompare(y)),
    criticality,
    count: artifacts.length,
  };
}

export default async function SettingsPage() {
  const active = await getActiveHarness();
  const project = active.kind === "project" ? active : null;
  const projectRoot = project?.root ?? null;

  // Read everything per-scope in parallel (all fail-soft). Machine reads pin to
  // FORGE_ROOT; project reads target the selected project's `.claude` (skipped
  // when no project is selected). The policy editor edits the ACTIVE scope, so we
  // read the policy for whichever scope is active (project if selected, else
  // machine) — that is the scope its POST will write.
  const [
    machineMarker,
    machineFacts,
    machineRegistry,
    projectMarker,
    projectFacts,
    projectRegistry,
    activeConflicts,
  ] = await Promise.all([
    readHarnessMarker(FORGE_ROOT),
    readProfileFacts(FORGE_ROOT),
    readRegistryFor(FORGE_ROOT),
    projectRoot ? readHarnessMarker(projectRoot) : Promise.resolve(null),
    projectRoot ? readProfileFacts(projectRoot) : Promise.resolve(null),
    projectRoot
      ? readRegistryFor(projectRoot)
      : Promise.resolve(null),
    // Policy: read against the ACTIVE scope (the scope the editor will write).
    readConflictsFor(active.root),
  ]);

  const machineDerived = deriveRegistry(machineRegistry);
  const projectDerived = deriveRegistry(projectRegistry);

  const env = readHarnessEnv();

  const policyOk = activeConflicts.ok;
  const policy = policyOk
    ? (activeConflicts.data.policy ?? DEFAULT_POLICY)
    : DEFAULT_POLICY;
  const storePath = policyOk
    ? (activeConflicts.data.adjudicationPath ?? null)
    : null;

  return (
    <PageShell
      title="Settings"
      description="Harness metadata + data config — machine (library) and the selected project."
    >
      <div className="grid gap-4">
        {/* Machine (library) config — always available. */}
        <SettingsConfig
          scope="machine"
          scopeLabel={LIBRARY.label}
          marker={machineMarker}
          facts={machineFacts}
          derivedModules={machineDerived.modules}
          criticality={machineDerived.criticality}
          artifactCount={machineDerived.count}
        />

        {/* Selected-project config — empty state when no project is selected. */}
        <SettingsConfig
          scope="project"
          scopeLabel={project?.label ?? "no project selected"}
          marker={projectMarker}
          facts={projectFacts}
          derivedModules={projectDerived.modules}
          criticality={projectDerived.criticality}
          artifactCount={projectDerived.count}
          noProject={!projectRoot}
        />

        {/* The one EDITABLE config — targets the ACTIVE scope. */}
        <SettingsPolicy
          policy={policy}
          storePath={storePath}
          scopeLabel={active.label}
          degraded={!policyOk}
        />

        {/* Install-wide env paths (read-only, shown once). */}
        <SettingsEnv env={env} />
      </div>
    </PageShell>
  );
}
