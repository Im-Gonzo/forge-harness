/**
 * Telemetry route-scoped types — the `forge stat --json` (alias of
 * `telemetry stat`) data payload.
 *
 * Telemetry is opt-in and default-OFF. When off (or on-but-empty) the CLI
 * returns `data: null` with a single INFO finding (code TEL-OFF / TEL-EMPTY),
 * so `TelemetryStatData` is always nullable at the call site.
 *
 * When enabled and non-empty, `doStat` (forge/manager/telemetry.mjs) emits the
 * shape mirrored below.
 */

/** Per-rule hook deny stats. */
export interface DenyRate {
  rule: string;
  fires: number;
  denies: number;
  /** denies / fires, rounded to 3dp. */
  denyRate: number;
}

/** Agent/skill invocation count keyed by artifact_id (or event_type). */
export interface InvokeCount {
  key: string;
  count: number;
}

/** Per-rule hook duration percentiles. */
export interface SlowestHook {
  rule: string;
  p50: number | null;
  p95: number | null;
  n: number;
}

/** Daily event-count trend (last 14 days present in the store). */
export interface DailyTrend {
  /** ISO yyyy-mm-dd day keys, ascending. */
  days: string[];
  /** Event counts aligned 1:1 with `days`. */
  counts: number[];
  /** Unicode block sparkline (CLI convenience). */
  sparkline: string;
}

/** Typecheck pass/fail rollup. */
export interface TypecheckRollup {
  runs: number;
  fails: number;
  failPct: number;
}

/** The `forge stat` rollup when telemetry is enabled and non-empty. */
export interface TelemetryStatData {
  enabled: true;
  /** Total events in the (optionally since-filtered) window. */
  events: number;
  /** The --since window string, or null. */
  since: string | null;
  /** event_type -> count. */
  byType: Record<string, number>;
  denyRates: DenyRate[];
  typecheck: TypecheckRollup;
  mostInvoked: InvokeCount[];
  slowestHooks: SlowestHook[];
  trend: DailyTrend;
}
