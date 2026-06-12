"use client";

import { CrosshairIcon, GitBranchIcon, XIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MemoryEntry } from "@/lib/forge-bridge";

import { memoryTypeColor } from "./memory-colors";

interface LinkRef {
  /** target/source entry id (resolved) or the raw dangling target text. */
  id: string;
  /** display label (title for resolved, raw text for dangling). */
  label: string;
  /** false → dangling (unresolved); not clickable. */
  resolved: boolean;
}

interface Props {
  entry: MemoryEntry;
  isOrphan: boolean;
  isFocus: boolean;
  /** Resolved + dangling outbound links from this entry. */
  outbound: LinkRef[];
  /** Resolved inbound links (backlinks) to this entry. */
  inbound: LinkRef[];
  onClose: () => void;
  /** Re-center the lens on this entry. Hidden when already the focus. */
  onFocusHere: () => void;
  /** Pull this entry's neighbors into view. Only when it IS the focus. */
  onExpandNeighbors?: () => void;
  /** Re-center on a clicked inbound/outbound (resolved) link. */
  onNavigate: (id: string) => void;
}

/** Human "updated N ago" from a raw frontmatter date string (best-effort). */
function ageLabel(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return raw; // not a parseable date → show as-is
  const diffMs = Date.now() - t;
  if (diffMs < 0) return raw;
  const day = 86_400_000;
  const days = Math.floor(diffMs / day);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  const years = Math.floor(days / 365);
  return `${years} yr ago`;
}

/** A floating right-side drawer describing the clicked memory entry. */
export function MemoryDetailPanel({
  entry,
  isOrphan,
  isFocus,
  outbound,
  inbound,
  onClose,
  onFocusHere,
  onExpandNeighbors,
  onNavigate,
}: Props) {
  const color = memoryTypeColor(entry.type);
  const age = ageLabel(entry.updated);

  return (
    <div className="absolute top-3 right-3 z-20 flex max-h-[calc(100%-1.5rem)] w-80 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg">
      <div className="flex items-start justify-between gap-2 border-b border-border p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ background: color }}
            />
            <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {entry.type ?? "memory"}
            </span>
          </div>
          <h3 className="mt-0.5 truncate font-mono text-sm font-semibold">
            {entry.title}
          </h3>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 font-mono text-[11px]">
        <div className="flex flex-wrap gap-1">
          {entry.status ? <Badge variant="outline">{entry.status}</Badge> : null}
          {entry.confidence != null ? (
            <Badge variant="outline">
              conf {entry.confidence > 1 ? `${entry.confidence}` : entry.confidence.toFixed(2)}
            </Badge>
          ) : null}
          {age ? <Badge variant="outline">updated {age}</Badge> : null}
          {isOrphan ? <Badge variant="secondary">orphan</Badge> : null}
        </div>

        {entry.description ? (
          <p className="leading-relaxed text-muted-foreground">
            {entry.description}
          </p>
        ) : null}

        <Field label="id" value={entry.id} />
        <Field label="path" value={entry.relPath} />

        {outbound.length ? (
          <LinkList
            label="links out"
            items={outbound}
            onNavigate={onNavigate}
          />
        ) : null}
        {inbound.length ? (
          <LinkList label="backlinks" items={inbound} onNavigate={onNavigate} />
        ) : null}
        {outbound.length === 0 && inbound.length === 0 ? (
          <p className="text-muted-foreground/70">no links</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 border-t border-border p-3">
        {!isFocus ? (
          <Button
            variant="default"
            size="sm"
            className="w-full"
            onClick={onFocusHere}
          >
            <CrosshairIcon />
            Focus here
          </Button>
        ) : null}
        {isFocus && onExpandNeighbors ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onExpandNeighbors}
          >
            <GitBranchIcon />
            Expand neighbors
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}: </span>
      <span className="break-all">{value}</span>
    </div>
  );
}

function LinkList({
  label,
  items,
  onNavigate,
}: {
  label: string;
  items: LinkRef[];
  onNavigate: (id: string) => void;
}) {
  return (
    <div>
      <span className="text-muted-foreground">{label}:</span>
      <ul className="mt-1 space-y-0.5 pl-1">
        {items.map((it, i) =>
          it.resolved ? (
            <li key={`${it.id}-${i}`}>
              <button
                type="button"
                onClick={() => onNavigate(it.id)}
                className="w-full truncate text-left text-foreground transition-colors hover:text-primary hover:underline"
                title={it.label}
              >
                • {it.label}
              </button>
            </li>
          ) : (
            <li
              key={`${it.id}-${i}`}
              className="truncate text-destructive"
              title={`${it.label} (dangling)`}
            >
              • {it.label}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

export type { LinkRef };
