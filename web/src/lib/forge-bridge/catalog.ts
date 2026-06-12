/**
 * forge-bridge/catalog — the unified-catalog + admission surface (ADR-0017).
 *
 * Wraps `forge catalog <verb>` against the ACTIVE harness root (the bridge spawns
 * with cwd = getActiveRoot()). The catalog is the SUPERSET of discoverable
 * resources: the active LIBRARY ∪ every resource synced from a registered source.
 * A catalog-only record is DISCOVERABLE but INERT until ADMITTED into the library.
 *
 *   - getCatalog()        — `catalog build` (read-only; library ∪ sources + security scan).
 *   - getCatalogDedup()   — `catalog dedup` (read-only; build + dedup classification:
 *                           records + counts + conflicts).
 *   - catalogAudit(…)     — `catalog audit <uid> --agent <n> --verdict <v> [--evidence <s>] --apply`.
 *   - catalogJudge(…)     — `catalog judge <uid> --verdict <v> [--rationale <s>] --apply`.
 *   - catalogAdmit(uid,…) — `catalog admit <uid> [--override] --apply` (T2 security gate).
 *   - catalogRevoke(uid)  — `catalog revoke <uid> --apply`.
 *
 * audit/judge RECORD the agent verdicts the Claude session computed (the CLI only
 * persists them to the sidecar). admit/revoke ACTIVATE/de-activate library bytes.
 * All mutating verbs PREVIEW by default and write only under `--apply`; these web
 * wrappers are the APPLY path (the UI confirms first), so they pass `--apply` —
 * mirroring the existing memory `{ apply }` convention. Each returns the raw parsed
 * C3 envelope (fail-soft, never throws).
 *
 * NOTE: server-only module (runForge → node:child_process). Import from server
 * components and route handlers only — never from a "use client" boundary.
 */
import type {
  BridgeEnvelope,
  CatalogBuildData,
  CatalogDedupData,
} from "@/lib/types";

import { runForge } from "./run";

/** `forge catalog build --json` — the unified catalog (read-only). */
export function getCatalog(): Promise<BridgeEnvelope<CatalogBuildData>> {
  return runForge<CatalogBuildData>("catalog", ["build"]);
}

/**
 * `forge catalog dedup --json` — deterministic dedup classification across the
 * catalog (read-only). Returns the classified records, per-class counts, and the
 * unresolved conflicts held for the judge/T2 gate during admit.
 */
export function getCatalogDedup(): Promise<BridgeEnvelope<CatalogDedupData>> {
  return runForge<CatalogDedupData>("catalog", ["dedup"]);
}

/**
 * `forge catalog audit <uid> --agent <name> --verdict <v> [--evidence <s>] --apply`
 * — RECORD an auditor AGENT's verdict to the catalog-verdicts sidecar.
 *
 * @param uid      Registry artifact uid "<kind>:<id>".
 * @param agent    The auditor agent id (e.g. 'injection-auditor').
 * @param verdict  clean | suspicious | malicious.
 * @param evidence Optional quoted file:line evidence.
 */
export function catalogAudit(
  uid: string,
  agent: string,
  verdict: "clean" | "suspicious" | "malicious",
  evidence?: string,
): Promise<BridgeEnvelope> {
  const args = ["audit", uid, "--agent", agent, "--verdict", verdict];
  if (evidence) args.push("--evidence", evidence);
  args.push("--apply");
  return runForge("catalog", args);
}

/**
 * `forge catalog judge <uid> --verdict <v> [--rationale <s>] --apply` — RECORD the
 * judge AGENT's conflict decision to the sidecar.
 *
 * @param uid       Registry artifact uid.
 * @param verdict   keep | replace | both | quarantine.
 * @param rationale Optional short rationale.
 */
export function catalogJudge(
  uid: string,
  verdict: "keep" | "replace" | "both" | "quarantine",
  rationale?: string,
): Promise<BridgeEnvelope> {
  const args = ["judge", uid, "--verdict", verdict];
  if (rationale) args.push("--rationale", rationale);
  args.push("--apply");
  return runForge("catalog", args);
}

/**
 * `forge catalog admit <uid> [--override] --apply` — consult the T2 security gate
 * and ACTIVATE the cleared candidate into the active library (copy bytes only). A
 * REPLACE of an existing library resource, a quarantined candidate, or an
 * executable kind from an untrusted source requires `{ override:true }` (T2).
 *
 * @param uid  Registry artifact uid.
 * @param opts `{ override }` — the T2 human override flag (--override).
 */
export function catalogAdmit(
  uid: string,
  opts?: { override?: boolean },
): Promise<BridgeEnvelope> {
  const args = ["admit", uid];
  if (opts?.override) args.push("--override");
  args.push("--apply");
  return runForge("catalog", args);
}

/**
 * `forge catalog revoke <uid> --apply` — DELETE the copied library target (restore
 * a replaced original) and drop the uid from admitted.json. Idempotent.
 */
export function catalogRevoke(uid: string): Promise<BridgeEnvelope> {
  return runForge("catalog", ["revoke", uid, "--apply"]);
}
