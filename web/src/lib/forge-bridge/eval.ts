/**
 * forge-bridge/eval — the append-only EVAL LEDGER read surface.
 *
 * ADDITIVE to the bridge: this module adds a read-only view over the eval
 * ledger without changing any existing export. The CLI grading pass
 * (`forge eval-harness <target>`) APPENDS one record per run to
 *   <activeRoot>/evals/harness/results/ledger.jsonl
 * (one JSON object per line; see eval-harness.mjs `appendLedger` / `deriveViews`).
 * The read is SCOPED to the active harness root (getActiveRoot), so the /eval
 * page's run history matches its bridge-scoped `eval-harness --report`.
 * The ledger is the source of truth (BR-EVAL-018); baselines.json + dashboard.md
 * derive from it.
 *
 * readEvalLedger() parses that JSONL FAIL-SOFT: a missing/empty file, a partial
 * write, or a malformed line never throws — bad lines are skipped, a missing
 * file yields []. groupLedgerByUid() rolls the flat records into per-artifact
 * history (most-recent-first) so the UI can show a run timeline per uid.
 *
 * NOTE: server-only module (node:fs). Import from server components and route
 * handlers only — never from a "use client" boundary.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { getActiveRoot } from "@/lib/harness";

/** Repo-relative path of the append-only eval ledger. */
const LEDGER_REL = path.join("evals", "harness", "results", "ledger.jsonl");

/**
 * One append-only ledger record — a single grading run for one artifact.
 *
 * The grading pass writes at least `{ uid, status, aut_hash, ts, metrics }`
 * (see `deriveViews` in eval-harness.mjs). All fields are optional here because
 * the ledger is lossy-by-design and may be written by future runs that carry
 * extra keys; readers must tolerate partial records. The index signature keeps
 * any additional run metadata addressable without a type change.
 */
export interface EvalLedgerRecord {
  /** Artifact under test ("<kind>:<id>"). */
  uid?: string;
  /** Run status (GREEN / REGRESSED / BLOCKED_BY_STATIC / UNEVALUATED / …). */
  status?: string;
  /** Letter grade or "U" when the run did not promote. */
  grade?: string;
  /** contentHash the run graded against (drift ⇒ computed-stale). */
  aut_hash?: string;
  /** ISO timestamp of the run. */
  ts?: string;
  /** Replicates per case. */
  k?: number;
  /** Per-run metric bag (catch_pow_k, clean_pow_k, fp_rate, …) or null. */
  metrics?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * Read + parse the append-only eval ledger, FAIL-SOFT.
 *
 * Returns [] when the file is missing or empty. Each non-blank line is parsed
 * independently; a line that is not valid JSON is skipped (never throws), so a
 * torn final write can never poison the whole read. Records are returned in
 * file order (append order — oldest first).
 */
export async function readEvalLedger(): Promise<EvalLedgerRecord[]> {
  // Scope to the ACTIVE harness root (#4): the eval-harness --report read on the
  // /eval page is bridge-scoped to getActiveRoot, so the ledger history must come
  // from the SAME scope — the SELECTED PROJECT's `evals/harness/results/ledger.jsonl`,
  // not a hardcoded FORGE_ROOT (which always read the library's ledger).
  const abs = path.join(await getActiveRoot(), LEDGER_REL);

  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch {
    // Missing ledger (no runs yet) — fail-soft to an empty history.
    return [];
  }

  const out: EvalLedgerRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as EvalLedgerRecord);
      }
    } catch {
      // Skip a malformed / partially-written line; the rest still read.
    }
  }
  return out;
}

/**
 * Group ledger records into per-uid history, MOST-RECENT-FIRST.
 *
 * Records without a `uid` are dropped (they cannot be attributed to an
 * artifact). Within a uid, records are sorted by `ts` descending (records with
 * no/unparseable `ts` sort last, keeping their relative append order) so the
 * first element of each list is the latest run for that artifact.
 */
export function groupLedgerByUid(
  records: EvalLedgerRecord[],
): Record<string, EvalLedgerRecord[]> {
  const byUid: Record<string, EvalLedgerRecord[]> = {};
  for (const rec of records) {
    if (!rec || typeof rec.uid !== "string" || !rec.uid) continue;
    (byUid[rec.uid] ??= []).push(rec);
  }
  for (const uid of Object.keys(byUid)) {
    byUid[uid].sort((a, b) => tsMillis(b.ts) - tsMillis(a.ts));
  }
  return byUid;
}

/** Parse an ISO timestamp to epoch ms; unparseable/absent ⇒ 0 (sorts last). */
function tsMillis(ts: string | undefined): number {
  if (!ts) return 0;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? 0 : n;
}
