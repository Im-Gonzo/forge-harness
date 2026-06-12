/**
 * Route-scoped types for the /budget dashboard — the `forge analyze --json`
 * data payload. Mirrors the live envelope shape (verified against the real
 * forge repo): per-artifact estimated token cost, the always-on TOTAL, and the
 * per-profile materialized cost. Kept local to the route (shared types.ts is
 * owned elsewhere).
 */
import type { ArtifactCriticality, ArtifactKind } from "@/lib/types";

/** How an artifact loads into context — drives whether it counts toward the always-on total. */
export type Residency = "always-on" | "conditional" | "on-demand";

/** Cost attribution within a single artifact (present for textual artifacts). */
export interface CostBreakdown {
  description?: number;
  body?: number;
  injection?: number;
  [part: string]: number | undefined;
}

/** One analyzed artifact with its estimated token cost. */
export interface AnalyzeArtifact {
  uid: string;
  kind: ArtifactKind;
  id: string;
  path: string;
  residency: Residency;
  /** Estimated context tokens this artifact contributes when resident. */
  estTokens: number;
  criticality: ArtifactCriticality;
  costBreakdown?: CostBreakdown;
}

/** Materialized cost for one profile (always-on floor + conditional ceiling). */
export interface ProfileCost {
  alwaysOn: number;
  conditionalCeiling: number;
}

/** Tuning constants the model used (char→token ratio, code density, thresholds). */
export interface AnalyzeConstants {
  CHARS_PER_TOKEN: number;
  CODE_DENSITY: number;
  MIN_SESSIONS: number;
  MIN_DAYS: number;
}

/** Telemetry availability — dynamic (usage-weighted) checks are off when unavailable. */
export interface AnalyzeTelemetry {
  available: boolean;
  sessions: number;
  windowDays: number;
}

/** A dead-code candidate surfaced by a static check (e.g. D2 "listed in no module"). */
export interface DeadCandidate {
  checkId: string;
  uid: string;
  evidence: string;
  recommend: boolean;
}

/** The `forge analyze` data payload. */
export interface AnalyzeData {
  constants: AnalyzeConstants;
  telemetry: AnalyzeTelemetry;
  artifacts: AnalyzeArtifact[];
  /** Sum of estTokens over all always-on artifacts — the headline number. */
  alwaysOnTotal: number;
  /** profileName → materialized cost. */
  perProfile: Record<string, ProfileCost>;
  deadStatic: DeadCandidate[];
  deadDynamic: DeadCandidate[];
  watch: unknown[];
  pruneCandidates: unknown[];
  lowActivitySafety: unknown[];
  notices: string[];
}
