"use client";

import { useMemo } from "react";
import {
  Clock,
  Database,
  FileCode,
  FileText,
  GitBranch,
  Link2Off,
  ListTree,
  RefreshCw,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { MemoryEntry, MemoryVault } from "@/lib/forge-bridge/memory-vault";

import { memoryTypeColor } from "./memory-colors";

interface Props {
  /** The whole memory vault read server-side (entries + links + index). */
  data: MemoryVault;
}

// ── Local pure mirrors of the bridge's analysis ─────────────────────────────
// The bridge module (memory-vault.ts) is SERVER-ONLY (imports node:fs), so a
// "use client" component can only take its *types*. The health math + the index
// preview below intentionally mirror generateIndexMarkdown / analyzeCuration so
// the dashboard shows exactly what the (not-yet-built) generator would produce,
// without pulling node:fs into the client bundle. READ-ONLY: derives strings &
// counts, writes nothing.

/** Staleness threshold (mirrors STALE_AGE_MS): untouched > ~90d ⇒ stale. */
const STALE_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Confidence below this (when set) flags an entry as low-confidence. */
const LOW_CONFIDENCE = 0.4;
/** Group label for typeless entries — always sorts last in the index. */
const UNCATEGORIZED_GROUP = "Uncategorized";

/** An entry is "active" when it carries no status, or status "active". */
function isActive(e: MemoryEntry): boolean {
  return e.status === null || e.status.toLowerCase() === "active";
}

/** First-sentence "hook" from a description (mirrors hookFromDescription). */
function hookFromDescription(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : flat).trim();
}

/** Parse `updated` → epoch ms, or null when absent/unparseable. */
function updatedMs(updated: string | null): number | null {
  if (!updated) return null;
  const t = Date.parse(updated);
  return Number.isNaN(t) ? null : t;
}

/** Human "N days ago" age from an `updated` string (null ⇒ "no date"). */
function ageLabel(updated: string | null, now: number): string {
  const ms = updatedMs(updated);
  if (ms === null) return "no date";
  const days = Math.floor((now - ms) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return "1 month ago";
  if (months < 12) return `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

/** The index.md content the generator WOULD produce (mirrors generateIndexMarkdown). */
function generateIndexPreview(entries: MemoryEntry[]): string {
  const active = entries.filter(isActive);
  const groups = new Map<string, MemoryEntry[]>();
  for (const e of active) {
    const key = e.type ?? UNCATEGORIZED_GROUP;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === UNCATEGORIZED_GROUP) return 1;
    if (b === UNCATEGORIZED_GROUP) return -1;
    return a.toLowerCase().localeCompare(b.toLowerCase());
  });
  const blocks: string[] = [];
  for (const key of keys) {
    const rows = (groups.get(key) ?? [])
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => {
        const hook = hookFromDescription(e.description);
        return hook
          ? `- ${e.id} — ${e.title} — ${hook}`
          : `- ${e.id} — ${e.title}`;
      });
    blocks.push(`## ${key}\n${rows.join("\n")}`);
  }
  return `# Memory Index\n\n${blocks.join("\n\n")}\n`;
}

/**
 * Vault tab — a recall-index over the memory vault.
 *
 * Entries grouped by type (memory-colors hue per group), each row carrying a
 * confidence chip (when set), an "updated N days ago" age, and the description
 * hook. Per-group + total counts; health badges up top (orphans / unresolved /
 * stale / low-confidence / index-out-of-sync, all computed from entries+links).
 * A read-only "Regenerate index — preview" disclosure shows the markdown the
 * missing generator would emit. Compact, scrollable, font-mono. READ-ONLY.
 */
export function MemoryVaultDashboard({ data }: Props) {
  const { entries, links, indexed, indexExists, indexBody } = data;

  // Group entries by type (typeless → "uncategorized"), groups id-ordered.
  const groups = useMemo(() => {
    const byType = new Map<string, MemoryEntry[]>();
    for (const e of entries) {
      const key = e.type ?? "uncategorized";
      (byType.get(key) ?? byType.set(key, []).get(key)!).push(e);
    }
    return [...byType.entries()]
      .map(([type, items]) => ({
        type,
        items: items.slice().sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => a.type.localeCompare(b.type));
  }, [entries]);

  // Health math — mirrors analyzeCuration (orphans/unresolved/stale/lowConf/sync).
  const health = useMemo(() => {
    const now = Date.now();
    const hasIn = new Set<string>();
    const hasOut = new Set<string>();
    for (const l of links) {
      if (!l.resolved) continue;
      hasOut.add(l.source);
      hasIn.add(l.target);
    }
    const orphans = entries.filter(
      (e) => !hasIn.has(e.id) && !hasOut.has(e.id),
    ).length;
    const unresolved = links.filter((l) => !l.resolved).length;
    const stale = entries.filter((e) => {
      const ms = updatedMs(e.updated);
      return ms === null || now - ms > STALE_AGE_MS;
    }).length;
    const lowConfidence = entries.filter(
      (e) => e.confidence !== null && e.confidence < LOW_CONFIDENCE,
    ).length;

    const generated = generateIndexPreview(entries);
    const indexOutOfSync =
      indexExists && indexBody != null
        ? generated.trim() !== indexBody.trim()
        : false;

    return { orphans, unresolved, stale, lowConfidence, indexOutOfSync, generated };
  }, [entries, links, indexExists, indexBody]);

  if (entries.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center font-mono">
        <Database className="size-9 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">No memory entries found</p>
        <p
          className="max-w-md truncate text-[10px] text-muted-foreground/70"
          title={data.vaultDir}
        >
          {data.vaultDir}
        </p>
      </div>
    );
  }

  const now = Date.now();
  const resolvedLinks = links.filter((l) => l.resolved).length;

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-5 font-mono">
        {/* Summary counts */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {entries.length} entries
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {groups.length} {groups.length === 1 ? "type" : "types"}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {resolvedLinks} links
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {indexed.length} indexed
          </Badge>
          <Badge
            variant={indexExists ? "outline" : "destructive"}
            className="text-[10px]"
          >
            {indexExists ? "index present" : "no index"}
          </Badge>
        </div>

        {/* Health badges */}
        <div className="flex flex-wrap items-center gap-1.5">
          <HealthBadge
            icon={<GitBranch className="size-3" />}
            label="orphans"
            count={health.orphans}
          />
          <HealthBadge
            icon={<Link2Off className="size-3" />}
            label="unresolved"
            count={health.unresolved}
          />
          <HealthBadge
            icon={<Clock className="size-3" />}
            label="stale"
            count={health.stale}
          />
          <HealthBadge
            icon={<Database className="size-3" />}
            label="low-confidence"
            count={health.lowConfidence}
          />
          <Badge
            variant={health.indexOutOfSync ? "destructive" : "outline"}
            className="flex items-center gap-1 text-[9px]"
            title={
              health.indexOutOfSync
                ? "The on-disk index differs from the generated one"
                : indexExists
                  ? "On-disk index matches the generated one"
                  : "No index file on disk to compare"
            }
          >
            <RefreshCw className="size-3" />
            {health.indexOutOfSync
              ? "index out-of-sync"
              : indexExists
                ? "index in sync"
                : "index absent"}
          </Badge>
        </div>

        {/* Per-type recall index */}
        {groups.map(({ type, items }) => (
          <Card key={type} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-wide">
                <span
                  className="inline-block size-2.5 rounded-full"
                  style={{ background: memoryTypeColor(type) }}
                />
                {type}
                <Badge variant="secondary" className="text-[9px]">
                  {items.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1.5">
              {items.map((e) => {
                const hook = hookFromDescription(e.description);
                return (
                  <div
                    key={e.id}
                    className="flex flex-col gap-0.5 rounded px-1.5 py-1 hover:bg-muted"
                    title={e.description || undefined}
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="size-3 shrink-0 text-muted-foreground/60" />
                      <span className="min-w-0 flex-1 truncate text-[11px]">
                        {e.title}
                      </span>
                      {e.confidence !== null ? (
                        <span
                          className="shrink-0 rounded bg-muted px-1 text-[9px] tabular-nums text-muted-foreground"
                          title={`confidence ${e.confidence.toFixed(2)}`}
                        >
                          {e.confidence.toFixed(2)}
                        </span>
                      ) : null}
                      <span className="shrink-0 text-[9px] text-muted-foreground/70">
                        {ageLabel(e.updated, now)}
                      </span>
                      {e.status && e.status.toLowerCase() !== "active" ? (
                        <Badge variant="outline" className="text-[9px]">
                          {e.status}
                        </Badge>
                      ) : null}
                    </div>
                    {hook ? (
                      <p className="truncate pl-5 text-[10px] text-muted-foreground/80">
                        {hook}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))}

        {/* Regenerate index — read-only preview disclosure */}
        <details className="group rounded-md border border-border bg-card/40">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground">
            <ListTree className="size-3.5" />
            <span className="font-mono">Regenerate index — preview</span>
            <Badge variant="outline" className="ml-1 text-[9px]">
              {entries.filter(isActive).length} active
            </Badge>
            {health.indexOutOfSync ? (
              <Badge variant="destructive" className="text-[9px]">
                differs from disk
              </Badge>
            ) : null}
            <span className="ml-auto text-[9px] text-muted-foreground/60 group-open:hidden">
              show
            </span>
            <span className="ml-auto hidden text-[9px] text-muted-foreground/60 group-open:inline">
              hide
            </span>
          </summary>
          <div className="border-t border-border px-3 py-2">
            <p className="mb-2 flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
              <FileCode className="size-3" />
              What the (not-yet-built) generator would write — read-only.
            </p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-[10px] leading-relaxed">
              {health.generated}
            </pre>
          </div>
        </details>
      </div>
    </ScrollArea>
  );
}

/** A single health badge — destructive when count > 0, muted "ok" otherwise. */
function HealthBadge({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <Badge
      variant={count > 0 ? "destructive" : "outline"}
      className="flex items-center gap-1 text-[9px]"
      title={`${count} ${label}`}
    >
      {icon}
      {count} {label}
    </Badge>
  );
}
