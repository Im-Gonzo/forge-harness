/**
 * Catalog route — shared presentational helpers + the CLIENT-SIDE mirror of the
 * T2 admit gate.
 *
 * Route-scoped (owned by /catalog). The badge variants/accents render the four
 * catalog axes (provenance · dedup · security · admission); `computeGateReasons`
 * REPLICATES manager/catalog.mjs#evaluateAdmitGate so the UI can decide, BEFORE
 * calling the bridge, whether an admit needs a human `--override` and SHOW the
 * exact reasons. The CLI remains authoritative — this is advisory surfacing so
 * Admit is never a silent activation when the gate would block (ADR-0017 §5a).
 */
import type {
  CatalogAdmissionState,
  CatalogAuditorVerdict,
  CatalogDedupClass,
  CatalogRecord,
  CatalogScanState,
} from "@/lib/types";
import type { StatusTone } from "@/components/forge";

// ──────────────────────────────────────────────────────────────────────────
// Gate constants — mirrored VERBATIM from manager/catalog.mjs (the authority).
// ──────────────────────────────────────────────────────────────────────────

/** Executable kinds: ALWAYS require auditor verdicts + human override (§5a). */
const EXECUTABLE_KINDS: ReadonlySet<string> = new Set(["hook", "command"]);
/** The trust a source must carry before an executable kind may be admitted. */
const TRUST_REVIEWED = "reviewed";
/** scan states the admit gate REFUSES on (blocked unless --override). */
const BLOCKING_SCAN_STATES: ReadonlySet<CatalogScanState> = new Set([
  "flagged",
  "quarantined",
]);
/** Auditor verdicts the admit gate REFUSES on (adverse). */
const ADVERSE_AUDITOR_VERDICTS: ReadonlySet<string> = new Set([
  "malicious",
  "suspicious",
]);

const INJECTION_AUDITOR = "injection-auditor";
const REPO_SAFETY_AUDITOR = "repo-safety-auditor";
/** Raw repo-safety verdicts treated as adverse even if recorded verbatim. */
const REPO_SAFETY_RAW_ADVERSE: ReadonlySet<string> = new Set([
  "risky",
  "malicious",
]);

// ──────────────────────────────────────────────────────────────────────────
// T2 admit-gate mirror (client-side, advisory — the CLI is authoritative)
// ──────────────────────────────────────────────────────────────────────────

/** True when a record came from a registered SOURCE (untrusted catalog state). */
export function isSourceRecord(record: CatalogRecord): boolean {
  return record.source !== null;
}

/** A POSITIVE injection-auditor 'clean' clearance is recorded. */
function hasCleanInjectionAuditor(auditors: CatalogAuditorVerdict[]): boolean {
  return auditors.some(
    (a) => a && a.agent === INJECTION_AUDITOR && a.verdict === "clean",
  );
}

/** A repo-safety-auditor verdict is PRESENT and NOT adverse. */
function hasNonAdverseRepoSafetyAuditor(
  auditors: CatalogAuditorVerdict[],
): boolean {
  let found = false;
  for (const a of auditors) {
    if (!a || a.agent !== REPO_SAFETY_AUDITOR) continue;
    found = true;
    if (
      ADVERSE_AUDITOR_VERDICTS.has(a.verdict) ||
      REPO_SAFETY_RAW_ADVERSE.has(a.verdict as string)
    ) {
      return false;
    }
  }
  return found;
}

/**
 * The CLIENT-SIDE mirror of catalog.mjs#evaluateAdmitGate — returns the ordered
 * list of human-readable T2 reasons that would force `--override`. Empty = the
 * security gate is clear. Plus the ADDITIVE replace condition: admitting a SOURCE
 * candidate that collides on uid with an already-admitted library record would
 * REPLACE a curated resource (a second T2 condition). Library-local records
 * (source === null) are the trusted library and are exempt from the require-
 * auditor rules; they cannot collide-with-themselves into a replace.
 *
 * @param record   The catalog record under consideration.
 * @param uidIsAdmittedPeer  True when this record's uid is ALSO carried by a
 *   distinct already-admitted library record (a uid-collision REPLACE).
 */
export function computeGateReasons(
  record: CatalogRecord,
  uidIsAdmittedPeer = false,
): string[] {
  const reasons: string[] = [];
  const sec = record.security;
  const auditors = Array.isArray(sec?.auditors) ? sec.auditors : [];
  const fromSource = isSourceRecord(record);

  // (1) deterministic flag / quarantine.
  if (sec && BLOCKING_SCAN_STATES.has(sec.scan)) {
    reasons.push(
      `security.scan is "${sec.scan}" — a flagged/quarantined candidate is never auto-admitted (ADR-0017 §5a)`,
    );
  }
  // (2) adverse auditor verdict.
  const adverse = auditors.filter(
    (a) => a && ADVERSE_AUDITOR_VERDICTS.has(a.verdict),
  );
  if (adverse.length > 0) {
    const which = adverse
      .map((a) => `${a.agent || "?"}=${a.verdict}`)
      .join(", ");
    reasons.push(`adverse auditor verdict(s): ${which}`);
  }
  // (3) executable kind from a non-reviewed source.
  if (EXECUTABLE_KINDS.has(record.kind)) {
    const trust =
      record.source && typeof record.source.trust === "string"
        ? record.source.trust
        : "";
    if (trust !== TRUST_REVIEWED) {
      reasons.push(
        `executable kind "${record.kind}" from a source whose trust is "${trust || "untrusted"}" (!= "${TRUST_REVIEWED}") — always human-gated (ADR-0017 §security)`,
      );
    }
  }
  // (4) require-auditor (SOURCE candidates only): POSITIVE injection-auditor clean.
  if (fromSource && !hasCleanInjectionAuditor(auditors)) {
    reasons.push(
      "admit requires an injection-auditor clean verdict (run the auditor) — ADR-0017",
    );
  }
  // (5) require-auditor for EXECUTABLE kinds (SOURCE candidates only): a non-adverse
  //     repo-safety-auditor verdict.
  if (
    fromSource &&
    EXECUTABLE_KINDS.has(record.kind) &&
    !hasNonAdverseRepoSafetyAuditor(auditors)
  ) {
    reasons.push(
      `executable kind "${record.kind}" requires a non-adverse repo-safety-auditor verdict (run the auditor) — ADR-0017 §5a`,
    );
  }
  // (+) ADDITIVE replace gate: a SOURCE candidate whose uid is already held by an
  //     admitted library record would OVERWRITE that curated resource (T2).
  if (fromSource && uidIsAdmittedPeer) {
    reasons.push(
      "admitting this would REPLACE an already-admitted library resource of the same uid — a curated-resource overwrite is human-gated (ADR-0017 §security)",
    );
  }
  return reasons;
}

// ──────────────────────────────────────────────────────────────────────────
// Derived security verdict — the single headline state per record
// ──────────────────────────────────────────────────────────────────────────

/**
 * The headline security verdict shown in the table. It is the scan state itself,
 * but PROMOTED to "quarantined" when an adverse auditor verdict exists on an
 * otherwise pending/clean scan (the auditor net is the real signal — §5a).
 */
export function deriveSecurityVerdict(record: CatalogRecord): CatalogScanState {
  const sec = record.security;
  if (!sec) return "pending";
  const auditors = Array.isArray(sec.auditors) ? sec.auditors : [];
  const adverse = auditors.some(
    (a) => a && ADVERSE_AUDITOR_VERDICTS.has(a.verdict),
  );
  if (adverse && sec.scan !== "quarantined") return "quarantined";
  return sec.scan;
}

// ──────────────────────────────────────────────────────────────────────────
// Badge variants / accents — the four catalog axes
// ──────────────────────────────────────────────────────────────────────────

/**
 * The label shown for a library-local (source === null) record's provenance —
 * the curated baseline that ships with / is owned by the active library. We call
 * it "core" so the curated baseline reads distinctly from a federated source's
 * sourceId in the SOURCE column and the provenance filter.
 */
export const CORE_PROVENANCE = "core";

/**
 * Provenance label: the curated baseline (library-local, source === null) is
 * "core"; a federated record is badged by its sourceId. This single label powers
 * BOTH the SOURCE column chip and the provenance filter, so the two stay in sync.
 */
export function provenanceLabel(record: CatalogRecord): string {
  return record.source ? record.source.sourceId : CORE_PROVENANCE;
}

/** True for the curated baseline (library-local; no external source). */
export function isCoreRecord(record: CatalogRecord): boolean {
  return record.source === null;
}

// ──────────────────────────────────────────────────────────────────────────
// Token-based accents — all saturated color is rationed through the DS
// `--state-*` tokens (state-ok / state-warn / state-attention / state-info).
// "unique"/"library"/"pending" stay neutral (hairline border + muted text),
// matching the prototype's calm baseline. These map onto the StatusPill /
// shadcn-Badge primitives below.
// ──────────────────────────────────────────────────────────────────────────

/** StatusPill tone for the headline security verdict. */
export function securityTone(scan: CatalogScanState): StatusTone {
  switch (scan) {
    case "clean":
      return "ok";
    case "flagged":
      return "warn";
    case "quarantined":
      return "attention";
    case "pending":
    default:
      return "neutral";
  }
}

/** StatusPill tone for an auditor/judge verdict (shared across both kinds). */
export function verdictTone(verdict: string): StatusTone {
  switch (verdict) {
    case "clean":
    case "keep":
      return "ok";
    case "suspicious":
    case "both":
      return "warn";
    case "malicious":
    case "quarantine":
      return "attention";
    case "replace":
      return "info";
    default:
      return "neutral";
  }
}

/** StatusPill tone for the admission state. */
export function admissionTone(state: CatalogAdmissionState): StatusTone {
  switch (state) {
    case "admitted":
      return "ok";
    case "quarantined":
      return "attention";
    case "catalog":
    default:
      return "neutral";
  }
}

/** Color-coded dedup class. unique = calm; collisions/dups = warm/adverse. */
export function dedupAccent(cls: CatalogDedupClass): string {
  switch (cls) {
    case "exact-dup":
      return "border-state-warn/40 text-state-warn bg-state-warn/10";
    case "near-dup":
      return "border-state-warn/40 text-state-warn bg-state-warn/10";
    case "uid-collision":
      return "border-state-attention/40 text-state-attention bg-state-attention/10";
    case "unique":
    default:
      return "border-border text-muted-foreground";
  }
}

/** Distinct sentinel value for the "all" option in single-select filters. */
export const ALL = "__all__";

// ──────────────────────────────────────────────────────────────────────────
// Verdict vocabularies (mirror the bridge signatures + /api/catalog validation)
// ──────────────────────────────────────────────────────────────────────────

export const AUDITOR_VERDICTS = [
  "clean",
  "suspicious",
  "malicious",
] as const;
export type AuditorVerdict = (typeof AUDITOR_VERDICTS)[number];

export const JUDGE_VERDICTS = [
  "keep",
  "replace",
  "both",
  "quarantine",
] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];
