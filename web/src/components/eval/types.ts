/**
 * Eval route-scoped types — the `forge eval-harness --report --json` data
 * payload (forge/manager/eval-harness).
 *
 * Coverage = artifacts that ship a golden set. Each artifact carries an eval
 * record whose `grade` is "U" (UNEVALUATED) until a live reviewer run produces
 * metrics — the UI renders "U" as an em-dash, never 0.
 */

/** Coverage roll-up: how many catalogued artifacts ship a golden set. */
export interface EvalCoverage {
  covered: number;
  total: number;
  /** covered / total. */
  ratio: number;
  /** CLI duplicate fields (m===covered, n===total, with===covered, all===total). */
  m?: number;
  n?: number;
  with?: number;
  all?: number;
}

/** Letter grade or "U" (unevaluated). */
export type EvalGrade = "U" | "A" | "B" | "C" | "D" | "F" | string;

/** Per-artifact eval record. */
export interface EvalRecord {
  /** Grade, or "U" until a live reviewer run. */
  grade: EvalGrade;
  status: string;
  /** Health 0–1, or null when unevaluated. */
  health: number | null;
  /** k — replicates per case. */
  k: number;
  metrics: Record<string, unknown> | null;
  /** Hash of the artifact the last grading ran against. */
  graded_against_hash: string;
  /** ISO timestamp of last run, or null. */
  last_run: string | null;
}

/** One artifact with a golden set + its eval state. */
export interface EvalArtifact {
  uid: string;
  hasGoldenSet: boolean;
  /** Golden-set case ids. */
  cases: string[];
  eval: EvalRecord;
  /** CLI-rendered grade ("—" for U). */
  rendered: string;
  /** CLI display string ("—" for U). */
  display: string;
  /**
   * Artifact criticality tag ("safety" | "compliance" | "standard" | …), when
   * the report supplies it. Additive + optional: the coverage-gap rail sorts by
   * it (highest first); absent ⇒ treated as lowest priority.
   */
  criticality?: string;
}

/** Aggregate health across evaluated artifacts. */
export interface EvalHealth {
  n: number;
  count: number;
  evaluated: number;
}

/** The `forge eval-harness --report` payload. */
export interface EvalReportData {
  coverage: EvalCoverage;
  artifacts: EvalArtifact[];
  health: EvalHealth;
}
