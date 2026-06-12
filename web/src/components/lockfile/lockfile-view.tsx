"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  FileCheck2,
  FileLock,
  GitCompare,
  Loader2,
  Scale,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/forge";
import { cn } from "@/lib/utils";
import type {
  BridgeEnvelope,
  LockDiffChange,
  LockDiffData,
  LockEntry,
  LockShowData,
} from "@/lib/types";

// ──────────────────────────────────────────────────────────────────────────
// POST helper — the "write lock" / "bump & re-resolve" action rides POST
// /api/lock { action:"write" } (active-scope; the bridge resolves the root and
// passes --apply, the same convention as /api/tailoring and /api/composition).
// `lock write` RESOLVEs the composition (adopted ∪ overlays ∪ adjudication +
// pinned refs), computes the entries + deterministic hash, and writes
// <activeRoot>/forge.lock atomically. MANIFEST-ONLY — it NEVER materializes or
// modifies any real .claude/ file, the library, or any resource content. Returns
// the parsed C3 envelope, or null after surfacing the error toast.
// ──────────────────────────────────────────────────────────────────────────

async function postLockWrite(): Promise<BridgeEnvelope | null> {
  const res = await fetch("/api/lock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "write" }),
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
            ?.message ?? "Lock write failed.");
    toast.error(msg);
    return null;
  }
  return json as BridgeEnvelope;
}

// ──────────────────────────────────────────────────────────────────────────
// Render helpers — one mono LINE PER ENTRY in the forge.lock code block:
//   <uid> <sourceId>@<version> #<commit> +N overlays [adjudicated→<winner>]
// Library-local entries (sourceId === null) show "library"; an unpinned/library
// entry has no commit. Overlays collapse to "+N overlay(s)"; adjudication shows
// the recorded winner sourceId. The uid is padded so columns line up like a real
// lockfile (the prototype's `.cl .k2` + non-breaking-space padding).
// ──────────────────────────────────────────────────────────────────────────

const UID_PAD = 26;

/** Right-pad a uid with non-breaking spaces for mono column alignment. */
function padUid(uid: string): string {
  return uid.length >= UID_PAD
    ? `${uid} `
    : uid + " ".repeat(UID_PAD - uid.length);
}

/** "<sourceId>@<version>" — "library" stands in for the library-local copy. */
function sourceRef(
  sourceId: string | null,
  version: string | null,
): string {
  const src = sourceId ?? "library";
  return version ? `${src}@${version}` : src;
}

/** Short content-hash glyph for a commit; "" when there is none. */
function shortCommit(commit: string | null): string {
  if (!commit) return "";
  return commit.length > 10 ? commit.slice(0, 10) : commit;
}

/** Compact "from"/"to" summary line for a "~" diff change. */
function changeRef(
  c: NonNullable<LockDiffChange["from"]>,
  sourceId: string | null,
): string {
  const ref = sourceRef(sourceId, c.version);
  const commit = shortCommit(c.commit);
  const bits = [ref];
  if (commit) bits.push(`#${commit}`);
  if (c.overlays.length) bits.push(`+${c.overlays.length} overlay`);
  if (c.adjudication) bits.push(`adjudicated→${c.adjudication}`);
  return bits.join(" ");
}

// ──────────────────────────────────────────────────────────────────────────
// LockfileView — the prototype LockfileView: a meta bar (committed pill +
// schema/hash/generatedAt + count + in-sync vs "N changes — lock stale"), the
// forge.lock rendered as a mono code block (one line per entry), and — when the
// diff has changes — an "update available / preview diff" banner with the +/~/-
// lines and a "write lock" / "bump & re-resolve" button.
// ──────────────────────────────────────────────────────────────────────────

export function LockfileView({
  data,
  diff,
}: {
  data: LockShowData;
  /** The freshly-resolved diff vs the current forge.lock; null when unavailable. */
  diff: LockDiffData | null;
}) {
  const router = useRouter();
  const { lockPath, exists, lock, committed, inSync } = data;

  const changeCount = diff?.summary.total ?? 0;
  const hasChanges = changeCount > 0;
  // Prefer the lock's own inSync flag; fall back to the diff's when the lock is
  // absent but the composition resolves to entries.
  const synced = exists ? inSync : !hasChanges;

  const [showDiff, setShowDiff] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const runWrite = React.useCallback(async () => {
    setBusy(true);
    try {
      const env = await postLockWrite();
      if (!env) return;
      toast.success(
        exists
          ? "Re-resolved forge.lock — composition pinned."
          : "Wrote forge.lock — composition pinned.",
      );
      setShowDiff(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }, [exists, router]);

  const entries: LockEntry[] = lock?.entries ?? [];

  return (
    <div className="flex flex-col gap-5">
      {/* Intro banner — explains the lockfile model (project-toned, calm). */}
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-state-info/40 bg-state-info/[0.06] px-4 py-3 font-mono text-[length:var(--text-sm)] text-foreground">
        <FileLock className="size-4 shrink-0 text-state-info" />
        <span>
          The resolved composition, frozen as a committable artifact — one line
          per resource: source, pinned ref, content hash, overlays, adjudication
          choice. Reproducible and diffable; this is what every machine builds
          from.{" "}
          <b className="text-foreground">Manifest only</b> — nothing is written
          to the library or real .claude/ files here.
        </span>
      </div>

      {/* Meta bar — the prototype `.lock-meta`: committed pill + schema / hash /
          generated + resolved count + the in-sync / stale indicator. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-border bg-card px-4 py-3 font-mono text-[length:var(--text-2xs)] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <FileCheck2
            className={cn(
              "size-3.5",
              committed ? "text-state-ok" : "text-muted-foreground/60",
            )}
          />
          {committed ? "committed" : "uncommitted"}
        </span>
        <span>
          schema{" "}
          <b className="text-foreground">
            {lock ? `${lock.schema} · v${lock.version}` : "—"}
          </b>
        </span>
        <span>
          hash <b className="text-foreground">{lock ? lock.hash : "—"}</b>
        </span>
        <span>
          generated{" "}
          <b className="text-foreground">{lock ? lock.generatedAt : "—"}</b>
        </span>
        <span>
          <b className="text-foreground tabular-nums">{entries.length}</b>{" "}
          resources resolved
        </span>
        <span className="flex-1" />
        {synced ? (
          <StatusPill tone="ok">in sync</StatusPill>
        ) : (
          <StatusPill tone="attention">
            {hasChanges
              ? `${changeCount} change${changeCount > 1 ? "s" : ""} — lock stale`
              : "lock stale"}
          </StatusPill>
        )}
      </div>

      {/* Update-available banner — only when the diff has changes. Notify, never
          auto-bump: the pin holds until the user previews + writes. */}
      {hasChanges ? (
        <div className="flex items-center gap-3 rounded-lg border border-state-attention/35 bg-state-attention/[0.08] px-4 py-3">
          <Scale className="size-4 shrink-0 text-state-attention" />
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[length:var(--text-sm)] text-foreground">
              <b className="text-state-attention">
                {changeCount} change{changeCount > 1 ? "s" : ""}
              </b>{" "}
              available ·{" "}
              <span className="text-muted-foreground">
                {diff
                  ? `+${diff.summary.added} ~${diff.summary.changed} -${diff.summary.removed} vs the resolved composition`
                  : "the composition has drifted from the lock"}
              </span>
            </div>
            <div className="mt-0.5 font-mono text-[length:var(--text-2xs)] text-muted-foreground">
              notify, never auto-bump — the lock holds until you review the diff
              and re-resolve.
            </div>
          </div>
          <Button
            variant={showDiff ? "default" : "outline"}
            size="sm"
            onClick={() => setShowDiff((v) => !v)}
            className="font-mono text-[length:var(--text-xs)]"
          >
            <GitCompare className="size-3.5" />
            {showDiff ? "hide diff" : "preview diff"}
          </Button>
        </div>
      ) : null}

      {/* Diff code block — the +/~/- lines (state-ok add, state-attention del),
          shown when the banner's "preview diff" is toggled on. */}
      {showDiff && hasChanges && diff ? (
        <div className="overflow-hidden rounded-lg border border-border bg-neutral-950">
          <LcHead icon={<GitCompare className="size-3.5" />}>
            forge.lock — pending: re-resolve composition ({diff.priorHash ?? "—"}{" "}
            → {diff.hash})
          </LcHead>
          <div className="overflow-x-auto p-4 font-mono text-[length:var(--text-xs)] leading-[1.7]">
            {diff.changes.map((c, i) => (
              <DiffLines key={`${c.op}:${c.uid}:${c.sourceId ?? "lib"}:${i}`} change={c} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
            <span className="flex items-center gap-1.5 font-mono text-[length:var(--text-2xs)] text-state-warn">
              <Scale className="size-3" />
              re-resolving freezes the current adopted set + overlays +
              adjudication into a new hash.
            </span>
            <span className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setShowDiff(false)}
              className="font-mono text-[length:var(--text-xs)]"
            >
              dismiss
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={busy}
              onClick={runWrite}
              className="font-mono text-[length:var(--text-xs)]"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ArrowUpRight className="size-3.5" />
              )}
              bump &amp; re-resolve
            </Button>
          </div>
        </div>
      ) : (
        // ── The forge.lock code block — one mono line per resolved entry. ──────
        <div className="overflow-hidden rounded-lg border border-border bg-neutral-950">
          <LcHead icon={<FileLock className="size-3.5" />}>forge.lock</LcHead>
          <div className="overflow-x-auto p-4 font-mono text-[length:var(--text-xs)] leading-[1.85]">
            {!exists ? (
              <div className="whitespace-nowrap text-neutral-600">
                # no forge.lock yet — resolve the composition to write one
              </div>
            ) : !lock ? (
              <div className="whitespace-nowrap text-state-attention">
                # forge.lock is malformed — re-resolve to rewrite it
              </div>
            ) : (
              <>
                <div className="whitespace-nowrap text-neutral-600">
                  # {lock.schema} · v{lock.version} · hash {lock.hash} ·
                  generated {lock.generatedAt}
                </div>
                <div className="whitespace-nowrap text-neutral-600">
                  resources:
                </div>
                {entries.length === 0 ? (
                  <div className="whitespace-nowrap text-neutral-600">
                    &#160;&#160;# nothing adopted — the resolved set is empty
                  </div>
                ) : (
                  entries.map((e) => (
                    <LockLine key={`${e.sourceId ?? "lib"}:${e.uid}`} entry={e} />
                  ))
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Action row — write / re-resolve the lock. Disabled while there is
          nothing to do (an existing, in-sync lock); the diff banner carries the
          bump action when the lock is stale. */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant={exists ? "outline" : "default"}
          size="sm"
          disabled={busy || (exists && synced)}
          onClick={runWrite}
          className="font-mono text-[length:var(--text-xs)]"
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FileLock className="size-3.5" />
          )}
          {!exists ? "write lock" : synced ? "lock in sync" : "re-resolve lock"}
        </Button>
        <span className="font-mono text-[length:var(--text-2xs)] text-muted-foreground">
          {exists && synced
            ? "forge.lock matches the resolved composition — nothing to write."
            : "writes ONLY forge.lock — no .claude/ materialization, no library mutation."}
        </span>
      </div>

      {/* Footer — the forge.lock path + the sources.lock distinction. */}
      <p
        className="truncate font-mono text-[length:var(--text-2xs)] text-muted-foreground"
        title={lockPath}
      >
        {lockPath}{" "}
        <span className="text-muted-foreground/60">
          · the project lockfile (git-committable) — distinct from
          .forge/sources.lock, which pins SOURCE commits (machine-local).
        </span>
      </p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// One resolved lock line — the prototype `.cl`: kind-tinted uid + source@ref +
// #hash + overlays + adjudication.
// ──────────────────────────────────────────────────────────────────────────

function LockLine({ entry }: { entry: LockEntry }) {
  const commit = shortCommit(entry.commit);
  return (
    <div className="whitespace-nowrap">
      <span
        className="text-foreground"
        style={
          KIND_VAR.has(entry.kind)
            ? { color: `var(--kind-${entry.kind})` }
            : undefined
        }
      >
        &#160;&#160;{padUid(entry.uid)}
      </span>
      <span className="mr-3 text-neutral-300">
        {sourceRef(entry.sourceId, entry.version)}
      </span>
      {commit ? <span className="mr-3 text-neutral-600">#{commit}</span> : null}
      {entry.overlays.length ? (
        <span className="mr-3 text-state-ok">
          +{entry.overlays.length} overlay
          {entry.overlays.length > 1 ? "s" : ""}
        </span>
      ) : null}
      {entry.adjudication ? (
        <span className="text-state-info">
          adjudicated→{entry.adjudication}
        </span>
      ) : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// One diff change — "~" renders a del+add pair, "+" a single add line, "-" a
// single del line. Add tints state-ok, del tints state-attention (per contract).
// ──────────────────────────────────────────────────────────────────────────

function DiffLines({ change }: { change: LockDiffChange }) {
  const uid = padUid(change.uid);

  if (change.op === "~" && change.from && change.to) {
    return (
      <>
        <DelLine uid={uid} text={changeRef(change.from, change.sourceId)} />
        <AddLine
          uid={uid}
          text={changeRef(change.to, change.sourceId)}
          note={change.note}
        />
      </>
    );
  }

  if (change.op === "-") {
    const text = change.from
      ? changeRef(change.from, change.sourceId)
      : sourceRef(change.sourceId, null);
    return <DelLine uid={uid} text={text} note={change.note} />;
  }

  // "+" — newly resolved.
  const text = change.to
    ? changeRef(change.to, change.sourceId)
    : sourceRef(change.sourceId, null);
  return <AddLine uid={uid} text={text} note={change.note} />;
}

function AddLine({
  uid,
  text,
  note,
}: {
  uid: string;
  text: string;
  note?: string;
}) {
  return (
    <div className="whitespace-nowrap bg-state-ok/10 pl-0.5 text-state-ok/90">
      <span className="inline-block w-4 text-state-ok">+</span>
      {uid} {text}
      {note ? <span className="text-neutral-500">  # {note}</span> : null}
    </div>
  );
}

function DelLine({
  uid,
  text,
  note,
}: {
  uid: string;
  text: string;
  note?: string;
}) {
  return (
    <div className="whitespace-nowrap bg-state-attention/10 pl-0.5 text-state-attention/80">
      <span className="inline-block w-4 text-state-attention">-</span>
      {uid} {text}
      {note ? <span className="text-neutral-500">  # {note}</span> : null}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Shared chrome — the prototype `.lc-head` code-block header band.
// ──────────────────────────────────────────────────────────────────────────

function LcHead({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-3 font-mono text-[length:var(--text-2xs)] uppercase tracking-[var(--tracking-wide)] text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

/** Kinds that have a registered `--kind-*` accent token (else default fg). */
const KIND_VAR = new Set([
  "rule",
  "skill",
  "agent",
  "command",
  "hook",
  "bundle",
  "memory",
  "validator",
  "mcp",
]);
