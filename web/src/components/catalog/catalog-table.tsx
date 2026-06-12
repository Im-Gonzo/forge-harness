"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Gavel,
  Loader2,
  PackageCheck,
  PackageX,
  Plus,
  Scale,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  TestTubes,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KindBadge, SourceChip, StatusPill, TailoredChip } from "@/components/forge";
import { cn } from "@/lib/utils";
import type { BridgeEnvelope, CatalogRecord } from "@/lib/types";

import { GateRunner } from "./gate-runner";

import {
  ALL,
  AUDITOR_VERDICTS,
  JUDGE_VERDICTS,
  admissionTone,
  computeGateReasons,
  dedupAccent,
  deriveSecurityVerdict,
  isCoreRecord,
  isSourceRecord,
  provenanceLabel,
  securityTone,
  verdictTone,
} from "./catalog-helpers";
import type { AuditorVerdict, JudgeVerdict } from "./catalog-helpers";

// ──────────────────────────────────────────────────────────────────────────
// POST helper — every mutation rides POST /api/catalog (active-scope; the bridge
// resolves the root, the same convention as /api/memory). Returns the parsed C3
// envelope, or null after surfacing the error toast.
// ──────────────────────────────────────────────────────────────────────────

type CatalogPostBody =
  | { action: "admit"; uid: string; override?: boolean }
  | { action: "revoke"; uid: string }
  | {
      action: "audit";
      uid: string;
      agent: string;
      verdict: AuditorVerdict;
      evidence?: string;
    }
  | {
      action: "judge";
      uid: string;
      verdict: JudgeVerdict;
      rationale?: string;
    };

async function postCatalog(
  body: CatalogPostBody,
): Promise<BridgeEnvelope | null> {
  const res = await fetch("/api/catalog", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json()) as
    | BridgeEnvelope
    | { ok: false; error: string };
  if (!res.ok || !json.ok) {
    const msg =
      "error" in json && typeof json.error === "string"
        ? json.error
        : ((json as BridgeEnvelope).findings?.find((f) => f.level === "ERROR")
            ?.message ?? "Catalog action failed.");
    toast.error(msg);
    return null;
  }
  return json as BridgeEnvelope;
}

// ──────────────────────────────────────────────────────────────────────────
// Composition POST helper — Adopt/Remove ride POST /api/composition (active-
// scope; the bridge resolves the root). This is the SEPARATE, additive per-
// project COMPOSITION layer (ADR-0019): adopt != admit — it records a per-project
// selection and never writes the library or runs the T2 gate. sourceId selects
// which copy (the source id, or null for the library-local copy).
// ──────────────────────────────────────────────────────────────────────────

type ComposePostBody = {
  action: "adopt" | "remove";
  uid: string;
  sourceId?: string | null;
};

async function postComposition(
  body: ComposePostBody,
): Promise<BridgeEnvelope | null> {
  const res = await fetch("/api/composition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json()) as
    | BridgeEnvelope
    | { ok: false; error: string };
  if (!res.ok || !json.ok) {
    const msg =
      "error" in json && typeof json.error === "string"
        ? json.error
        : ((json as BridgeEnvelope).findings?.find((f) => f.level === "ERROR")
            ?.message ?? "Composition action failed.");
    toast.error(msg);
    return null;
  }
  return json as BridgeEnvelope;
}

/**
 * The composition key for a catalog record: "<sourceId|'lib'>:<uid>". A record's
 * source provenance (r.source) determines which copy adopt/remove targets — a
 * source record adopts that source's copy (sourceId = r.source.sourceId), a
 * library-local record (source === null) adopts the library copy (null → "lib").
 * Matches the adoptedKeys the catalog page builds from the composition read.
 */
function compositionKey(record: CatalogRecord): string {
  return `${record.source ? record.source.sourceId : "lib"}:${record.uid}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Per-row action state. A single in-flight slot keyed by uid keeps the table's
// buttons individually busy without re-rendering the whole grid.
// ──────────────────────────────────────────────────────────────────────────

type BusyAction = "admit" | "revoke" | "adopt" | "remove" | null;
type RowBusy = { uid: string; action: BusyAction } | null;

const SECURITY_ICON: Record<string, React.ComponentType<{ className?: string }>> =
  {
    clean: ShieldCheck,
    pending: Shield,
    flagged: ShieldAlert,
    quarantined: ShieldAlert,
  };

/**
 * Which UI surface the table renders for. The catalog grid backs two planes with
 * opposite affordances (Fix B):
 *
 *  - "global"  — the GLOBAL /catalog: an UNFILTERED browse of the unified catalog
 *    (the curated core library ∪ EVERY federated source resource). Owns the
 *    library ADMIT lifecycle ONLY. Source candidates (source !== null) get the
 *    verdict + admit/revoke (T2-gated) actions; core records (source === null,
 *    the already-admitted trusted baseline) get the verdict button only — no
 *    admit/revoke, no adopt. There is NO subscription filter and NO adopt here.
 *
 *  - "project" — the PROJECT-plane browse&adopt (/browse): the catalog filtered
 *    to the active project's read-view (core ∪ its subscribed source slices), with
 *    the per-row ADOPT/Remove COMPOSITION action. No admit/revoke/verdict — the
 *    library lifecycle is a GLOBAL concern. Subscription is managed by the slice
 *    panel above this table.
 */
export type CatalogTableMode = "global" | "project";

export function CatalogTable({
  records: allRecords,
  mode = "global",
  subscribedSlices = [],
  adoptedKeys = [],
  conflictedUids = [],
  tailoredKeys = [],
}: {
  records: CatalogRecord[];
  /**
   * Which surface this table backs (Fix B). "global" = browse + admit-only
   * (unfiltered, no adopt); "project" = browse & adopt (subscription-filtered, no
   * admit). Defaults to "global". See `CatalogTableMode`.
   */
  mode?: CatalogTableMode;
  /**
   * The active project's subscribed slice ids ("<sourceId>/<kind>"), from
   * `forge slice list`. In "project" mode the catalog READ-VIEW = library-local
   * records (source === null, ALWAYS shown) ∪ source records whose slice the
   * project subscribed to (ADR-0018) — an empty list shows ONLY core records. In
   * "global" mode this filter is NOT applied (the global browse is unfiltered).
   */
  subscribedSlices?: string[];
  /**
   * The active project's ADOPTED composition keys ("<sourceId|'lib'>:<uid>"),
   * from `forge compose list` (ADR-0019). Drives the per-row Adopt/Remove toggle:
   * a record whose key is here is already in the COMPOSITION (show Remove), else
   * Adopt. Adopt is a SEPARATE, additive per-project selection — adopt != admit,
   * it never writes the library or runs the T2 gate. Defaults to none.
   */
  adoptedKeys?: string[];
  /**
   * The uids that are CONFLICTED in the read-view ("<kind>:<id>") — a uid with
   * >= 2 distinct candidate records (dedup uid-collision / near-dup), from
   * `forge conflict list` (ADR-0020). Drives the per-row ⚖ affordance: a calm
   * marker linking to /conflicts where the conflict is adjudicated. Defaults none.
   */
  conflictedUids?: string[];
  /**
   * The TAILORED entry keys ("<sourceId|'lib'>:<uid>") from `forge tailor list`
   * (ADR-0021) — an adopted resource carrying >= 1 overlay. Drives the per-row
   * dashed, project-toned "tailored" chip (a calm marker linking to /tailoring,
   * where the overlays are managed). Keyed the same as adoptedKeys, so the chip
   * lands on the exact copy that is tailored. Defaults to none.
   */
  tailoredKeys?: string[];
}) {
  const router = useRouter();

  // ── Composition read — which read-view records this project has adopted.
  const adoptedSet = React.useMemo(
    () => new Set(adoptedKeys),
    [adoptedKeys],
  );

  // ── Tailoring read — which read-view records carry >= 1 overlay (the dashed
  //    "tailored" row chip; managed on /tailoring).
  const tailoredSet = React.useMemo(
    () => new Set(tailoredKeys),
    [tailoredKeys],
  );

  // ── Conflict read — which uids are conflicted (drives the ⚖ row affordance).
  const conflictedSet = React.useMemo(
    () => new Set(conflictedUids),
    [conflictedUids],
  );

  // ── Subscription read-view filter (PROJECT mode only) — drop source records
  //    whose slice the project has not subscribed to. Library-local (core)
  //    records are never filtered. In GLOBAL mode the browse is UNFILTERED: every
  //    catalog record (core ∪ every federated source resource) is shown.
  const subscribedSet = React.useMemo(
    () => new Set(subscribedSlices),
    [subscribedSlices],
  );
  const records = React.useMemo(
    () =>
      mode === "global"
        ? allRecords
        : allRecords.filter((r) => {
            if (!r.source) return true; // core — always in the read-view.
            return subscribedSet.has(`${r.source.sourceId}/${r.kind}`);
          }),
    [allRecords, subscribedSet, mode],
  );

  // ── Filters ────────────────────────────────────────────────────────────
  const [query, setQuery] = React.useState("");
  const [kindFilter, setKindFilter] = React.useState<string>(ALL);
  const [provFilter, setProvFilter] = React.useState<string>(ALL);
  const [secFilter, setSecFilter] = React.useState<string>(ALL);
  const [admFilter, setAdmFilter] = React.useState<string>(ALL);

  // ── Mutation state ───────────────────────────────────────────────────────
  const [busy, setBusy] = React.useState<RowBusy>(null);
  const isBusy = busy !== null;

  // The T2 override dialog: the record + its precomputed gate reasons.
  const [gateRecord, setGateRecord] = React.useState<CatalogRecord | null>(null);
  const [gateReasons, setGateReasons] = React.useState<string[]>([]);
  const [overrideAck, setOverrideAck] = React.useState(false);

  // The plain (clear-gate) admit confirm dialog.
  const [admitRecord, setAdmitRecord] = React.useState<CatalogRecord | null>(
    null,
  );
  // The revoke confirm dialog.
  const [revokeRecord, setRevokeRecord] = React.useState<CatalogRecord | null>(
    null,
  );
  // The audit/judge recording dialog.
  const [verdictRecord, setVerdictRecord] = React.useState<CatalogRecord | null>(
    null,
  );
  // The deterministic gate-runner panel (run validate/dedup/security/eval here;
  // copy the command for the agent-driven audit/judge/behavioral-eval gates).
  const [gateRunnerUid, setGateRunnerUid] = React.useState<string | null>(null);

  // uid → does another ADMITTED record carry the same uid? Drives the additive
  // replace gate for source candidates (a uid-collision overwrite). A library
  // record never collides with itself.
  const admittedUidCount = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const r of records) {
      if (r.admissionState === "admitted") {
        m.set(r.uid, (m.get(r.uid) ?? 0) + 1);
      }
    }
    return m;
  }, [records]);

  const reasonsFor = React.useCallback(
    (record: CatalogRecord): string[] => {
      // A SOURCE candidate whose uid is already admitted (by a DISTINCT record)
      // would replace the curated library copy.
      const admittedPeers = admittedUidCount.get(record.uid) ?? 0;
      const replacesAdmitted =
        isSourceRecord(record) &&
        (admittedPeers > 0 ||
          record.dedup?.class === "uid-collision");
      return computeGateReasons(record, replacesAdmitted);
    },
    [admittedUidCount],
  );

  const kinds = React.useMemo(
    () => Array.from(new Set(records.map((r) => r.kind))).sort(),
    [records],
  );
  const provenances = React.useMemo(
    () => Array.from(new Set(records.map((r) => provenanceLabel(r)))).sort(),
    [records],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter((r) => {
      if (kindFilter !== ALL && r.kind !== kindFilter) return false;
      if (provFilter !== ALL && provenanceLabel(r) !== provFilter) return false;
      if (secFilter !== ALL && deriveSecurityVerdict(r) !== secFilter)
        return false;
      if (admFilter !== ALL && r.admissionState !== admFilter) return false;
      // Free-text match across uid + description + provenance label, so the
      // search box finds a resource by any of the columns the user can read
      // (not just the uid). Each axis is a substring test on the lowered query.
      if (
        q &&
        !r.uid.toLowerCase().includes(q) &&
        !(r.description ?? "").toLowerCase().includes(q) &&
        !provenanceLabel(r).toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [records, query, kindFilter, provFilter, secFilter, admFilter]);

  const filtersActive =
    query.trim() !== "" ||
    kindFilter !== ALL ||
    provFilter !== ALL ||
    secFilter !== ALL ||
    admFilter !== ALL;

  const clearFilters = () => {
    setQuery("");
    setKindFilter(ALL);
    setProvFilter(ALL);
    setSecFilter(ALL);
    setAdmFilter(ALL);
  };

  // ── Admit entry point — ROUTES through the T2 gate. If the client-side gate
  //    mirror finds blocking reasons, open the OVERRIDE dialog (the reasons +
  //    an explicit acknowledgement); otherwise open the plain admit confirm.
  //    Either path requires a deliberate confirmation — never a silent admit.
  const onAdmitClick = React.useCallback(
    (record: CatalogRecord) => {
      const reasons = reasonsFor(record);
      if (reasons.length > 0) {
        setGateReasons(reasons);
        setOverrideAck(false);
        setGateRecord(record);
      } else {
        setAdmitRecord(record);
      }
    },
    [reasonsFor],
  );

  const runAdmit = React.useCallback(
    async (record: CatalogRecord, override: boolean) => {
      setBusy({ uid: record.uid, action: "admit" });
      try {
        const env = await postCatalog({
          action: "admit",
          uid: record.uid,
          override,
        });
        if (!env) return;
        toast.success(
          override
            ? `Admitted ${record.uid} with human OVERRIDE (T2).`
            : `Admitted ${record.uid}.`,
        );
        setGateRecord(null);
        setAdmitRecord(null);
        router.refresh();
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  const runRevoke = React.useCallback(
    async (record: CatalogRecord) => {
      setBusy({ uid: record.uid, action: "revoke" });
      try {
        const env = await postCatalog({ action: "revoke", uid: record.uid });
        if (!env) return;
        toast.success(`Revoked ${record.uid}.`);
        setRevokeRecord(null);
        router.refresh();
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  // ── Adopt / remove (COMPOSITION) — additive per-project selection (ADR-0019),
  //    SEPARATE from admit/revoke. Adopt records { uid, sourceId } in
  //    .forge/composition.json; remove drops it. Both ride POST /api/composition
  //    and refresh the server read (which re-derives adoptedKeys). The record's
  //    own provenance picks the copy: a source record → that sourceId, a library-
  //    local record (source === null) → the library copy.
  const runAdopt = React.useCallback(
    async (record: CatalogRecord) => {
      setBusy({ uid: record.uid, action: "adopt" });
      try {
        const env = await postComposition({
          action: "adopt",
          uid: record.uid,
          sourceId: record.source ? record.source.sourceId : null,
        });
        if (!env) return;
        toast.success(
          `Adopted ${record.uid}${
            record.source ? ` (${record.source.sourceId})` : ""
          } into the composition.`,
        );
        router.refresh();
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  const runRemoveComposition = React.useCallback(
    async (record: CatalogRecord) => {
      setBusy({ uid: record.uid, action: "remove" });
      try {
        const env = await postComposition({
          action: "remove",
          uid: record.uid,
          sourceId: record.source ? record.source.sourceId : null,
        });
        if (!env) return;
        toast.success(
          `Removed ${record.uid}${
            record.source ? ` (${record.source.sourceId})` : ""
          } from the composition.`,
        );
        router.refresh();
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Filter toolbar — search + kind/provenance/security/admission selects.
          Mirrors the prototype `.toolbar`: a mono search field, dense selects,
          a spacer, then a record-count caption pushed to the right edge. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search uid…"
            className="pl-8 font-mono text-[length:var(--text-xs)]"
            aria-label="search by uid"
          />
        </div>

        <FilterSelect
          value={kindFilter}
          onChange={setKindFilter}
          placeholder="kind"
          allLabel="all kinds"
          options={kinds}
        />
        <FilterSelect
          value={provFilter}
          onChange={setProvFilter}
          placeholder="origin"
          allLabel="all origins"
          options={provenances}
        />
        <FilterSelect
          value={secFilter}
          onChange={setSecFilter}
          placeholder="security"
          allLabel="all security"
          options={["clean", "pending", "flagged", "quarantined"]}
        />
        <FilterSelect
          value={admFilter}
          onChange={setAdmFilter}
          placeholder="admission"
          allLabel="all states"
          options={["catalog", "admitted", "quarantined"]}
        />

        {filtersActive ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="font-mono text-[length:var(--text-xs)]"
          >
            <X className="size-3" />
            clear
          </Button>
        ) : null}

        <span className="ml-auto font-mono text-[length:var(--text-2xs)] text-muted-foreground">
          {filtered.length} / {records.length} shown
        </span>
      </div>

      {/* Catalog table — dense mono grid in a hairline-ringed surface. */}
      <div className="overflow-hidden rounded-lg ring-1 ring-border">
        <Table className="text-[length:var(--text-xs)]">
          <TableHeader className="sticky top-0 z-10 bg-muted/45 backdrop-blur">
            <TableRow className="hover:bg-transparent">
              <Th>uid</Th>
              <Th>source</Th>
              <Th>kind</Th>
              <Th>dedup</Th>
              <Th>security</Th>
              <Th>audit / judge</Th>
              <Th>admission</Th>
              <TableHead className="w-px text-right font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
                <span className="sr-only">actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="py-12 text-center font-mono text-[length:var(--text-sm)] text-muted-foreground"
                >
                  {records.length === 0
                    ? mode === "global"
                      ? "The global catalog is empty — no core library resources and no federated source records yet. Federate a source on the Sources page."
                      : subscribedSlices.length === 0
                        ? "No resources in this project's read-view — only core resources and subscribed source slices appear here. Subscribe to a source slice above to surface its resources."
                        : "Nothing in this project's read-view yet — no core resources and no subscribed source slices."
                    : "No catalog records match the current filters."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((r) => {
                const sec = deriveSecurityVerdict(r);
                const SecIcon = SECURITY_ICON[sec] ?? Shield;
                const reasons = reasonsFor(r);
                const gated = reasons.length > 0;
                const auditors = r.security?.auditors ?? [];
                const rowBusy = busy?.uid === r.uid ? busy.action : null;
                const admitted = r.admissionState === "admitted";
                // CORE = the curated baseline (source === null, already admitted).
                // In GLOBAL mode it reads as the trusted baseline — no admit /
                // revoke / adopt, just the verdict button.
                const core = isCoreRecord(r);
                const dedupClass = r.dedup?.class ?? "unique";
                // COMPOSITION membership — drives the Adopt/Remove toggle.
                const adopted = adoptedSet.has(compositionKey(r));
                // CONFLICT membership — drives the per-row ⚖ affordance.
                const conflicted = conflictedSet.has(r.uid);
                // TAILORING membership — drives the dashed "tailored" row chip.
                const tailored = tailoredSet.has(compositionKey(r));
                return (
                  <TableRow
                    key={r.uid}
                    className={cn(
                      "align-top transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
                      gated && "bg-state-warn/[0.04]",
                    )}
                  >
                    <TableCell className="px-3 py-2.5 font-mono font-medium whitespace-nowrap text-foreground">
                      {conflicted ? (
                        <Link
                          href="/conflicts"
                          title="conflicted uid — >= 2 candidate records; adjudicate on the Conflicts page"
                          className="mr-1.5 inline-flex align-[-2px] text-state-attention hover:text-state-warn"
                        >
                          <Scale className="size-3.5" />
                        </Link>
                      ) : null}
                      {r.uid}
                      {tailored ? (
                        <Link
                          href="/tailoring"
                          title="tailored — carries project overlays; manage on the Tailoring page"
                          className="ml-2 inline-flex align-[-2px]"
                        >
                          <TailoredChip>tailored</TailoredChip>
                        </Link>
                      ) : null}
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <span
                        title={
                          r.source
                            ? `source: ${r.source.sourceId} — ${r.source.repoUrl} @ ${r.source.ref}${
                                r.source.commit
                                  ? ` (${r.source.commit.slice(0, 8)})`
                                  : ""
                              } · trust=${r.source.trust || "untrusted"}`
                            : "core — the curated library baseline (owned / library-local, no external source)"
                        }
                      >
                        <SourceChip
                          source={provenanceLabel(r)}
                          core={isCoreRecord(r)}
                        />
                      </span>
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <KindBadge kind={r.kind} />
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      {dedupClass === "unique" ? (
                        <span className="font-mono text-[length:var(--text-2xs)] text-muted-foreground/60">
                          unique
                        </span>
                      ) : (
                        <span
                          className={cn(
                            "inline-flex items-center rounded-pill border px-2 py-0.5 font-mono text-[length:var(--text-2xs)]",
                            dedupAccent(dedupClass),
                          )}
                          title={
                            r.dedup?.peers?.length
                              ? `peers: ${r.dedup.peers.join(", ")}`
                              : undefined
                          }
                        >
                          {dedupClass}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <span
                        title={
                          r.security?.deterministic?.findingCount
                            ? `${r.security.deterministic.findingCount} deterministic finding(s)`
                            : undefined
                        }
                      >
                        <StatusPill
                          tone={securityTone(sec)}
                          icon={<SecIcon className="size-3" />}
                        >
                          {sec}
                        </StatusPill>
                      </span>
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <div className="flex flex-col items-start gap-1">
                        {auditors.length === 0 && !r.judge ? (
                          <span className="font-mono text-[length:var(--text-2xs)] text-muted-foreground/60">
                            —
                          </span>
                        ) : null}
                        {auditors.map((a, i) => (
                          <span
                            key={`${a.agent}:${i}`}
                            title={
                              a.evidence?.length
                                ? a.evidence.join("\n")
                                : undefined
                            }
                          >
                            <StatusPill tone={verdictTone(a.verdict)}>
                              {a.agent}={a.verdict}
                            </StatusPill>
                          </span>
                        ))}
                        {r.judge ? (
                          <span title={r.judge.rationale || undefined}>
                            <StatusPill
                              tone={verdictTone(r.judge.verdict)}
                              icon={<Gavel className="size-3" />}
                            >
                              judge={r.judge.verdict}
                            </StatusPill>
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <StatusPill tone={admissionTone(r.admissionState)}>
                        {r.admissionState}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="w-px px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* ── GLOBAL plane: the library ADMIT lifecycle ────────
                            verdict (every record) + admit/revoke (SOURCE
                            candidates only). CORE records (source === null) are
                            the already-admitted trusted baseline — they read as
                            the baseline (a quiet "core" marker), so they show
                            ONLY the verdict button, never admit/revoke. There is
                            NO adopt here (adopt is a PROJECT-plane action). */}
                        {mode === "global" ? (
                          <>
                            {/* Run the deterministic gates (security dry-run /
                                dedup / validate / eval-static) live, or copy the
                                agent-driven audit/judge/eval command. */}
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={isBusy}
                              onClick={() => setGateRunnerUid(r.uid)}
                              className="font-mono text-[length:var(--text-xs)]"
                              title="Run the deterministic gates on this record, or copy an agent-gate command"
                            >
                              <TestTubes className="size-3" />
                              gates
                            </Button>

                            {/* Record audit/judge verdicts */}
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={isBusy}
                              onClick={() => setVerdictRecord(r)}
                              className="font-mono text-[length:var(--text-xs)]"
                              title="Record an auditor / judge verdict"
                            >
                              <Gavel className="size-3" />
                              verdict
                            </Button>

                            {core ? (
                              /* The curated baseline — no admit/revoke. A quiet
                                 read-only marker so it never reads as actionable. */
                              <span className="inline-flex items-center gap-1 rounded-pill border border-border px-2 py-0.5 font-mono text-[length:var(--text-2xs)] text-muted-foreground/70">
                                <ShieldCheck className="size-3" />
                                core
                              </span>
                            ) : (
                              <>
                                {/* Admit — gated rows show a warning affordance. */}
                                <Button
                                  variant={gated ? "outline" : "default"}
                                  size="xs"
                                  disabled={isBusy}
                                  onClick={() => onAdmitClick(r)}
                                  className={cn(
                                    "font-mono text-[length:var(--text-xs)]",
                                    gated &&
                                      "border-state-warn/50 text-state-warn hover:bg-state-warn/10 hover:text-state-warn",
                                  )}
                                  title={
                                    gated
                                      ? `T2 gate: ${reasons.length} condition(s) — admit requires a human override`
                                      : "Admit into the active library"
                                  }
                                >
                                  {rowBusy === "admit" ? (
                                    <Loader2 className="size-3 animate-spin" />
                                  ) : gated ? (
                                    <ShieldAlert className="size-3" />
                                  ) : (
                                    <PackageCheck className="size-3" />
                                  )}
                                  {gated ? "admit*" : "admit"}
                                </Button>

                                {/* Revoke — only meaningful once admitted. */}
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  disabled={isBusy || !admitted}
                                  onClick={() => setRevokeRecord(r)}
                                  className="font-mono text-[length:var(--text-xs)]"
                                  title={
                                    admitted
                                      ? "Revoke from the active library"
                                      : "Not admitted — nothing to revoke"
                                  }
                                >
                                  {rowBusy === "revoke" ? (
                                    <Loader2 className="size-3 animate-spin" />
                                  ) : (
                                    <Undo2 className="size-3" />
                                  )}
                                  revoke
                                </Button>
                              </>
                            )}
                          </>
                        ) : (
                          /* ── PROJECT plane: the COMPOSITION adopt/remove
                              action — adopt != admit. Outline-tinted (info) so
                              it never reads as a library action. */
                          <>
                            {adopted ? (
                              <Button
                                variant="ghost"
                                size="xs"
                                disabled={isBusy}
                                onClick={() => runRemoveComposition(r)}
                                className="font-mono text-[length:var(--text-xs)] hover:text-destructive"
                                title="Remove from this project's composition (does not touch the library)"
                              >
                                {rowBusy === "remove" ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <Trash2 className="size-3" />
                                )}
                                remove
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="xs"
                                disabled={isBusy}
                                onClick={() => runAdopt(r)}
                                className="border-state-info/40 font-mono text-[length:var(--text-xs)] text-state-info hover:bg-state-info/10 hover:text-state-info"
                                title="Adopt into this project's composition (additive — never writes the library)"
                              >
                                {rowBusy === "adopt" ? (
                                  <Loader2 className="size-3 animate-spin" />
                                ) : (
                                  <Plus className="size-3" />
                                )}
                                adopt
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── T2 OVERRIDE dialog — the gate reasons + explicit acknowledgement.
          This is the ONLY path that passes override:true; admit is never silent
          when the gate blocks. Styled as the prototype's adjudication candidate
          card / gate-reasons treatment (a dashed warn-toned banner). ───────── */}
      <Dialog
        open={gateRecord !== null}
        onOpenChange={(o) => {
          if (!o) setGateRecord(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-state-warn">
              <ShieldAlert className="size-4" />
              T2 security gate — human override required
            </DialogTitle>
            <DialogDescription>
              Admitting{" "}
              <span className="font-mono text-foreground">
                {gateRecord?.uid}
              </span>{" "}
              is blocked by the T2 security gate (ADR-0017 §5a). Review every
              reason below; overriding ACTIVATES the candidate into the active
              library and is recorded as a deliberate human action
              (security.humanOverride).
            </DialogDescription>
          </DialogHeader>

          {/* The candidate under review — a compact cand-card header. */}
          {gateRecord ? (
            <div className="flex items-center justify-between gap-2 rounded-lg ring-1 ring-border bg-card px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[length:var(--text-sm)] text-foreground">
                  {gateRecord.uid}
                </span>
                <KindBadge kind={gateRecord.kind} />
              </div>
              <SourceChip
                source={provenanceLabel(gateRecord)}
                core={isCoreRecord(gateRecord)}
              />
            </div>
          ) : null}

          {/* Gate reasons — the prototype `.verdict` dashed panel, warn-toned. */}
          <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-lg border border-dashed border-state-warn/30 bg-state-warn/[0.06] p-2.5">
            {gateReasons.map((reason, i) => (
              <li
                key={i}
                className="flex items-start gap-2 font-mono text-[length:var(--text-xs)] leading-[var(--leading-snug)] text-foreground"
              >
                <ShieldAlert className="mt-0.5 size-3 shrink-0 text-state-warn" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>

          <label className="flex cursor-pointer items-start gap-2 rounded-md ring-1 ring-border bg-muted/30 p-2.5 font-mono text-[length:var(--text-xs)] leading-[var(--leading-snug)] text-muted-foreground">
            <input
              type="checkbox"
              checked={overrideAck}
              onChange={(e) => setOverrideAck(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--state-warn)]"
            />
            <span>
              I have reviewed the {gateReasons.length} gate condition
              {gateReasons.length === 1 ? "" : "s"} above and accept
              responsibility for overriding the T2 security gate.
            </span>
          </label>

          <DialogFooter>
            <DialogClose
              render={
                <Button
                  variant="outline"
                  className="font-mono text-[length:var(--text-xs)]"
                />
              }
            >
              Cancel
            </DialogClose>
            <Button
              variant="destructive"
              disabled={!overrideAck || isBusy}
              onClick={() => gateRecord && runAdmit(gateRecord, true)}
              className="font-mono text-[length:var(--text-xs)]"
            >
              {busy?.action === "admit" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ShieldAlert className="size-3.5" />
              )}
              Override &amp; admit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Plain admit confirm — clear gate, still a deliberate confirmation. */}
      <Dialog
        open={admitRecord !== null}
        onOpenChange={(o) => {
          if (!o) setAdmitRecord(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PackageCheck className="size-4 text-state-ok" />
              Admit into the library?
            </DialogTitle>
            <DialogDescription>
              The T2 security gate is clear for{" "}
              <span className="font-mono text-foreground">
                {admitRecord?.uid}
              </span>
              . Admitting copies the resource bytes into the active library and
              marks it admitted (ADR-0017).
            </DialogDescription>
          </DialogHeader>

          {/* Cleared candidate — a calm ok-toned banner (prototype .comp-banner.ok). */}
          {admitRecord ? (
            <div className="flex items-center gap-3 rounded-lg border border-state-ok/35 bg-state-ok/[0.08] px-3 py-2.5">
              <ShieldCheck className="size-4 shrink-0 text-state-ok" />
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate font-mono text-[length:var(--text-sm)] text-foreground">
                  {admitRecord.uid}
                </span>
                <KindBadge kind={admitRecord.kind} />
              </div>
              <SourceChip
                source={provenanceLabel(admitRecord)}
                core={isCoreRecord(admitRecord)}
              />
            </div>
          ) : null}

          <DialogFooter>
            <DialogClose
              render={
                <Button
                  variant="outline"
                  className="font-mono text-[length:var(--text-xs)]"
                />
              }
            >
              Cancel
            </DialogClose>
            <Button
              disabled={isBusy}
              onClick={() => admitRecord && runAdmit(admitRecord, false)}
              className="font-mono text-[length:var(--text-xs)]"
            >
              {busy?.action === "admit" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="size-3.5" />
              )}
              Admit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Revoke confirm ──────────────────────────────────────────────── */}
      <Dialog
        open={revokeRecord !== null}
        onOpenChange={(o) => {
          if (!o) setRevokeRecord(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PackageX className="size-4 text-destructive" />
              Revoke from the library?
            </DialogTitle>
            <DialogDescription>
              Revoking{" "}
              <span className="font-mono text-foreground">
                {revokeRecord?.uid}
              </span>{" "}
              deletes the copied library target (restoring a replaced original
              from backup, if any) and drops it from admitted.json. Idempotent.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={
                <Button
                  variant="outline"
                  className="font-mono text-[length:var(--text-xs)]"
                />
              }
            >
              Cancel
            </DialogClose>
            <Button
              variant="destructive"
              disabled={isBusy}
              onClick={() => revokeRecord && runRevoke(revokeRecord)}
              className="font-mono text-[length:var(--text-xs)]"
            >
              {busy?.action === "revoke" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Undo2 className="size-3.5" />
              )}
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Audit / judge verdict recorder ───────────────────────────────── */}
      <VerdictDialog
        record={verdictRecord}
        onClose={() => setVerdictRecord(null)}
        onRecorded={() => {
          setVerdictRecord(null);
          router.refresh();
        }}
      />

      {/* ── Deterministic gate-runner panel ──────────────────────────────────
          Runs validate/dedup/security(dry-run)/eval-static live (read-only) and
          shows the exact `forge catalog audit/judge …` / `forge eval-harness <uid>`
          command for the AGENT-driven gates (never run from the web). ────────── */}
      {gateRunnerUid ? (
        <GateRunner
          open={gateRunnerUid !== null}
          onOpenChange={(o) => {
            if (!o) setGateRunnerUid(null);
          }}
          kind="record"
          target={gateRunnerUid}
        />
      ) : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Verdict recorder — record an AUDITOR verdict (agent + verdict + evidence) or a
// JUDGE verdict (verdict + rationale) to the catalog sidecar. Both ride POST
// /api/catalog and refresh on success.
// ──────────────────────────────────────────────────────────────────────────

function VerdictDialog({
  record,
  onClose,
  onRecorded,
}: {
  record: CatalogRecord | null;
  onClose: () => void;
  onRecorded: () => void;
}) {
  return (
    <Dialog
      open={record !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        {/* Key by uid so each record opens a FRESH form (no reset effect). */}
        {record ? (
          <VerdictForm
            key={record.uid}
            record={record}
            onRecorded={onRecorded}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The verdict form body — mounted fresh per record (keyed by uid), so its own
 * state always starts clean without a synchronizing effect.
 */
function VerdictForm({
  record,
  onRecorded,
}: {
  record: CatalogRecord;
  onRecorded: () => void;
}) {
  const [tab, setTab] = React.useState<"audit" | "judge">("audit");
  const [agent, setAgent] = React.useState("");
  const [auditVerdict, setAuditVerdict] =
    React.useState<AuditorVerdict>("clean");
  const [evidence, setEvidence] = React.useState("");
  const [judgeVerdict, setJudgeVerdict] = React.useState<JudgeVerdict>("keep");
  const [rationale, setRationale] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const submitAudit = React.useCallback(async () => {
    const trimmedAgent = agent.trim();
    if (!trimmedAgent) {
      toast.error("Enter the auditor agent id.");
      return;
    }
    setSubmitting(true);
    try {
      const env = await postCatalog({
        action: "audit",
        uid: record.uid,
        agent: trimmedAgent,
        verdict: auditVerdict,
        evidence: evidence.trim() || undefined,
      });
      if (!env) return;
      toast.success(
        `Recorded ${trimmedAgent}=${auditVerdict} for ${record.uid}.`,
      );
      onRecorded();
    } finally {
      setSubmitting(false);
    }
  }, [record, agent, auditVerdict, evidence, onRecorded]);

  const submitJudge = React.useCallback(async () => {
    setSubmitting(true);
    try {
      const env = await postCatalog({
        action: "judge",
        uid: record.uid,
        verdict: judgeVerdict,
        rationale: rationale.trim() || undefined,
      });
      if (!env) return;
      toast.success(`Recorded judge=${judgeVerdict} for ${record.uid}.`);
      onRecorded();
    } finally {
      setSubmitting(false);
    }
  }, [record, judgeVerdict, rationale, onRecorded]);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Gavel className="size-4" />
          Record a verdict
        </DialogTitle>
        <DialogDescription>
          Persist an auditor or judge verdict for{" "}
          <span className="font-mono text-foreground">{record.uid}</span> to the
          catalog sidecar. Verdicts feed the T2 admit gate.
        </DialogDescription>
      </DialogHeader>

      {/* Tabs — the prototype `.seg` segmented control. */}
      <div className="flex gap-0.5 rounded-md ring-1 ring-border bg-input/25 p-0.5">
        {(["audit", "judge"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "flex-1 rounded-sm px-2 py-1 font-mono text-[length:var(--text-xs)] uppercase tracking-[var(--tracking-wide)] transition-colors duration-[var(--duration-fast)]",
              tab === t
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "audit" ? "auditor" : "judge"}
          </button>
        ))}
      </div>

      {tab === "audit" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
              auditor agent id
            </label>
            <Input
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              placeholder="injection-auditor"
              spellCheck={false}
              className="font-mono text-[length:var(--text-xs)]"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
              verdict
            </label>
            <Select
              value={auditVerdict}
              onValueChange={(v) =>
                setAuditVerdict((v as AuditorVerdict) ?? "clean")
              }
            >
              <SelectTrigger
                size="sm"
                className="font-mono text-[length:var(--text-xs)]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDITOR_VERDICTS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
              evidence (optional)
            </label>
            <Textarea
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="quoted file:line evidence"
              className="font-mono text-[length:var(--text-xs)]"
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
              verdict
            </label>
            <Select
              value={judgeVerdict}
              onValueChange={(v) =>
                setJudgeVerdict((v as JudgeVerdict) ?? "keep")
              }
            >
              <SelectTrigger
                size="sm"
                className="font-mono text-[length:var(--text-xs)]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {JUDGE_VERDICTS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
              rationale (optional)
            </label>
            <Textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="short rationale for the conflict decision"
              className="font-mono text-[length:var(--text-xs)]"
            />
          </div>
        </div>
      )}

      <DialogFooter>
        <DialogClose
          render={
            <Button
              variant="outline"
              className="font-mono text-[length:var(--text-xs)]"
            />
          }
        >
          Cancel
        </DialogClose>
        <Button
          disabled={submitting}
          onClick={tab === "audit" ? submitAudit : submitJudge}
          className="font-mono text-[length:var(--text-xs)]"
        >
          {submitting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Gavel className="size-3.5" />
          )}
          Record {tab === "audit" ? "auditor" : "judge"} verdict
        </Button>
      </DialogFooter>
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Small presentational helpers
// ──────────────────────────────────────────────────────────────────────────

function Th({ children }: { children: React.ReactNode }) {
  return (
    <TableHead className="h-9 px-3 font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
      {children}
    </TableHead>
  );
}

function FilterSelect({
  value,
  onChange,
  placeholder,
  allLabel,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  allLabel: string;
  options: string[];
}) {
  // @base-ui Select#onValueChange yields `string | null` (null on deselect/clear)
  // — coalesce to the ALL sentinel so the controlled value is never null. Without
  // this the select can fall out of its controlled range and stop narrowing rows.
  const handleChange = React.useCallback(
    (v: string | null) => onChange(v ?? ALL),
    [onChange],
  );

  // The trigger must REFLECT the active filter. With no `items` map, @base-ui's
  // <Select.Value> can only resolve a label from the popup items once they have
  // mounted — before the first open it shows the placeholder even when a value
  // is selected, which reads as "the filter didn't apply". Render the label
  // ourselves from the controlled value: the ALL sentinel shows the placeholder,
  // any other value shows that value verbatim (the option labels are the values).
  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger
        size="sm"
        className="font-mono text-[length:var(--text-xs)]"
        aria-label={placeholder}
      >
        <SelectValue placeholder={placeholder}>
          {(v: string | null) =>
            !v || v === ALL ? placeholder : v
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
