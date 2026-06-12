"use client";

/**
 * SourcesTable — the federated SOURCE-registry workspace for the ACTIVE harness.
 *
 * This is the GLOBAL repo registry ONLY: add / sync / trust / remove + the trust
 * tags. Per-project SLICE SUBSCRIPTION is a PROJECT-plane concern (it scopes a
 * project's catalog read-view) and lives on the project browse&adopt surface
 * (/browse) — it is NOT managed here (Fix B).
 *
 * Read side: a server-loaded `forge source list` envelope (forge-bridge is
 * server-only, so it is never imported here) rendered as a table — one row per
 * registered source with its id, url/path, ref, kind, trust badge, and the
 * commit / last-sync provenance when the source has been synced.
 *
 * Action side: every mutation rides POST /api/sources (client → API route →
 * bridge → `forge source <verb> --apply`) then router.refresh() to re-render the
 * server-loaded table:
 *
 *   - Sync   : `source sync <id> --apply` — clone+read only; pins the lock.
 *   - Trust  : `source trust <id> --apply` — untrusted → reviewed. A STANDING
 *              config change (it gates admission), so it is CONFIRMED first.
 *   - Remove : `source remove <id> --apply` — drop from the manifest. CONFIRMED.
 *
 * The CLI verbs preview by default; the bridge wrappers pass --apply, so these
 * actions are the apply path (Trust/Remove confirm before firing).
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Clock,
  GitBranch,
  HardDrive,
  Library,
  Loader2,
  Pin,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  TestTubes,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  KindBadge,
  SourceChip,
  StatusPill,
  TrustTag,
} from "@/components/forge";
import type {
  BridgeEnvelope,
  SourceListData,
  SourceRecord,
} from "@/lib/types";

import { GateRunner } from "@/components/catalog/gate-runner";

import { AddSourceForm } from "./add-source-form";
import {
  envelopeMessage,
  formatTimestamp,
  isReviewed,
  kindLabel,
  trustLabel,
} from "./source-helpers";

export interface SourcesTableProps {
  /** `forge source list` envelope (the active scope's source registry), or null. */
  sources: BridgeEnvelope<SourceListData> | null;
}

/** Which row + verb is in flight, so only that row's button spins. */
type Busy = null | { id: string; verb: "sync" | "trust" | "remove" };

/** A pending confirm (standing-config change) awaiting the user's OK. */
type Confirm = null | { id: string; verb: "trust" | "remove" };

export function SourcesTable({ sources }: SourcesTableProps) {
  const router = useRouter();

  const records: SourceRecord[] = sources?.data?.sources ?? [];
  const manifestPath = sources?.data?.manifestPath ?? null;
  // A bridge/CLI failure surfaces as a non-ok envelope — show it as a banner.
  const loadError =
    sources && !sources.ok
      ? envelopeMessage(sources.findings, "Failed to load sources.")
      : null;

  const untrusted = records.filter((s) => !isReviewed(s.trust)).length;

  const [busy, setBusy] = React.useState<Busy>(null);
  const [confirm, setConfirm] = React.useState<Confirm>(null);
  // The deterministic gate-runner panel target (source id), or null when closed.
  const [gatesSourceId, setGatesSourceId] = React.useState<string | null>(null);
  const isBusy = busy !== null;

  // ── POST helper — all actions ride /api/sources (active root, no project) ───
  const post = React.useCallback(
    async (body: Record<string, unknown>): Promise<BridgeEnvelope | null> => {
      const res = await fetch("/api/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as
        | BridgeEnvelope
        | { ok: false; error: string };
      if (!res.ok || !json.ok) {
        toast.error(
          "error" in json && typeof json.error === "string"
            ? json.error
            : envelopeMessage(
                (json as BridgeEnvelope).findings,
                "Source action failed.",
              ),
        );
        return null;
      }
      return json as BridgeEnvelope;
    },
    [],
  );

  // ── Sync — fires immediately (a read-only clone+pin; no standing change) ───
  const onSync = React.useCallback(
    async (id: string) => {
      setBusy({ id, verb: "sync" });
      try {
        const env = await post({ action: "sync", id });
        if (!env) return;
        toast.success(`Synced "${id}".`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [post, router],
  );

  // ── Trust — confirmed (standing config: gates admission of executable kinds) ─
  const onTrustConfirmed = React.useCallback(
    async (id: string) => {
      setConfirm(null);
      setBusy({ id, verb: "trust" });
      try {
        const env = await post({ action: "trust", id });
        if (!env) return;
        toast.success(`Trusted "${id}" — promoted to reviewed.`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [post, router],
  );

  // ── Remove — confirmed (drops the source from the manifest) ────────────────
  const onRemoveConfirmed = React.useCallback(
    async (id: string) => {
      setConfirm(null);
      setBusy({ id, verb: "remove" });
      try {
        const env = await post({ action: "remove", id });
        if (!env) return;
        toast.success(`Removed "${id}".`);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [post, router],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* ── Header summary ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <TrustTag
          label={`${records.length} source${records.length === 1 ? "" : "s"}`}
          icon={<Library />}
        />
        <StatusPill tone={untrusted > 0 ? "attention" : "neutral"}>
          {untrusted} untrusted
        </StatusPill>
        {manifestPath ? (
          <span
            className="ml-auto truncate font-mono text-[length:var(--text-2xs)] text-muted-foreground/60"
            title={manifestPath}
          >
            {manifestPath}
          </span>
        ) : null}
      </div>

      {/* ── Load error banner (fail-soft bridge envelope) ──────────────────── */}
      {loadError ? (
        <div className="flex items-start gap-2 rounded-lg border border-state-attention/30 bg-state-attention/5 px-3 py-2 font-mono text-[length:var(--text-2xs)] text-state-attention">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">{loadError}</span>
        </div>
      ) : null}

      {/* ── Add-source form ────────────────────────────────────────────────── */}
      <AddSourceForm disabled={isBusy} />

      {/* ── Sources list / empty state ─────────────────────────────────────── */}
      {records.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex flex-col gap-3">
          {records.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              busyVerb={busy != null && busy.id === s.id ? busy.verb : null}
              isBusy={isBusy}
              onSync={() => onSync(s.id)}
              onTrust={() => setConfirm({ id: s.id, verb: "trust" })}
              onRemove={() => setConfirm({ id: s.id, verb: "remove" })}
              onGates={() => setGatesSourceId(s.id)}
            />
          ))}
        </div>
      )}

      {/* ── Confirm dialog (standing-config Trust / destructive Remove) ─────── */}
      <ConfirmDialog
        confirm={confirm}
        busy={isBusy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.verb === "trust") void onTrustConfirmed(confirm.id);
          else void onRemoveConfirmed(confirm.id);
        }}
      />

      {/* ── Deterministic gate-runner panel ──────────────────────────────────
          For a source, runs validate / dedup / eval-static live (read-only) and
          shows the injection / repo-safety auditor commands to copy. A per-source
          deterministic security scan is not a clean per-target CLI verb (the
          scanners run during catalog build/dedup), so we surface dedup + the
          auditor commands rather than fake one. ──────────────────────────────── */}
      {gatesSourceId ? (
        <GateRunner
          open={gatesSourceId !== null}
          onOpenChange={(o) => {
            if (!o) setGatesSourceId(null);
          }}
          kind="source"
          target={gatesSourceId}
        />
      ) : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────────────

/** Empty state — no sources registered yet (manifests/sources.json is empty). */
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-md border border-border text-muted-foreground/60">
        <Library className="size-5" />
      </span>
      <p className="font-mono text-sm text-foreground">No sources registered</p>
      <p className="max-w-sm font-mono text-[length:var(--text-2xs)] leading-snug text-muted-foreground">
        Federate a source above — a remote Git repo or a local path — to sync
        its resources into the catalog. Every source is read-only until it
        clears the trust gate; new sources start{" "}
        <span className="text-state-attention">untrusted</span> until reviewed.
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SourceRow — the prototype `.src-row`: a hairline card with a header band
// (SourceChip + mono id/url + kind/added/sync provenance) and a trust-gate footer
// (`.trust-row` TrustTag signals + the Sync / Trust / Remove actions). This is the
// GLOBAL repo registry only — per-project slice subscription moved to the project
// browse&adopt surface (/browse), so no slice grid / subscription summary here.
// ──────────────────────────────────────────────────────────────────────────

function SourceRow({
  source: s,
  busyVerb,
  isBusy,
  onSync,
  onTrust,
  onRemove,
  onGates,
}: {
  source: SourceRecord;
  busyVerb: "sync" | "trust" | "remove" | null;
  isBusy: boolean;
  onSync: () => void;
  onTrust: () => void;
  onRemove: () => void;
  onGates: () => void;
}) {
  const reviewed = isReviewed(s.trust);
  const added = formatTimestamp(s.addedAt);
  const KindIcon = s.kind === "local" ? HardDrive : GitBranch;

  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
      {/* ── Header band: provenance + kind + sync state ──────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <SourceChip source={s.id} />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-sm font-semibold text-foreground">
              {s.id}
            </span>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <KindIcon className="size-3" />
              <KindBadge kind={kindLabel(s.kind)} />
            </span>
          </div>
          <span
            className="truncate font-mono text-xs text-muted-foreground"
            title={s.url || undefined}
          >
            {s.url || "—"}
            {s.ref ? (
              <span className="text-muted-foreground/60"> · {s.ref}</span>
            ) : null}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <StatusPill tone="neutral" icon={<Clock />}>
            {added ? `added ${added}` : "not synced"}
          </StatusPill>
        </div>
      </div>

      {/* ── Trust-gate footer (`.trust-row`): signals + per-source actions ── */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/[0.12] px-4 py-3">
        <TrustTag
          label={trustLabel(s.trust)}
          tone={reviewed ? "ok" : "neutral"}
          icon={reviewed ? <ShieldCheck /> : <ShieldAlert />}
          className={reviewed ? undefined : "text-state-attention"}
        />
        {s.ref ? (
          <TrustTag label={`pinned @ ${s.ref}`} icon={<Pin />} />
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            disabled={isBusy}
            onClick={onGates}
            title="Run the deterministic gates for this scope, or copy an auditor command"
          >
            <TestTubes className="size-3" />
            Gates
          </Button>

          <Button
            variant="outline"
            size="xs"
            disabled={isBusy}
            onClick={onSync}
            title="Clone+read this source and pin the commit (source sync)"
          >
            {busyVerb === "sync" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Sync
          </Button>

          <Button
            variant="outline"
            size="xs"
            disabled={isBusy || reviewed}
            onClick={onTrust}
            title={
              reviewed
                ? "Already reviewed"
                : "Promote untrusted → reviewed (gates admission)"
            }
          >
            {busyVerb === "trust" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ShieldCheck className="size-3" />
            )}
            Trust
          </Button>

          <Button
            variant="destructive"
            size="xs"
            disabled={isBusy}
            onClick={onRemove}
            title="Drop this source from the manifest (source remove)"
          >
            {busyVerb === "remove" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Trash2 className="size-3" />
            )}
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A single confirm dialog reused for Trust (standing config) and Remove. */
function ConfirmDialog({
  confirm,
  busy,
  onCancel,
  onConfirm,
}: {
  confirm: Confirm;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const open = confirm !== null;
  const isTrust = confirm?.verb === "trust";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            {isTrust ? "Trust source" : "Remove source"}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {confirm ? (
              isTrust ? (
                <>
                  Promote{" "}
                  <span className="text-foreground">{confirm.id}</span> from
                  untrusted to{" "}
                  <span className="text-state-ok">reviewed</span>. Trust is a
                  standing-config change — it gates admission of executable
                  resources synced from this source. Continue?
                </>
              ) : (
                <>
                  Drop{" "}
                  <span className="text-foreground">{confirm.id}</span> from the
                  source manifest. Its synced cache and catalog records are no
                  longer tracked. This cannot be undone from here. Continue?
                </>
              )
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={isTrust ? "default" : "destructive"}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : isTrust ? (
              <ShieldCheck className="size-3.5" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            {isTrust ? "Trust source" : "Remove source"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
