"use client";

import * as React from "react";
import Link from "next/link";
import {
  Loader2,
  AlertTriangle,
  ExternalLink,
  ArrowDownToLine,
  ArrowUpFromLine,
  Gauge,
  ShieldAlert,
  Network,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { OpenInEditor, editorHref } from "@/components/open-in-editor";
import { RunEvalButton } from "@/components/run-eval-button";
import { cn } from "@/lib/utils";
import type { BridgeEnvelope, Finding, FindingLevel } from "@/lib/types";
import type { ArtifactKind, RegistryArtifact, ResourceKind } from "@/lib/types";
import {
  type RegistryShowData,
  type ChangelogEntry,
  type ArtifactCost,
  shortHash,
  statusBadgeVariant,
  criticalityBadgeVariant,
  KIND_ACCENT,
} from "./registry-helpers";

type DrawerProps = {
  /** The row the user clicked (from `registry ls`) — shown immediately. */
  artifact: RegistryArtifact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Enrichment for the selected artifact, joined by the server page and threaded
   * through the table. Declared here so the detail-rendering feature agent can
   * consume them; this component does NOT yet render them.
   */
  /** Joined `forge analyze` cost slice; undefined when the analyzer had no entry. */
  cost?: ArtifactCost;
  /** uids that declare this artifact in their dependsOn (reverse index). */
  dependents?: string[];
  /** `forge validate` findings for this artifact's file. */
  findings?: Finding[];
};

type FetchState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ok"; data: RegistryShowData; findings: BridgeEnvelope["findings"] }
  | { phase: "error"; message: string };

/**
 * Kinds that have an on-disk editor at /resources/[kind]/[id]. This is the
 * overlap of ArtifactKind and ResourceKind: registry-only kinds ("validator",
 * "meta-test", "engine") have no editor, and ResourceKind's "memory" is never an
 * ArtifactKind. Typing it as the intersection lets it narrow to BOTH so the
 * value passes to <OpenInEditor> (which takes ResourceKind) with no cast.
 */
type EditableArtifactKind = ArtifactKind & ResourceKind;

const EDITABLE_KINDS: readonly EditableArtifactKind[] = [
  "agent",
  "skill",
  "command",
  "rule",
  "bundle",
  "hook",
];

function isEditableKind(kind: ArtifactKind): kind is EditableArtifactKind {
  return (EDITABLE_KINDS as readonly string[]).includes(kind);
}

/**
 * A dependency/dependent target is a uid ("<kind>:<id>"). Split it once and,
 * when the kind has an editor, return the route so the row links to it. Returns
 * null when the uid isn't editable (e.g. validator/engine) or is malformed —
 * the caller then renders inert text instead of a dead link.
 */
function editorHrefForUid(uid: string): string | null {
  const sep = uid.indexOf(":");
  if (sep <= 0) return null;
  const kind = uid.slice(0, sep) as ArtifactKind;
  const id = uid.slice(sep + 1);
  if (!id || !isEditableKind(kind)) return null;
  return editorHref(kind, id);
}

/** One dependency/dependent uid row — linked to its editor when editable. */
function RelationRow({ uid }: { uid: string }) {
  const href = editorHrefForUid(uid);
  const base =
    "flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1 font-mono text-[11px]";
  if (!href) {
    return (
      <li className={cn(base, "text-foreground")}>
        <span className="truncate">{uid}</span>
      </li>
    );
  }
  return (
    <li className={cn(base, "transition-colors hover:bg-muted/70")}>
      <Link
        href={href}
        className="inline-flex min-w-0 items-center gap-1.5 text-foreground hover:underline"
      >
        <span className="truncate">{uid}</span>
        <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

/** Color classes per finding level (border + bg + text), matching the table palette. */
const FINDING_LEVEL_CLASS: Record<FindingLevel, string> = {
  ERROR:
    "border-rose-500/40 bg-rose-500/5 text-rose-600 dark:text-rose-400",
  WARN: "border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-400",
  INFO: "border-sky-500/40 bg-sky-500/5 text-sky-600 dark:text-sky-400",
};

/** One `forge validate` finding for this artifact's file, linked to the editor. */
function FindingRow({
  finding,
  editKind,
  editId,
}: {
  finding: Finding;
  editKind: ResourceKind | null;
  editId: string | null;
}) {
  const loc = `${finding.path}${finding.line != null ? `:${finding.line}` : ""}`;
  const href = editKind && editId ? editorHref(editKind, editId) : null;
  return (
    <li
      className={cn(
        "rounded border px-2.5 py-2",
        FINDING_LEVEL_CLASS[finding.level],
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <Badge
          variant="outline"
          className={cn("font-mono text-[10px]", FINDING_LEVEL_CLASS[finding.level])}
        >
          {finding.level}
        </Badge>
        {href ? (
          <Link
            href={href}
            className="inline-flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground hover:underline"
          >
            <span className="truncate">{loc}</span>
            <ExternalLink className="size-3 shrink-0" />
          </Link>
        ) : (
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {loc}
          </span>
        )}
      </div>
      <p className="mt-1 font-mono text-[11px] text-foreground">
        {finding.message}
      </p>
      {finding.source ? (
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
          {finding.source}
        </p>
      ) : null}
    </li>
  );
}

/** A small section header reused by the enrichment blocks. */
function SectionLabel({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
      <Icon className="size-3" />
      {children}
    </p>
  );
}

/** Italic muted placeholder used when an enrichment section has no entries. */
function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[11px] italic text-muted-foreground/70">
      {children}
    </p>
  );
}

/** A labelled monospace field row in the drawer body. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-1">
      <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 break-words font-mono text-xs text-foreground">
        {children}
      </span>
    </div>
  );
}

function ChangelogRow({ entry }: { entry: ChangelogEntry }) {
  const fromRev = entry.from?.rev;
  const toRev = entry.to?.rev;
  return (
    <li className="rounded border border-border bg-muted/30 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-foreground">
          {fromRev !== undefined ? `r${fromRev} → ` : ""}
          {toRev !== undefined ? `r${toRev}` : ""}
          {entry.to?.ver ? ` · v${entry.to.ver}` : ""}
        </span>
        <time className="font-mono text-[10px] text-muted-foreground">
          {new Date(entry.ts).toLocaleString()}
        </time>
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        {entry.reason}
        {entry.evalStatus ? ` · eval:${entry.evalStatus}` : ""}
      </p>
      {entry.from?.hash && entry.to?.hash ? (
        <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
          {shortHash(entry.from.hash)} → {shortHash(entry.to.hash)}
        </p>
      ) : null}
    </li>
  );
}

export function RegistryDetailDrawer({
  artifact,
  open,
  onOpenChange,
  cost,
  dependents,
  findings,
}: DrawerProps) {
  const [state, setState] = React.useState<FetchState>({ phase: "idle" });
  const uid = artifact?.uid ?? null;

  React.useEffect(() => {
    if (!open || !uid) return;
    let cancelled = false;

    // The whole fetch flow (including the loading transition) lives inside an
    // async function so no setState runs synchronously in the effect body —
    // every setState here is a guarded async continuation. The `cancelled`
    // flag (flipped by cleanup) drops stale responses from a superseded uid.
    async function load(showUid: string) {
      setState({ phase: "loading" });
      try {
        const res = await fetch(
          `/api/registry?uid=${encodeURIComponent(showUid)}`,
          { cache: "no-store" },
        );
        const env = (await res.json()) as BridgeEnvelope<RegistryShowData>;
        if (cancelled) return;
        // ok envelope OR a recoverable record-bearing payload both render.
        if (env.data && (env.data as RegistryShowData).uid) {
          setState({
            phase: "ok",
            data: env.data as RegistryShowData,
            findings: env.findings,
          });
        } else {
          const msg =
            env.findings?.find((f) => f.level === "ERROR")?.message ??
            env.findings?.[0]?.message ??
            "No record returned for this artifact.";
          setState({ phase: "error", message: msg });
        }
      } catch (err: unknown) {
        if (cancelled) return;
        setState({
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    void load(uid);

    return () => {
      cancelled = true;
    };
  }, [open, uid]);

  // The clicked row is the immediate source of truth; the fetched record refines it.
  const record: RegistryShowData | RegistryArtifact | null =
    state.phase === "ok" ? state.data : artifact;
  const changelog: ChangelogEntry[] =
    state.phase === "ok" ? state.data.changelog ?? [] : [];

  // This artifact's own editor target, used to link its validate findings back
  // to the file. Null for non-editable kinds (validator/meta-test/engine).
  const recordEditKind: ResourceKind | null =
    record && isEditableKind(record.kind) ? record.kind : null;
  const recordEditId = record ? record.id : null;

  // Real (non-synthetic) dependency uids: drop "module:*" reverse-index targets.
  const realDependsOn = (record?.dependsOn ?? []).filter(
    (d) => !d.startsWith("module:"),
  );
  const dependentUids = dependents ?? [];
  const fileFindings = findings ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className={cn(
          // Right-side drawer: full-height sheet pinned to the right edge.
          "fixed inset-y-0 right-0 left-auto top-0 h-dvh w-full max-w-md translate-x-0 translate-y-0",
          "grid-rows-[auto_1fr] gap-0 rounded-none rounded-l-xl p-0 sm:max-w-md",
        )}
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2 font-mono text-sm">
            {record ? (
              <Badge
                variant="outline"
                className={cn(
                  "font-mono text-[10px]",
                  KIND_ACCENT[record.kind] ?? "",
                )}
              >
                {record.kind}
              </Badge>
            ) : null}
            <span className="truncate">{uid}</span>
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px]">
            {record?.description || "Registry artifact detail"}
          </DialogDescription>
          {record ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {isEditableKind(record.kind) ? (
                <>
                  <OpenInEditor kind={record.kind} id={record.id} />
                  <RunEvalButton target={record.uid} />
                </>
              ) : null}
              <Link
                href={`/graph?focus=${encodeURIComponent(record.uid)}`}
                title={`Focus ${record.uid} in the dependency graph`}
                className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                <Network className="size-3" />
                Focus in graph
              </Link>
            </div>
          ) : null}
        </DialogHeader>

        <ScrollArea className="h-full">
          <div className="px-4 py-3">
            {state.phase === "loading" ? (
              <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                loading record + changelog…
              </p>
            ) : null}

            {state.phase === "error" ? (
              <p className="mb-3 flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-2.5 py-2 font-mono text-[11px] text-amber-600 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {state.message}
              </p>
            ) : null}

            {record ? (
              <>
                <section>
                  <Field label="uid">{record.uid}</Field>
                  <Field label="id">{record.id}</Field>
                  <Field label="path">
                    <span className="inline-flex items-center gap-1">
                      {record.path}
                      <ExternalLink className="size-3 text-muted-foreground" />
                    </span>
                  </Field>
                  <Field label="version">{record.version}</Field>
                  <Field label="revision">r{record.revision}</Field>
                  <Field label="status">
                    <Badge
                      variant={statusBadgeVariant(record.status)}
                      className="font-mono text-[10px]"
                    >
                      {record.status}
                    </Badge>
                  </Field>
                  <Field label="criticality">
                    <Badge
                      variant={criticalityBadgeVariant(record.criticality)}
                      className="font-mono text-[10px]"
                    >
                      {record.criticality}
                    </Badge>
                  </Field>
                  <Field label="owner">{record.owner}</Field>
                  <Field label="hash">
                    <span title={record.contentHash}>
                      {shortHash(record.contentHash, 16)}…
                    </span>
                  </Field>
                  <Field label="updated">
                    {record.updatedAt
                      ? new Date(record.updatedAt).toLocaleString()
                      : "—"}
                  </Field>
                </section>

                {record.modules?.length ? (
                  <>
                    <Separator className="my-3" />
                    <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                      modules
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {record.modules.map((m) => (
                        <Badge
                          key={m}
                          variant="secondary"
                          className="font-mono text-[10px]"
                        >
                          {m}
                        </Badge>
                      ))}
                    </div>
                  </>
                ) : null}

                <Separator className="my-3" />
                <SectionLabel icon={ArrowDownToLine}>
                  dependencies ({realDependsOn.length})
                </SectionLabel>
                {realDependsOn.length ? (
                  <ul className="flex flex-col gap-1">
                    {realDependsOn.map((d) => (
                      <RelationRow key={d} uid={d} />
                    ))}
                  </ul>
                ) : (
                  <EmptyHint>no dependencies</EmptyHint>
                )}

                <Separator className="my-3" />
                <SectionLabel icon={ArrowUpFromLine}>
                  dependents ({dependentUids.length})
                </SectionLabel>
                {dependentUids.length ? (
                  <ul className="flex flex-col gap-1">
                    {dependentUids.map((d) => (
                      <RelationRow key={d} uid={d} />
                    ))}
                  </ul>
                ) : (
                  <EmptyHint>no dependents</EmptyHint>
                )}

                <Separator className="my-3" />
                <SectionLabel icon={Gauge}>always-on cost</SectionLabel>
                <div className="flex items-baseline gap-2 font-mono">
                  <span className="text-sm text-foreground">
                    {cost?.alwaysOn != null
                      ? `${cost.alwaysOn.toLocaleString()} tok`
                      : "—"}
                  </span>
                  {cost?.residency ? (
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {cost.residency}
                    </Badge>
                  ) : null}
                </div>

                <Separator className="my-3" />
                <SectionLabel icon={ShieldAlert}>
                  validate findings ({fileFindings.length})
                </SectionLabel>
                {fileFindings.length ? (
                  <ul className="flex flex-col gap-1.5">
                    {fileFindings.map((f, i) => (
                      <FindingRow
                        key={`${f.source}-${f.line ?? "x"}-${i}`}
                        finding={f}
                        editKind={recordEditKind}
                        editId={recordEditId}
                      />
                    ))}
                  </ul>
                ) : (
                  <EmptyHint>no findings touch this file</EmptyHint>
                )}

                {record.tags?.length ? (
                  <>
                    <Separator className="my-3" />
                    <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                      tags
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {record.tags.map((t) => (
                        <Badge
                          key={t}
                          variant="ghost"
                          className="font-mono text-[10px]"
                        >
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </>
                ) : null}

                <Separator className="my-3" />
                <p className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                  changelog{" "}
                  {state.phase === "ok" ? `(${changelog.length})` : ""}
                </p>
                {state.phase === "loading" ? (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    …
                  </p>
                ) : changelog.length ? (
                  <ul className="flex flex-col gap-1.5">
                    {changelog.map((e, i) => (
                      <ChangelogRow key={`${e.ts}-${i}`} entry={e} />
                    ))}
                  </ul>
                ) : (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    No recorded revisions — this artifact is at its first
                    revision.
                  </p>
                )}
              </>
            ) : null}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
