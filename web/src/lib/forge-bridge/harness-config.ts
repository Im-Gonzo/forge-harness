/**
 * forge-bridge/harness-config — the HARNESS METADATA / DATA surface for /settings.
 *
 * /settings is now the harness CONFIG page (MCP management moved to /mcp). This
 * module surfaces what is READABLE about a harness scope through the CLI + on
 * disk, DUAL-SCOPE (machine/library vs the selected project):
 *
 *   - PROFILE FACTS — `forge profile --json` (deterministic stack facts). NOTE:
 *     `forge profile` delegates to bootstrap/profile-project.mjs which emits a
 *     RAW facts object, NOT a C3 envelope — so runForge() would reject it. We
 *     capture the raw JSON directly here (own spawn), fail-soft to null.
 *   - MARKER — `<root>/.forge.json`, the applied-harness marker (ADR-0009). When
 *     present it records the CHOSEN profile + module set + provenance. Read-only
 *     (written only by `forge init --apply`); absent for an un-applied harness.
 *   - MODULES + CRITICALITY — DERIVED from `forge registry build --json`
 *     (each artifact carries modules[] + criticality). Read-only (computed view).
 *   - ADJUDICATION POLICY — surfaced by the existing conflicts GET/POST (the one
 *     EDITABLE config: per-criticality auto|block).
 *   - ENV — FORGE_HOME + FORGE_WEB_SCAN_ROOT (read-only display).
 *
 * What is NOT here (no write verb exists, so NOT invented): there is no
 * `forge profile set` / `forge module add` verb — profile + modules are chosen
 * deterministically by `forge init` from facts and the bootstrap SKILL. So they
 * are surfaced READ-ONLY; the only editable config is the adjudication policy.
 *
 * The library scope reads its FORGE_ROOT marker / profile; a project scope reads
 * the SELECTED project's `<project>/.claude` (cwd-scoped CLI + on-disk marker).
 *
 * NOTE: server-only module (node:child_process / node:fs). Import from server
 * components and route handlers only — never from a "use client" boundary.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FORGE_BIN, FORGE_ROOT } from "@/lib/config";
import { SCAN_ROOT } from "@/lib/harness";
import type {
  BridgeEnvelope,
  ConflictsData,
  RegistryLsData,
} from "@/lib/types";

import { runForge } from "./run";

// ──────────────────────────────────────────────────────────────────────────
// Profile facts — the deterministic stack profile (raw JSON, NOT a C3 envelope)
// ──────────────────────────────────────────────────────────────────────────

/**
 * The subset of `forge profile --json` facts we surface. The profiler emits more
 * (`_meta`, evidence, intended hints); we keep the human-facing stack facts and
 * the spec-aware `intended` hint. All fields optional — fail-soft to a partial.
 */
export interface ProfileFacts {
  languages?: string[];
  packageManager?: Record<string, string>;
  frameworks?: string[];
  testRunner?: string[];
  database?: string | null;
  lintFormat?: string[];
  monorepo?: boolean;
  ci?: string[];
  hasTests?: boolean;
  /** Spec-aware "intended" stack (from docs), when present. */
  intended?: {
    languages?: string[];
    frameworks?: string[];
    database?: string | null;
  };
  /** Absolute target the profiler ran against (from `_meta.target`). */
  target?: string;
}

/**
 * Capture `forge profile --json` for a scope (cwd = the project's `.claude`, or
 * FORGE_ROOT for the machine/library). The profiler prints a RAW facts object on
 * stdout (delegated child), so we parse it directly rather than through runForge
 * (which expects a C3 envelope). Fail-soft: any spawn / parse error ⇒ null.
 */
export function readProfileFacts(cwd: string): Promise<ProfileFacts | null> {
  return new Promise<ProfileFacts | null>((resolve) => {
    let child;
    try {
      child = spawn("node", [FORGE_BIN, "profile", "--json"], {
        cwd,
        env: process.env,
      });
    } catch {
      resolve(null);
      return;
    }
    const out: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const raw = Buffer.concat(out).toString("utf8").trim();
      if (!raw) return resolve(null);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Recover the last JSON object if the profiler printed leading lines.
        const brace = raw.lastIndexOf("{");
        if (brace < 0) return resolve(null);
        try {
          parsed = JSON.parse(raw.slice(brace));
        } catch {
          return resolve(null);
        }
      }
      if (!parsed || typeof parsed !== "object") return resolve(null);
      const p = parsed as Record<string, unknown> & {
        _meta?: { target?: string };
      };
      resolve({
        languages: asStringArray(p.languages),
        packageManager: asStringRecord(p.packageManager),
        frameworks: asStringArray(p.frameworks),
        testRunner: asStringArray(p.testRunner),
        database: typeof p.database === "string" ? p.database : null,
        lintFormat: asStringArray(p.lintFormat),
        monorepo: p.monorepo === true,
        ci: asStringArray(p.ci),
        hasTests: p.hasTests === true,
        intended: asIntended(p.intended),
        target:
          typeof p._meta?.target === "string" ? p._meta.target : undefined,
      });
    });
  });
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asStringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function asIntended(v: unknown): ProfileFacts["intended"] {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  return {
    languages: asStringArray(o.languages),
    frameworks: asStringArray(o.frameworks),
    database: typeof o.database === "string" ? o.database : null,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Marker — the applied-harness marker (.forge.json): chosen profile + modules
// ──────────────────────────────────────────────────────────────────────────

/**
 * The fields of the applied-harness marker (`<root>/.forge.json`, ADR-0009) we
 * surface. Written only by `forge init --apply`; absent for an un-applied
 * harness (then the page falls back to "not yet applied — run forge init").
 */
export interface HarnessMarker {
  forgeVersion?: string;
  /** The CHOSEN profile name (e.g. "python-next-fullstack"). */
  profile?: string;
  /** The resolved module set the harness was rendered from. */
  modules?: string[];
  generatedAt?: string;
}

/**
 * Read the applied-harness marker for a scope. For the LIBRARY scope the marker
 * lives at `<FORGE_ROOT>/.forge.json`; for a PROJECT scope it lives at the
 * project's `<root>/.forge.json` (the `.claude` dir). Fail-soft: a missing /
 * unreadable / malformed marker ⇒ null (the harness was not `init`-applied).
 */
export async function readHarnessMarker(
  root: string,
): Promise<HarnessMarker | null> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, ".forge.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Record<string, unknown>;
  return {
    forgeVersion: typeof m.forgeVersion === "string" ? m.forgeVersion : undefined,
    profile: typeof m.profile === "string" ? m.profile : undefined,
    modules: asStringArray(m.modules),
    generatedAt: typeof m.generatedAt === "string" ? m.generatedAt : undefined,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Env — the read-only install-wide paths (FORGE_HOME + FORGE_WEB_SCAN_ROOT)
// ──────────────────────────────────────────────────────────────────────────

/** The install-wide env paths surfaced read-only on /settings. */
export interface HarnessEnv {
  /** FORGE_ROOT — the library/CLI root every machine read resolves against. */
  forgeRoot: string;
  /** FORGE_HOME ($FORGE_HOME or ~/.forge) — where global config + sources live. */
  forgeHome: string;
  /** Whether FORGE_HOME was set explicitly (vs the ~/.forge default). */
  forgeHomeFromEnv: boolean;
  /** FORGE_WEB_SCAN_ROOT — the root the project scan crawls. */
  scanRoot: string;
  /** Whether FORGE_WEB_SCAN_ROOT was set explicitly (vs the default). */
  scanRootFromEnv: boolean;
}

/**
 * Resolve FORGE_HOME exactly as the CLI / harness module does (forgeHome): the
 * `$FORGE_HOME` env override resolved to an absolute path, else `<home>/.forge`.
 */
function resolveForgeHome(): { home: string; fromEnv: boolean } {
  const env = process.env.FORGE_HOME;
  if (env) return { home: path.resolve(env), fromEnv: true };
  const home =
    process.env.HOME || process.env.USERPROFILE || os.homedir() || "";
  return { home: path.join(home, ".forge"), fromEnv: false };
}

/** Read the install-wide env paths (read-only display). Pure — touches no files. */
export function readHarnessEnv(): HarnessEnv {
  const { home, fromEnv } = resolveForgeHome();
  return {
    forgeRoot: FORGE_ROOT,
    forgeHome: home,
    forgeHomeFromEnv: fromEnv,
    scanRoot: SCAN_ROOT,
    scanRootFromEnv: Boolean(process.env.FORGE_WEB_SCAN_ROOT),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Scope-explicit registry + conflicts — pinned to a specific cwd (NOT the
// active-harness cookie). /settings renders the machine (FORGE_ROOT) AND the
// selected project side-by-side, so each read targets an EXPLICIT root rather
// than the cookie-resolved active root the default getRegistry/getConflicts use.
// ──────────────────────────────────────────────────────────────────────────

/**
 * `forge registry build --json` for an EXPLICIT scope (cwd). `build` (no
 * --write) computes the registry in-memory and persists nothing, so it works for
 * any scope without mutating it (same rationale as commands.ts#getRegistry).
 * Drives the read-only modules + criticality breakdown on /settings.
 */
export function readRegistryFor(
  cwd: string,
): Promise<BridgeEnvelope<RegistryLsData>> {
  return runForge<RegistryLsData>("registry", ["build"], { cwd });
}

/**
 * `forge conflict list --json` for an EXPLICIT scope (cwd) — read-only; carries
 * the per-criticality adjudication policy (the one EDITABLE config) + its store
 * path. /settings reads it per-scope; edits ride the existing /api/conflicts POST
 * (active root) — so the policy editor on /settings targets the ACTIVE scope.
 */
export function readConflictsFor(
  cwd: string,
): Promise<BridgeEnvelope<ConflictsData>> {
  return runForge<ConflictsData>("conflict", ["list"], { cwd });
}
