"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  FlaskConical,
  Lock,
  RefreshCw,
  Scale,
  ShieldCheck,
  Boxes,
  FileCheck2,
  Loader2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { KindBadge, SourceChip, StatusPill } from "@/components/forge";
import { cn } from "@/lib/utils";
import type {
  AdjudicationPolicy,
  BridgeEnvelope,
  ConflictCandidate,
  ConflictRecord,
  ConflictsData,
} from "@/lib/types";

// ──────────────────────────────────────────────────────────────────────────
// POST helper — resolve + policy ride POST /api/conflicts (active-scope; the
// bridge resolves the root, the same convention as /api/composition). Returns
// the parsed C3 envelope, or null after surfacing the error toast.
//
// RESPECT BR-CAT-003: a resolve that REPLACES an already-admitted library
// resource is a T2 human action — the UI forwards only the human's explicit
// winner pick; it never auto-picks a library replace (the CLI enforces this).
// ──────────────────────────────────────────────────────────────────────────

type ConflictPostBody =
  | { action: "resolve"; uid: string; winner: string }
  | { action: "policy"; policy: Partial<AdjudicationPolicy> };

async function postConflicts(
  body: ConflictPostBody,
): Promise<BridgeEnvelope | null> {
  const res = await fetch("/api/conflicts", {
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
            ?.message ?? "Conflict action failed.");
    toast.error(msg);
    return null;
  }
  return json as BridgeEnvelope;
}

// ──────────────────────────────────────────────────────────────────────────
// Candidate identity. The CLI keys a human pick on a sourceId, OR the literal
// "library" for the library-local copy (sourceId === null). `choice` mirrors
// that: a sourceId, or null for the library copy (disambiguated by `state`).
// ──────────────────────────────────────────────────────────────────────────

/** The winner token for a candidate: its sourceId, or "library" when local. */
function winnerToken(candidate: ConflictCandidate): string {
  return candidate.sourceId ?? "library";
}

/** Display label for a candidate's origin. */
function candidateLabel(candidate: ConflictCandidate): string {
  return candidate.sourceId ?? "library";
}

/**
 * Is `candidate` the recorded human choice for `conflict`? `choice === null`
 * means the library-local copy was picked (only meaningful when state==="manual").
 */
function isChosen(conflict: ConflictRecord, candidate: ConflictCandidate): boolean {
  if (conflict.state !== "manual" && conflict.state !== "auto") return false;
  // For an "auto" state the suggested winner stands in for the (absent) choice.
  if (conflict.state === "auto") {
    return conflict.suggested === candidate.sourceId;
  }
  return conflict.choice === candidate.sourceId;
}

/** Does this candidate match the suggested-winner hint (eval → judge → null)? */
function isSuggested(conflict: ConflictRecord, candidate: ConflictCandidate): boolean {
  return conflict.suggested !== null && conflict.suggested === candidate.sourceId;
}

/** The candidate matching the suggested hint, if any (else null = needs human). */
function suggestedCandidate(conflict: ConflictRecord): ConflictCandidate | null {
  if (conflict.suggested === null) return null;
  return (
    conflict.candidates.find((c) => c.sourceId === conflict.suggested) ?? null
  );
}

// ──────────────────────────────────────────────────────────────────────────
// State pill — the prototype `.pill-sync` (manual=ok, auto=info, blocking=warn).
// ──────────────────────────────────────────────────────────────────────────

function StatePill({ conflict }: { conflict: ConflictRecord }) {
  if (conflict.state === "manual") {
    const label =
      conflict.choice === null
        ? "library chosen"
        : `${conflict.choice} chosen`;
    return <StatusPill tone="ok">{label}</StatusPill>;
  }
  if (conflict.state === "auto") {
    const sug = conflict.suggested ?? "library";
    return <StatusPill tone="info">auto · {sug}</StatusPill>;
  }
  return <StatusPill tone="warn">blocking</StatusPill>;
}

// ──────────────────────────────────────────────────────────────────────────
// ConflictsView — queue + adjudication detail + policy panel. A CONFLICT is a
// uid with >= 2 distinct candidate records in the read-view (dedup uid-collision
// / near-dup). Scores + judge verdicts are CONSUMED (never fabricated): a missing
// score renders "—", an absent judge verdict shows a calm note (no fake ring).
// ──────────────────────────────────────────────────────────────────────────

export function ConflictsView({ data }: { data: ConflictsData }) {
  const router = useRouter();
  const { conflicts, counts, policy, adjudicationPath } = data;

  // Detail selection — the adjudication panel opens for one conflict at a time.
  const [activeUid, setActiveUid] = React.useState<string | null>(null);
  const active = React.useMemo(
    () => conflicts.find((c) => c.uid === activeUid) ?? null,
    [conflicts, activeUid],
  );

  // Per-action in-flight slot (resolve winner | policy set).
  const [busy, setBusy] = React.useState(false);

  const runResolve = React.useCallback(
    async (conflict: ConflictRecord, candidate: ConflictCandidate) => {
      const winner = winnerToken(candidate);
      setBusy(true);
      try {
        const env = await postConflicts({
          action: "resolve",
          uid: conflict.uid,
          winner,
        });
        if (!env) return;
        toast.success(
          `Resolved ${conflict.uid} → ${candidateLabel(candidate)} (recorded as your T2 pick).`,
        );
        router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  const runSetPolicy = React.useCallback(
    async (partial: Partial<AdjudicationPolicy>) => {
      setBusy(true);
      try {
        const env = await postConflicts({ action: "policy", policy: partial });
        if (!env) return;
        const desc = Object.entries(partial)
          .map(([k, v]) => `${k}=${v}`)
          .join(" · ");
        toast.success(`Adjudication policy updated — ${desc}.`);
        router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  // ── Detail view — adjudication for one conflict ──────────────────────────
  if (active) {
    return (
      <Adjudication
        conflict={active}
        busy={busy}
        onBack={() => setActiveUid(null)}
        onResolve={runResolve}
      />
    );
  }

  // ── Queue view — banner + policy panel + the adjudication queue ──────────
  const autoCrits = (
    Object.keys(policy) as (keyof AdjudicationPolicy)[]
  ).filter((k) => policy[k] === "auto");

  return (
    <div className="flex flex-col gap-5">
      {/* Health banner — the prototype `.comp-banner`. Attention-toned when any
          conflict is blocking; calm ok-toned otherwise. */}
      {counts.blocking > 0 ? (
        <div className="flex items-center gap-3 rounded-lg border border-state-attention/40 bg-state-attention/[0.10] px-4 py-3 font-mono text-[length:var(--text-sm)] text-foreground">
          <AlertTriangle className="size-4 shrink-0 text-state-attention" />
          <span>
            <b className="text-foreground">{counts.blocking} blocking</b> ·
            adjudication policy:{" "}
            {autoCrits.length ? (
              <span>
                auto-accept{" "}
                <b className="text-foreground">{autoCrits.join(" · ")}</b>, block
                the rest
              </span>
            ) : (
              "block every criticality"
            )}
          </span>
          <span className="flex-1" />
          <StatusPill tone="warn">needs human</StatusPill>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-lg border border-state-ok/35 bg-state-ok/[0.08] px-4 py-3 font-mono text-[length:var(--text-sm)] text-foreground">
          <CheckCircle2 className="size-4 shrink-0 text-state-ok" />
          <span>
            <b className="text-foreground">Nothing blocking</b> —{" "}
            {counts.total === 0
              ? "every resource resolves to a single source · 0 conflicts"
              : "conflicts auto-accept the suggested winner per policy"}
          </span>
          <span className="flex-1" />
          <StatusPill tone="ok">in sync</StatusPill>
        </div>
      )}

      {/* Roll-up stat strip — total / blocking / auto / manual. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatPanel
          icon={<Scale className="size-3" />}
          title="conflicts"
          metric={counts.total}
          caption="uid-collision · near-dup"
          tone="neutral"
        />
        <StatPanel
          icon={<AlertTriangle className="size-3" />}
          title="blocking"
          metric={counts.blocking}
          caption="needs human"
          tone={counts.blocking > 0 ? "attention" : "ok"}
        />
        <StatPanel
          icon={<Zap className="size-3" />}
          title="auto"
          metric={counts.auto}
          caption="accepted by policy"
          tone="info"
        />
        <StatPanel
          icon={<Check className="size-3" />}
          title="manual"
          metric={counts.manual}
          caption="resolved by hand"
          tone="ok"
        />
      </div>

      {/* Policy panel — segmented auto/block per criticality + apply-recommended.
          Lives HERE on /conflicts (the /settings route is the MCP settings page). */}
      <PolicyPanel
        policy={policy}
        conflicts={conflicts}
        busy={busy}
        onSet={runSetPolicy}
      />

      {/* Adjudication queue — one row per conflict (prototype `.conflict-row`). */}
      <div className="flex flex-col gap-2">
        <h2 className="font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
          adjudication queue
        </h2>
        {conflicts.length === 0 ? (
          <div className="rounded-lg border border-border bg-card px-4 py-12 text-center font-mono text-[length:var(--text-sm)] text-muted-foreground">
            No conflicts. Every catalog resource resolves to a single source.
          </div>
        ) : (
          conflicts.map((conflict) => {
            const a = conflict.candidates[0];
            const b = conflict.candidates[1];
            const resolved = conflict.state !== "blocking";
            return (
              <button
                key={conflict.uid}
                type="button"
                onClick={() => setActiveUid(conflict.uid)}
                className={cn(
                  "grid w-full grid-cols-[auto_1fr_auto_auto] items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:bg-muted/35",
                  resolved && "opacity-70",
                )}
              >
                <KindBadge kind={conflict.kind} />
                <div className="min-w-0">
                  <div className="truncate font-mono text-[length:var(--text-sm)] text-foreground">
                    {conflict.uid}{" "}
                    <span className="text-[length:var(--text-2xs)] text-muted-foreground">
                      · {conflict.criticality}
                    </span>
                  </div>
                  <div className="truncate font-mono text-[length:var(--text-2xs)] text-muted-foreground">
                    {candidateLabel(a)} ({fmtScore(a.score)}) vs{" "}
                    {candidateLabel(b)} ({fmtScore(b.score)})
                    {conflict.candidates.length > 2
                      ? ` +${conflict.candidates.length - 2} more`
                      : ""}
                  </div>
                </div>
                <StatePill conflict={conflict} />
                <ChevronRight className="size-4 text-muted-foreground" />
              </button>
            );
          })
        )}
      </div>

      {/* Footer — the adjudication sidecar path. */}
      <p
        className="truncate font-mono text-[length:var(--text-2xs)] text-muted-foreground"
        title={adjudicationPath}
      >
        {adjudicationPath}
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Adjudication detail — candidate cards (score + metric bars + win/chosen
// styling), a judge ring (ONLY when a recorded verdict exists; else a calm
// "no judge verdict recorded" note — never fabricated), and per-candidate
// choose-winner buttons. The suggested winner is a HINT (eval-highest → recorded
// judge winner → null); choosing is the human's T2 pick (BR-CAT-001/003).
// ──────────────────────────────────────────────────────────────────────────

function Adjudication({
  conflict,
  busy,
  onBack,
  onResolve,
}: {
  conflict: ConflictRecord;
  busy: boolean;
  onBack: () => void;
  onResolve: (
    conflict: ConflictRecord,
    candidate: ConflictCandidate,
  ) => void | Promise<void>;
}) {
  const decided = conflict.state !== "blocking";
  const sug = suggestedCandidate(conflict);
  const judge = conflict.judge;

  return (
    <div className="flex flex-col gap-5">
      {/* Back link */}
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 font-mono text-[length:var(--text-xs)] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        conflicts
      </button>

      {/* Head — scale glyph (ok when decided, warn when blocking) + uid + context. */}
      <div className="flex items-start gap-3">
        <Scale
          className={cn(
            "mt-0.5 size-5 shrink-0",
            decided ? "text-state-ok" : "text-state-warn",
          )}
        />
        <div className="flex-1">
          <h2 className="font-mono text-[length:var(--text-xl)] font-semibold leading-none text-foreground">
            {conflict.uid}
          </h2>
          <p className="mt-1.5 max-w-[70ch] font-mono text-[length:var(--text-xs)] leading-[var(--leading-snug)] text-muted-foreground">
            {conflict.candidates.length} sources publish this{" "}
            <b className="text-foreground">{conflict.criticality}</b>{" "}
            {conflict.kind}.{" "}
            {conflict.state === "manual"
              ? "Resolved by hand — re-runnable."
              : conflict.state === "auto"
                ? "Auto-accepted by policy — override anytime."
                : "Pick a winner to unblock the composition."}
          </p>
        </div>
        <StatePill conflict={conflict} />
      </div>

      {/* Candidate grid + judge ring. The judge ring only renders when a verdict
          was actually recorded (catalog sidecar); otherwise a plain "vs" rail. */}
      <div
        className={cn(
          "grid items-stretch gap-4",
          conflict.candidates.length === 2
            ? "lg:grid-cols-[1fr_auto_1fr]"
            : "lg:grid-cols-2",
        )}
      >
        {conflict.candidates.map((cand, idx) => {
          const win = isSuggested(conflict, cand);
          const chosen = isChosen(conflict, cand);
          return (
            <React.Fragment key={winnerToken(cand)}>
              <CandidateCard
                conflict={conflict}
                candidate={cand}
                win={win}
                chosen={chosen}
                busy={busy}
                onResolve={onResolve}
              />
              {/* The center rail — between the first two candidates only. */}
              {idx === 0 && conflict.candidates.length === 2 ? (
                <JudgeRail judge={judge} />
              ) : null}
            </React.Fragment>
          );
        })}
      </div>

      {/* Verdict footer — the prototype `.verdict` dashed panel. The "suggested"
          line + evidence pills are shown ONLY when a real signal backs them. */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3.5 font-mono text-[length:var(--text-sm)] text-muted-foreground">
        {sug ? (
          <>
            <CheckCircle2 className="size-4 shrink-0 text-state-ok" />
            <span>
              suggested —{" "}
              <b className="text-foreground">
                {candidateLabel(sug)} · {conflict.uid}
              </b>
            </span>
          </>
        ) : (
          <>
            <AlertTriangle className="size-4 shrink-0 text-state-warn" />
            <span>
              no suggested winner — no eval scores or recorded judge verdict for
              this conflict.{" "}
              <b className="text-foreground">Needs a human pick.</b>
            </span>
          </>
        )}
        <span className="flex-1" />
        <div className="flex flex-wrap items-center gap-2">
          {hasAnyScore(conflict) ? (
            <EvidencePill icon={<FlaskConical className="size-3" />}>
              eval scored
            </EvidencePill>
          ) : null}
          {judge ? (
            <EvidencePill icon={<Scale className="size-3" />}>
              judge {judge.verdict}
            </EvidencePill>
          ) : null}
          <EvidencePill icon={<RefreshCw className="size-3" />}>
            re-runnable
          </EvidencePill>
        </div>
      </div>

      {/* Policy/criticality footnote — cites BR-CAT-003 for library replaces. */}
      <p className="font-mono text-[length:var(--text-xs)] leading-[var(--leading-snug)] text-muted-foreground">
        {conflict.state === "blocking" ? (
          <span>
            <AlertTriangle className="mr-1 inline size-3 -translate-y-px text-state-warn" />
            block-until-human (<b className="text-foreground">
              {conflict.criticality}
            </b>{" "}
            policy): the composition will not resolve until you confirm a winner.
            Adjust the policy in the panel on the queue.
          </span>
        ) : conflict.state === "auto" ? (
          <span>
            <CheckCircle2 className="mr-1 inline size-3 -translate-y-px text-state-info" />
            auto-accepted ({conflict.criticality} policy = auto): the suggested
            winner is adopted. Choosing a candidate that <b className="text-foreground">replaces an admitted library resource</b> stays a deliberate
            human T2 action (BR-CAT-003) — never self-applied.
          </span>
        ) : (
          <span>
            <Check className="mr-1 inline size-3 -translate-y-px text-state-ok" />
            chosen by hand (T2). The losing peers for this uid are dropped from
            the composition; the decision is re-runnable.
          </span>
        )}
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// CandidateCard — the prototype `.cand`: uid + version + SourceChip, a big
// score (the eval-highest reads as "top score"), metric bars, then the choose
// button. A null score renders "—" (never fabricated). win/chosen drive the ring.
// ──────────────────────────────────────────────────────────────────────────

function CandidateCard({
  conflict,
  candidate,
  win,
  chosen,
  busy,
  onResolve,
}: {
  conflict: ConflictRecord;
  candidate: ConflictCandidate;
  win: boolean;
  chosen: boolean;
  busy: boolean;
  onResolve: (
    conflict: ConflictRecord,
    candidate: ConflictCandidate,
  ) => void | Promise<void>;
}) {
  const label = candidateLabel(candidate);
  const manual = conflict.state === "manual";
  const auto = conflict.state === "auto";

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:-translate-y-0.5",
        win && "ring-1 ring-state-ok/55",
        chosen && "ring-2 ring-state-ok",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-[length:var(--text-sm)] text-foreground">
            {conflict.uid}
          </div>
          <div className="font-mono text-[length:var(--text-2xs)] text-muted-foreground">
            {candidate.version || "—"}
          </div>
        </div>
        <span
          title={
            candidate.sourceId
              ? `candidate from source "${candidate.sourceId}"`
              : "library-local copy (no external source)"
          }
        >
          <SourceChip
            source={label}
            className={cn(
              !candidate.sourceId && "border-dashed text-muted-foreground",
            )}
          />
        </span>
      </div>

      {/* Score — big mono numeral; the suggested winner reads ok-toned. "—" when
          no real score exists (BR: scores are CONSUMED, never fabricated). */}
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-mono text-3xl leading-none tracking-[var(--tracking-tight)] tabular-nums",
            candidate.score === null
              ? "text-muted-foreground/50"
              : win
                ? "text-state-ok"
                : "text-neutral-400",
          )}
        >
          {fmtScore(candidate.score)}
        </span>
        <span className="font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
          {candidate.score === null ? "no score" : win ? "top score" : "score"}
        </span>
        {chosen ? (
          <span className="ml-auto">
            <StatusPill tone={auto ? "info" : "ok"}>
              {auto ? "auto" : "chosen"}
            </StatusPill>
          </span>
        ) : null}
      </div>

      {/* Metric bars — the prototype `.metrics` / `.bar`. Each metric value is
          parsed to a 0..1 fraction for the bar; the raw `v` string is shown as-is. */}
      {candidate.metrics.length ? (
        <div className="flex flex-col gap-2">
          {candidate.metrics.map((m) => {
            const frac = metricFraction(m.v);
            return (
              <div
                key={m.k}
                className="grid grid-cols-[5rem_1fr_auto] items-center gap-2 font-mono text-[length:var(--text-2xs)] text-muted-foreground"
              >
                <span className="truncate">{m.k}</span>
                <div className="h-1.5 overflow-hidden rounded-[3px] bg-muted">
                  <span
                    aria-hidden
                    className={cn(
                      "block h-full rounded-[3px] transition-[width] duration-[var(--duration-slow)] ease-[var(--ease-out)]",
                      win ? "bg-state-ok" : "bg-neutral-500",
                    )}
                    style={{ width: `${Math.round(frac * 100)}%` }}
                  />
                </div>
                <span className="text-right text-foreground tabular-nums">
                  {m.v}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="font-mono text-[length:var(--text-2xs)] text-muted-foreground/60">
          no metrics recorded
        </p>
      )}

      {/* Choose — the human's T2 pick. Already-chosen (manual) reads as in-comp. */}
      <div className="mt-auto pt-1">
        {manual && chosen ? (
          <Button
            variant="ghost"
            size="sm"
            disabled
            className="w-full font-mono text-[length:var(--text-xs)]"
          >
            <Check className="size-3" />
            in composition
          </Button>
        ) : (
          <Button
            variant={win && !manual ? "default" : "outline"}
            size="sm"
            disabled={busy}
            onClick={() => onResolve(conflict, candidate)}
            className="w-full font-mono text-[length:var(--text-xs)]"
            title={
              candidate.sourceId === null
                ? "Choose the library-local copy (recorded as your T2 pick)"
                : `Choose ${label} (recorded as your T2 pick)`
            }
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Check className="size-3" />
            )}
            {manual ? "switch to " : auto ? "lock in " : "choose "}
            {label}
          </Button>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// JudgeRail — the prototype `.adj-judge`: a "vs" + a ring. The ring shows the
// recorded judge verdict ONLY when one exists in the sidecar; otherwise a calm
// "no judge verdict recorded" note (DO NOT fabricate a verdict / agree-of ratio).
// ──────────────────────────────────────────────────────────────────────────

function JudgeRail({
  judge,
}: {
  judge: ConflictRecord["judge"];
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 text-center">
      <span className="font-mono text-[length:var(--text-xs)] text-neutral-600">
        vs
      </span>
      {judge ? (
        <>
          <span
            className="flex size-16 items-center justify-center rounded-full border border-state-info/40 bg-state-info/[0.10] text-state-info"
            title={judge.rationale || `judge verdict: ${judge.verdict}`}
          >
            <Scale className="size-7" />
          </span>
          <span className="font-mono text-[length:var(--text-2xs)] uppercase leading-[var(--leading-snug)] tracking-[var(--tracking-wide)] text-muted-foreground">
            judge agent
            <br />
            {judge.verdict}
          </span>
        </>
      ) : (
        <>
          <span className="flex size-16 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground/50">
            <Scale className="size-7" />
          </span>
          <span className="max-w-28 font-mono text-[length:var(--text-2xs)] leading-[var(--leading-snug)] text-muted-foreground/70">
            no judge verdict recorded
          </span>
        </>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// PolicyPanel — segmented auto/block per criticality + an "apply recommended"
// (normal=auto, compliance=block, safety=block). Persists to .forge/adjudication.json
// via POST /api/conflicts {action:"policy"}. Per BR-CAT-003 the panel explains
// that a library-replace stays a human T2 action even under "auto".
// ──────────────────────────────────────────────────────────────────────────

const CRITS: {
  id: keyof AdjudicationPolicy;
  label: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "normal",
    label: "normal",
    desc: "Everyday agents, skills & rules. Low blast radius.",
    icon: <Boxes className="size-3.5" />,
  },
  {
    id: "compliance",
    label: "compliance",
    desc: "Policy & regulatory rules. A wrong pick has audit consequences.",
    icon: <FileCheck2 className="size-3.5" />,
  },
  {
    id: "safety",
    label: "safety",
    desc: "Validators, guards, security hooks. A wrong pick can ship harm.",
    icon: <ShieldCheck className="size-3.5" />,
  },
];

const RECOMMENDED: AdjudicationPolicy = {
  normal: "auto",
  compliance: "block",
  safety: "block",
};

function PolicyPanel({
  policy,
  conflicts,
  busy,
  onSet,
}: {
  policy: AdjudicationPolicy;
  conflicts: ConflictRecord[];
  busy: boolean;
  onSet: (partial: Partial<AdjudicationPolicy>) => void | Promise<void>;
}) {
  const countFor = React.useCallback(
    (crit: keyof AdjudicationPolicy) =>
      conflicts.filter((c) => c.criticality === crit).length,
    [conflicts],
  );

  const atRecommended =
    policy.normal === RECOMMENDED.normal &&
    policy.compliance === RECOMMENDED.compliance &&
    policy.safety === RECOMMENDED.safety;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
        adjudication policy
      </h2>

      <div className="grid gap-3 md:grid-cols-3">
        {CRITS.map((cr) => (
          <div
            key={cr.id}
            className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
          >
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground">
                {cr.icon}
              </span>
              <div className="flex-1">
                <div className="font-mono text-[length:var(--text-sm)] text-foreground">
                  {cr.label}
                </div>
                <div className="font-mono text-[length:var(--text-2xs)] text-muted-foreground">
                  {countFor(cr.id)} conflict
                  {countFor(cr.id) === 1 ? "" : "s"}
                </div>
              </div>
            </div>
            <p className="font-mono text-[length:var(--text-2xs)] leading-[var(--leading-snug)] text-muted-foreground">
              {cr.desc}
            </p>
            {/* Segmented auto/block — the prototype `.policy-seg`. */}
            <div className="flex gap-0.5 rounded-md border border-border bg-input/[0.22] p-0.5">
              <SegButton
                active={policy[cr.id] === "auto"}
                tone="info"
                disabled={busy || policy[cr.id] === "auto"}
                onClick={() => onSet({ [cr.id]: "auto" })}
                icon={<Zap className="size-3" />}
              >
                auto-accept
              </SegButton>
              <SegButton
                active={policy[cr.id] === "block"}
                tone="warn"
                disabled={busy || policy[cr.id] === "block"}
                onClick={() => onSet({ [cr.id]: "block" })}
                icon={<Lock className="size-3" />}
              >
                block
              </SegButton>
            </div>
          </div>
        ))}
      </div>

      {/* Recommended banner — apply normal=auto, compliance/safety=block. */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-state-ok/35 bg-state-ok/[0.08] px-4 py-3 font-mono text-[length:var(--text-sm)] text-foreground">
        <CheckCircle2 className="size-4 shrink-0 text-state-ok" />
        <span>
          Recommended — <b className="text-foreground">auto-accept normal</b>,{" "}
          <b className="text-foreground">block compliance &amp; safety</b>. Fast
          where it&apos;s cheap, deliberate where it counts.
        </span>
        <span className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || atRecommended}
          onClick={() => onSet(RECOMMENDED)}
          className="font-mono text-[length:var(--text-xs)]"
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <ArrowRight className="size-3" />
          )}
          {atRecommended ? "applied" : "apply recommended"}
        </Button>
      </div>
    </div>
  );
}

function SegButton({
  active,
  tone,
  disabled,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  tone: "info" | "warn";
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 font-mono text-[length:var(--text-xs)] transition-colors duration-[var(--duration-fast)] disabled:cursor-default",
        active
          ? tone === "info"
            ? "bg-state-info/[0.18] text-state-info"
            : "bg-state-warn/[0.16] text-state-warn"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// StatPanel — the same mono stat look used on the Composition page (Slice 2).
// "nodata" placeholders are unused here; tones map to the rationed state accents.
// ──────────────────────────────────────────────────────────────────────────

type StatTone = "ok" | "neutral" | "info" | "attention";

const DOT_CLASS: Record<StatTone, string> = {
  ok: "bg-state-ok",
  neutral: "bg-muted-foreground",
  info: "bg-state-info",
  attention: "bg-state-attention",
};

function StatPanel({
  icon,
  title,
  metric,
  caption,
  tone = "neutral",
}: {
  icon?: React.ReactNode;
  title: string;
  metric: React.ReactNode;
  caption?: React.ReactNode;
  tone?: StatTone;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
          {icon}
          {title}
        </span>
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[tone])}
        />
      </div>
      <span className="font-mono text-2xl font-semibold leading-none tracking-[var(--tracking-tight)] tabular-nums text-foreground">
        {metric}
      </span>
      {caption ? (
        <span className="font-mono text-[length:var(--text-2xs)] text-muted-foreground">
          {caption}
        </span>
      ) : null}
    </div>
  );
}

function EvidencePill({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill border border-border px-2.5 py-0.5 font-mono text-[length:var(--text-2xs)] text-muted-foreground [&>svg]:size-3">
      {icon}
      {children}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Score / metric formatting — scores are CONSUMED, never fabricated. A null
// score renders "—". Metric values are arbitrary strings; for the bar we parse
// a leading number and clamp to 0..1 (values > 1 are treated as percentages).
// ──────────────────────────────────────────────────────────────────────────

function fmtScore(score: number | null): string {
  if (score === null) return "—";
  return Number.isInteger(score) ? String(score) : score.toFixed(2);
}

function hasAnyScore(conflict: ConflictRecord): boolean {
  return conflict.candidates.some((c) => c.score !== null);
}

function metricFraction(raw: string): number {
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return 0;
  if (n <= 1 && n >= 0) return n;
  if (n > 1 && n <= 100) return n / 100;
  return Math.max(0, Math.min(1, n));
}
