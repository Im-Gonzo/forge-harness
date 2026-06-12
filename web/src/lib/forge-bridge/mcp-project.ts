/**
 * forge-bridge/mcp-project — the PROJECT-SCOPED MCP-servers surface (the `forge
 * mcp` CLI run AGAINST a specific project).
 *
 * ADDITIVE to the bridge: this module wires the project view's "MCP servers"
 * section to the `forge mcp` verbs WITHOUT changing any existing export. Import
 * its functions from THIS path (not the barrel index.ts).
 *
 * THE CRITICAL FACT (verified): `forge mcp` has NO positional project-dir arg —
 * it operates on the project at the CURRENT WORKING DIRECTORY. `mcp list`
 * resolves the catalog under cwd and reports each server's `enabled` from the
 * project's `<cwd>/.claude/settings.json`; `mcp enable/disable` plan a merge into
 * that same settings.json. The bridge's runForge spawns with cwd = FORGE_ROOT
 * (the library) by default, so to target a PROJECT we MUST pass
 * `{ cwd: projectPath }`. Every function here threads the project path as cwd.
 *
 * Each function returns the raw parsed C3 envelope (BridgeEnvelope<TData>) so the
 * caller/UI handle a degraded run exactly like any other envelope — fail-soft,
 * never throws (beyond the absolute-path guard).
 *
 * NOTE: server-only module (runForge → node:child_process). Import from server
 * components and route handlers only — never from a "use client" boundary.
 */
import path from "node:path";

import { FORGE_ROOT } from "@/lib/config";
import type { BridgeEnvelope } from "@/lib/types";

import { runForge } from "./run";

// ──────────────────────────────────────────────────────────────────────────
// CLI data payloads — mirror `forge mcp <verb> --json` data shapes (verified).
// ──────────────────────────────────────────────────────────────────────────

/** One catalog row as `mcp list` enumerates it (data.servers[]). */
export interface ProjectMcpServer {
  /** Catalog component name (the `<name>` arg for enable/disable). */
  name: string;
  /**
   * True when ALL of the component's mcpServers keys are present in the
   * project's `.claude/settings.json` (i.e. the component is fully enabled).
   */
  enabled: boolean;
  /** The mcpServers keys this catalog component contributes. */
  servers: string[];
}

/** `mcp list --json` data payload. */
export interface ProjectMcpListData {
  /** Absolute project root the listing ran against (the cwd). */
  rootDir: string;
  /** Absolute path of the MCP catalog dir the listing read from. */
  catalog: string;
  /** One row per catalog component (name + enabled + contributed keys). */
  servers: ProjectMcpServer[];
}

/**
 * The enable/disable plan: which mcpServers keys would be added/removed, and
 * which were skipped (already present) / missing (not present to remove).
 */
export interface ProjectMcpPlan {
  /** Keys that would be added to settings.json (enable). */
  add?: string[];
  /** Keys skipped because a same-named server already exists (enable). */
  skipped?: string[];
  /** Keys that would be removed from settings.json (disable). */
  remove?: string[];
  /** Keys missing from settings.json — nothing to remove (disable). */
  missing?: string[];
}

/** `mcp enable <name> [--apply] --json` data payload (preview unless { apply }). */
export interface ProjectMcpEnableData {
  /** The catalog component the verb targeted. */
  name: string;
  /** Absolute path of the settings.json the plan targets, or absent on error. */
  settingsPath?: string;
  /** True when --apply merged the plan into settings.json (else preview). */
  applied?: boolean;
  /** True when --apply actually wrote settings.json. */
  written?: boolean;
  /** The add/skip plan. */
  plan: ProjectMcpPlan;
}

/** `mcp disable <name> [--apply] --json` data payload (preview unless { apply }). */
export interface ProjectMcpDisableData {
  /** The catalog component the verb targeted. */
  name: string;
  /** Absolute path of the settings.json the plan targets, or absent on error. */
  settingsPath?: string;
  /** True when --apply removed the plan from settings.json (else preview). */
  applied?: boolean;
  /** True when --apply actually wrote settings.json. */
  written?: boolean;
  /** The remove/missing plan. */
  plan: ProjectMcpPlan;
}

// ──────────────────────────────────────────────────────────────────────────
// Path guard — every verb is cwd-scoped, so the project path MUST be absolute.
// ──────────────────────────────────────────────────────────────────────────

/** Assert the project path is a non-empty ABSOLUTE path (the cwd we spawn in). */
function assertAbsoluteProject(projectPath: string): string {
  if (!projectPath || typeof projectPath !== "string") {
    throw new Error("project path is required.");
  }
  if (projectPath.includes("\0")) {
    throw new Error("Unsafe project path.");
  }
  if (!path.isAbsolute(projectPath)) {
    throw new Error(
      `project path must be absolute: ${JSON.stringify(projectPath)}`,
    );
  }
  return projectPath;
}

/** Assert a non-empty catalog component name (the `<name>` verb arg). */
function assertName(name: string): string {
  if (!name || typeof name !== "string") {
    throw new Error("mcp server name is required.");
  }
  return name;
}

// ──────────────────────────────────────────────────────────────────────────
// Project-scoped mcp verbs — each runs `forge mcp <sub>` with cwd=project.
// ──────────────────────────────────────────────────────────────────────────

/**
 * `forge mcp list --json` (cwd = project) — enumerate the project's MCP catalog
 * with each component's enabled state (resolved from the project's settings.json).
 */
export function mcpProjectList(
  projectPath: string,
): Promise<BridgeEnvelope<ProjectMcpListData>> {
  const cwd = assertAbsoluteProject(projectPath);
  return runForge<ProjectMcpListData>("mcp", ["list"], { cwd });
}

/**
 * `forge mcp enable <name> [--apply] --json` (cwd = project) — plan/apply the
 * merge of a catalog component's mcpServers into the project's settings.json.
 * PREVIEW by default ({ apply:false }); pass { apply:true } to additively merge
 * (SKIP+WARN on an existing same-named server).
 */
export function mcpProjectEnable(
  projectPath: string,
  name: string,
  opts?: { apply?: boolean },
): Promise<BridgeEnvelope<ProjectMcpEnableData>> {
  const cwd = assertAbsoluteProject(projectPath);
  const server = assertName(name);
  const args = ["enable", server, ...(opts?.apply ? ["--apply"] : [])];
  return runForge<ProjectMcpEnableData>("mcp", args, { cwd });
}

/**
 * `forge mcp disable <name> [--apply] --json` (cwd = project) — plan/apply the
 * removal of a catalog component's mcpServers from the project's settings.json.
 * PREVIEW by default ({ apply:false }); pass { apply:true } to write the removal.
 */
export function mcpProjectDisable(
  projectPath: string,
  name: string,
  opts?: { apply?: boolean },
): Promise<BridgeEnvelope<ProjectMcpDisableData>> {
  const cwd = assertAbsoluteProject(projectPath);
  const server = assertName(name);
  const args = ["disable", server, ...(opts?.apply ? ["--apply"] : [])];
  return runForge<ProjectMcpDisableData>("mcp", args, { cwd });
}

// ──────────────────────────────────────────────────────────────────────────
// ACTIVE-ROOT mcp verbs — the SCOPED analogue of the project verbs above.
//
// These pass NO explicit cwd, so runForge defaults the spawn to the ACTIVE
// harness root (getActiveRoot). This is what the SCOPED /settings MCP surface
// uses: the active scope is already resolved inside the bridge, so the
// route/page need not thread a project path. Same C3 envelopes, same fail-soft.
// ──────────────────────────────────────────────────────────────────────────

/** `forge mcp list --json` (active root) — the active scope's MCP catalog. */
export function mcpList(): Promise<BridgeEnvelope<ProjectMcpListData>> {
  return runForge<ProjectMcpListData>("mcp", ["list"]);
}

/**
 * `forge mcp enable <name> [--apply] --json` (active root) — plan/apply the merge
 * of a catalog component's mcpServers into the active scope's settings.json.
 * PREVIEW by default; { apply:true } merges additively.
 */
export function mcpEnable(
  name: string,
  opts?: { apply?: boolean },
): Promise<BridgeEnvelope<ProjectMcpEnableData>> {
  const server = assertName(name);
  const args = ["enable", server, ...(opts?.apply ? ["--apply"] : [])];
  return runForge<ProjectMcpEnableData>("mcp", args);
}

/**
 * `forge mcp disable <name> [--apply] --json` (active root) — plan/apply the
 * removal of a catalog component's mcpServers from the active scope's
 * settings.json. PREVIEW by default; { apply:true } writes the removal.
 */
export function mcpDisable(
  name: string,
  opts?: { apply?: boolean },
): Promise<BridgeEnvelope<ProjectMcpDisableData>> {
  const server = assertName(name);
  const args = ["disable", server, ...(opts?.apply ? ["--apply"] : [])];
  return runForge<ProjectMcpDisableData>("mcp", args);
}

// ──────────────────────────────────────────────────────────────────────────
// MACHINE-ROOT mcp verbs — the LIBRARY-SCOPED analogue (cwd = FORGE_ROOT).
//
// The /mcp page renders TWO scopes: a MACHINE/global section (the library's own
// `.claude/settings.json`, where machine-level MCP servers are enabled) and a
// PROJECT section (the selected project, via the project verbs above). The
// machine verbs PIN cwd to FORGE_ROOT explicitly — independent of the active
// harness cookie — so the machine section is stable regardless of which project
// is currently selected. Same C3 envelopes, same fail-soft, same preview→apply.
// ──────────────────────────────────────────────────────────────────────────

/** `forge mcp list --json` (cwd = FORGE_ROOT) — the machine/library MCP catalog. */
export function mcpMachineList(): Promise<BridgeEnvelope<ProjectMcpListData>> {
  return runForge<ProjectMcpListData>("mcp", ["list"], { cwd: FORGE_ROOT });
}

/**
 * `forge mcp enable <name> [--apply] --json` (cwd = FORGE_ROOT) — plan/apply the
 * merge of a catalog component's mcpServers into the MACHINE (library)
 * settings.json. PREVIEW by default; { apply:true } merges additively.
 */
export function mcpMachineEnable(
  name: string,
  opts?: { apply?: boolean },
): Promise<BridgeEnvelope<ProjectMcpEnableData>> {
  const server = assertName(name);
  const args = ["enable", server, ...(opts?.apply ? ["--apply"] : [])];
  return runForge<ProjectMcpEnableData>("mcp", args, { cwd: FORGE_ROOT });
}

/**
 * `forge mcp disable <name> [--apply] --json` (cwd = FORGE_ROOT) — plan/apply the
 * removal of a catalog component's mcpServers from the MACHINE (library)
 * settings.json. PREVIEW by default; { apply:true } writes the removal.
 */
export function mcpMachineDisable(
  name: string,
  opts?: { apply?: boolean },
): Promise<BridgeEnvelope<ProjectMcpDisableData>> {
  const server = assertName(name);
  const args = ["disable", server, ...(opts?.apply ? ["--apply"] : [])];
  return runForge<ProjectMcpDisableData>("mcp", args, { cwd: FORGE_ROOT });
}
