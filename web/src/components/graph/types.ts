/**
 * Client-side types for the /graph route. These mirror the JSON the route's
 * read APIs (/api/graph, /api/graph-composition) return — kept route-local since
 * src/lib/types.ts is owned by Phase 0.
 */
import type { RegistryArtifact } from "@/lib/types";
import type {
  DanglingRef,
  DanglingSite,
  ProfilesManifest,
  ModulesManifest,
} from "@/lib/forge-bridge";

export type { RegistryArtifact, DanglingRef, DanglingSite };
export type { ProfilesManifest, ModulesManifest };

/** /api/graph response. */
export interface GraphData {
  ok: boolean;
  ts: string;
  artifacts: RegistryArtifact[];
  dangling: DanglingRef[];
  orphans: string[];
  findings: { level: string; message: string; path: string; line: number | null }[];
  bridgeError?: boolean;
}

/** /api/graph-composition response. */
export interface CompositionData {
  ok: boolean;
  ts: string;
  profiles?: ProfilesManifest;
  modules?: ModulesManifest;
  error?: string;
}

/** The shape every graph-edit response shares (validate findings + envelopes). */
export interface EditResponse {
  ok: boolean;
  error?: string;
  edited?: string[];
  findings?: { level: string; message: string; path: string; line: number | null }[];
  validate?: { summary?: { errors?: number; warnings?: number } };
  registry?: { ok?: boolean };
}

/** Stable color per artifact kind (oklch tokens defined in graph.css). */
export const KIND_COLORS: Record<string, string> = {
  agent: "var(--g-agent)",
  skill: "var(--g-skill)",
  command: "var(--g-command)",
  rule: "var(--g-rule)",
  hook: "var(--g-hook)",
  bundle: "var(--g-bundle)",
  // Distinct rose-pink hue; inline so no graph.css token is required.
  workflow: "oklch(0.72 0.18 350)",
  // Distinct cyan/teal hue; inline so no graph.css token is required.
  mcp: "oklch(0.72 0.13 200)",
  validator: "var(--g-validator)",
  "meta-test": "var(--g-meta-test)",
  engine: "var(--g-engine)",
  module: "var(--g-module)",
  profile: "var(--g-profile)",
};

export const ALL_KINDS = [
  "agent",
  "skill",
  "command",
  "rule",
  "hook",
  "bundle",
  "workflow",
  "mcp",
  "validator",
  "meta-test",
  "engine",
] as const;
