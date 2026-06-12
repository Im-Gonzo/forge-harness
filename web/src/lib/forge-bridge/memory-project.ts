/**
 * forge-bridge/memory-project — the PROJECT-SCOPED memory surface (the `forge
 * memory` CLI run AGAINST a specific project).
 *
 * ADDITIVE to the bridge: this module wires the project view's Memory tab to the
 * `forge memory` verbs WITHOUT changing any existing export. Import its functions
 * from THIS path (not the barrel index.ts).
 *
 * THE CRITICAL FACT (verified): `forge memory` has NO positional project-dir arg.
 * Its findMemoryDir resolves the vault from the CURRENT WORKING DIRECTORY —
 * `<cwd>/.claude/memory`, then `<cwd>/memory`. The bridge's runForge spawns with
 * cwd = FORGE_ROOT (the library) by default, so to target a PROJECT we MUST pass
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

import type { BridgeEnvelope } from "@/lib/types";

import { runForge } from "./run";

// ──────────────────────────────────────────────────────────────────────────
// CLI data payloads — mirror `forge memory <verb> --json` data shapes.
// ──────────────────────────────────────────────────────────────────────────

/** One entry row as `memory list` enumerates it (data.entries[]). */
export interface ProjectMemoryEntry {
  /** Stable id (the `<type>-NNNN` stem), or "" for a non-entry file (e.g. README). */
  id: string;
  /** Entry type taxonomy (decision | glossary | gotcha | learning | runbook), or "". */
  type: string;
  /** active | superseded | deprecated | "" (lifecycle). */
  status: string;
  /** Human title from frontmatter, or "". */
  title: string;
  /** Numeric confidence (0–1), or null when absent. */
  confidence: number | null;
  /** Path relative to the memory dir (e.g. "gotchas/g-0001-….md"). */
  rel: string;
}

/** `memory list --json` data payload. */
export interface ProjectMemoryListData {
  /** Absolute resolved memory dir, or null when no vault was found. */
  memDir: string | null;
  /** One row per enumerated `*.md` file (entries + non-entry files). */
  entries: ProjectMemoryEntry[];
}

/** `memory validate --json` data payload (findings carry the C3 details). */
export interface ProjectMemoryValidateData {
  /** Absolute project root the validation ran against. */
  rootDir: string;
  /** Overall pass — false when any ERROR finding was raised. */
  passed: boolean;
}

/** `memory reindex --json` data payload (dry-run unless { write }). */
export interface ProjectMemoryReindexData {
  /** Absolute resolved memory dir, or null when no vault was found. */
  memDir: string | null;
  /** Absolute path of the index file the reindex targets. */
  indexPath: string | null;
  /** The generated index markdown (the would-be / written content). */
  index: string;
  /** True when --write persisted the index (absent/false on a dry run). */
  written?: boolean;
  /** Count of ACTIVE entries that fed the regenerated index. */
  activeEntries?: number;
}

/** One planned create/skip in `memory import` (shape kept permissive). */
export interface ProjectMemoryImportItem {
  /** Source-relative path the item maps from. */
  from?: string;
  /** Target path under the forge vault the item maps to. */
  to?: string;
  /** Reason a skipped item was skipped (skipped[] only). */
  reason?: string;
  [key: string]: unknown;
}

/** `memory import <srcDir> --json` data payload (preview unless { apply }). */
export interface ProjectMemoryImportData {
  /** The mapping plan: entries that would be created vs skipped. */
  plan: {
    create: ProjectMemoryImportItem[];
    skipped: ProjectMemoryImportItem[];
  };
  /** True when --apply wrote the plan (absent/false on a preview). */
  applied?: boolean;
  /** Count of files written when applied. */
  written?: number;
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

// ──────────────────────────────────────────────────────────────────────────
// Project-scoped memory verbs — each runs `forge memory <sub>` with cwd=project.
// ──────────────────────────────────────────────────────────────────────────

/**
 * `forge memory list --json` (cwd = project) — enumerate the project's vault.
 * Fail-soft: no vault ⇒ `{ memDir: null, entries: [] }` (the CLI's own shape).
 */
export function projectMemoryList(
  projectPath: string,
): Promise<BridgeEnvelope<ProjectMemoryListData>> {
  const cwd = assertAbsoluteProject(projectPath);
  return runForge<ProjectMemoryListData>("memory", ["list"], { cwd });
}

/**
 * `forge memory validate --json` (cwd = project) — C3 integrity findings for the
 * project's vault. Advisory: a failing validate is an `ok:false` envelope whose
 * findings carry the per-file ERRORs, never a thrown exception.
 */
export function projectMemoryValidate(
  projectPath: string,
): Promise<BridgeEnvelope<ProjectMemoryValidateData>> {
  const cwd = assertAbsoluteProject(projectPath);
  return runForge<ProjectMemoryValidateData>("memory", ["validate"], { cwd });
}

/**
 * `forge memory reindex [--write] --json` (cwd = project) — regenerate the vault
 * index from ACTIVE entries. DRY-RUN by default ({ write:false }); pass
 * { write:true } to persist index.md.
 */
export function projectMemoryReindex(
  projectPath: string,
  opts?: { write?: boolean },
): Promise<BridgeEnvelope<ProjectMemoryReindexData>> {
  const cwd = assertAbsoluteProject(projectPath);
  const args = ["reindex", ...(opts?.write ? ["--write"] : [])];
  return runForge<ProjectMemoryReindexData>("memory", args, { cwd });
}

/**
 * `forge memory import <srcDir> [--apply] --json` (cwd = project) — map a foreign
 * vault at `srcDir` into the project's forge schema. PREVIEW by default
 * ({ apply:false }); pass { apply:true } to write the plan.
 */
export function projectMemoryImport(
  projectPath: string,
  srcDir: string,
  opts?: { apply?: boolean },
): Promise<BridgeEnvelope<ProjectMemoryImportData>> {
  const cwd = assertAbsoluteProject(projectPath);
  if (!srcDir || typeof srcDir !== "string") {
    throw new Error("import source dir is required.");
  }
  const args = ["import", srcDir, ...(opts?.apply ? ["--apply"] : [])];
  return runForge<ProjectMemoryImportData>("memory", args, { cwd });
}

// ──────────────────────────────────────────────────────────────────────────
// ACTIVE-ROOT memory verbs — the SCOPED analogue of the project verbs above.
//
// These pass NO explicit cwd, so runForge defaults the spawn to the ACTIVE
// harness root (getActiveRoot — the library, or the selected project's
// `.claude/`). This is what the SCOPED /memory management surface uses: the
// active scope is already resolved inside the bridge, so the route/page need not
// thread a project path. Same C3 envelopes, same fail-soft behaviour.
// ──────────────────────────────────────────────────────────────────────────

/** `forge memory validate --json` (active root) — integrity findings. */
export function memoryValidate(): Promise<
  BridgeEnvelope<ProjectMemoryValidateData>
> {
  return runForge<ProjectMemoryValidateData>("memory", ["validate"]);
}

/** `forge memory list --json` (active root) — the active scope's vault entries. */
export function memoryList(): Promise<BridgeEnvelope<ProjectMemoryListData>> {
  return runForge<ProjectMemoryListData>("memory", ["list"]);
}

/**
 * `forge memory reindex [--write] --json` (active root) — regenerate the index
 * from ACTIVE entries. DRY-RUN by default; pass { write:true } to persist.
 */
export function memoryReindex(opts?: {
  write?: boolean;
}): Promise<BridgeEnvelope<ProjectMemoryReindexData>> {
  const args = ["reindex", ...(opts?.write ? ["--write"] : [])];
  return runForge<ProjectMemoryReindexData>("memory", args);
}

/**
 * `forge memory import <srcDir> [--apply] --json` (active root) — map a foreign
 * vault into the active scope's forge schema. PREVIEW by default; { apply:true }
 * writes the plan (additive — never overwrites).
 */
export function memoryImport(
  srcDir: string,
  opts?: { apply?: boolean },
): Promise<BridgeEnvelope<ProjectMemoryImportData>> {
  if (!srcDir || typeof srcDir !== "string") {
    throw new Error("import source dir is required.");
  }
  const args = ["import", srcDir, ...(opts?.apply ? ["--apply"] : [])];
  return runForge<ProjectMemoryImportData>("memory", args);
}
