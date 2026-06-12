"use client";

import * as React from "react";
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  FileX2,
  GitBranch,
  Link2Off,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { BridgeEnvelope } from "@/lib/types";
import type {
  CurationAnalysis,
  MemoryEntry,
  MemoryVault,
} from "@/lib/forge-bridge/memory-vault";
// Type-only imports (erased at build — safe across the client boundary): the
// active-root verbs return these C3 data shapes via POST /api/memory.
import type {
  ProjectMemoryImportData,
  ProjectMemoryImportItem,
  ProjectMemoryReindexData,
  ProjectMemoryValidateData,
} from "@/lib/forge-bridge/memory-project";

import { memoryTypeColor } from "./memory-colors";

interface Props {
  /** The whole memory vault read server-side (for id → title/path lookup). */
  data: MemoryVault;
  /** The read-only curation report computed server-side. */
  analysis: CurationAnalysis;
}

/** A default-suggested source vault hint for the import path input. */
const DEFAULT_IMPORT_SRC = "/abs/path/to/source/vault";

/** Action-in-flight state — gates buttons while a POST /api/memory is running. */
type Busy =
  | null
  | "reindex-preview"
  | "reindex-write"
  | "validate"
  | "import-preview"
  | "import-apply";

/** Best-effort human label for an import plan item (shapes are permissive). */
function importItemLabel(item: ProjectMemoryImportItem): {
  to: string;
  from: string;
  meta: string;
} {
  const to =
    (item.destRel as string | undefined) ??
    item.to ??
    (item.id as string | undefined) ??
    "?";
  const fromAbs = (item.sourceFile as string | undefined) ?? item.from ?? "";
  const from = fromAbs ? fromAbs.split("/").pop() || fromAbs : "";
  const type = (item.type as string | undefined) ?? "";
  const title = (item.title as string | undefined) ?? "";
  const meta = [type, title].filter(Boolean).join(" · ");
  return { to, from, meta };
}

/**
 * Curate tab — the curation WORKLISTS + the ACTIVE-scope management actions.
 *
 * Renders analyzeCuration() results as actionable triage sections (each
 * collapsible, count-badged, errors/attention first), mirroring
 * graph/triage-panel.tsx + memory/memory-triage.tsx styling.
 *
 * Sections, severity-ordered: index drift → unresolved links → duplicates →
 * low-confidence → orphans → stale. Each entry shows its title and the live
 * vault file path (display only). Sections with no candidates render a clean
 * "none" state.
 *
 * On TOP of the read-only worklists sit the management actions that operate on
 * the ACTIVE harness's memory vault (the library, or the selected project's
 * `.claude/`). They ride POST /api/memory — NO `project` field; the bridge
 * resolves the active scope. Every write verb is guarded preview→apply:
 *   • Regenerate index — preview the dry-run index, then explicitly write index.md.
 *   • Re-validate      — re-run the integrity validator (read-only).
 *   • Import from vault — preview the mapping plan, then apply (additive writes).
 * Mirrors fleet/project-memory.tsx (preview→apply · sonner · router.refresh)
 * but scoped to the active root rather than threading a project path.
 *
 * forge-bridge is server-only — this client component NEVER imports it; types
 * are imported type-only (erased at build) from the SPECIFIC module path.
 */
export function MemoryCurate({ data, analysis }: Props) {
  const router = useRouter();
  const titleById = useMemo(
    () => new Map(data.entries.map((e) => [e.id, e.title])),
    [data.entries],
  );
  const typeById = useMemo(
    () => new Map(data.entries.map((e) => [e.id, e.type])),
    [data.entries],
  );
  const pathById = useMemo(
    () => new Map(data.entries.map((e) => [e.id, filePath(data.vaultDir, e)])),
    [data.entries, data.vaultDir],
  );

  const name = (id: string) => titleById.get(id) ?? id;
  const pathOf = (id: string) => pathById.get(id) ?? null;
  const swatch = (id: string) => memoryTypeColor(typeById.get(id) ?? null);

  const total =
    (analysis.indexOutOfSync ? 1 : 0) +
    analysis.unresolved.length +
    analysis.duplicates.length +
    analysis.lowConfidence.length +
    analysis.orphans.length +
    analysis.stale.length;

  // ── Management action state (ACTIVE-scope, POST /api/memory) ───────────────
  const [busy, setBusy] = useState<Busy>(null);
  const isBusy = busy !== null;

  // Reindex disclosure: a dry-run preview gates the explicit index.md write.
  const [reindexOpen, setReindexOpen] = useState(false);
  const [reindexPreview, setReindexPreview] =
    useState<ProjectMemoryReindexData | null>(null);

  // Import disclosure: a source path + preview plan gate the explicit apply.
  const [importOpen, setImportOpen] = useState(false);
  const [srcDir, setSrcDir] = useState("");
  const [importPreview, setImportPreview] =
    useState<ProjectMemoryImportData | null>(null);

  // POST helper — every action rides /api/memory; NO `project` (active-scope).
  const post = useCallback(
    async <T,>(
      body:
        | { action: "validate" }
        | { action: "reindex"; apply?: boolean }
        | { action: "import"; srcDir: string; apply?: boolean },
    ): Promise<BridgeEnvelope<T> | null> => {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const json = (await res.json()) as
        | BridgeEnvelope<T>
        | { ok: false; error: string };
      if (!res.ok || !json.ok) {
        const msg =
          "error" in json && typeof json.error === "string"
            ? json.error
            : ((json as BridgeEnvelope).findings?.find(
                (f) => f.level === "ERROR",
              )?.message ?? "Memory action failed.");
        toast.error(msg);
        return null;
      }
      return json as BridgeEnvelope<T>;
    },
    [],
  );

  // ── Re-validate (read-only integrity run) ─────────────────────────────────
  const onRevalidate = useCallback(async () => {
    setBusy("validate");
    try {
      const env = await post<ProjectMemoryValidateData>({ action: "validate" });
      if (!env) return;
      toast.success(
        env.data?.passed
          ? "Memory vault is valid."
          : `Vault has ${env.summary?.errors ?? 0} error(s) — see findings.`,
      );
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [post, router]);

  // ── Reindex: PREVIEW (dry-run — returns data.index, writes nothing) ───────
  const onReindexPreview = useCallback(async () => {
    setBusy("reindex-preview");
    try {
      const env = await post<ProjectMemoryReindexData>({ action: "reindex" });
      if (!env) return;
      setReindexPreview(env.data ?? null);
      setReindexOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [post]);

  // ── Reindex: WRITE (explicit confirm → apply:true → --write index.md) ─────
  const onReindexWrite = useCallback(async () => {
    setBusy("reindex-write");
    try {
      const env = await post<ProjectMemoryReindexData>({
        action: "reindex",
        apply: true,
      });
      if (!env) return;
      const n = env.data?.activeEntries ?? 0;
      toast.success(`index.md written — ${n} active entr${n === 1 ? "y" : "ies"}.`);
      setReindexPreview(null);
      setReindexOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [post, router]);

  // ── Import: PREVIEW (mapping plan only — writes nothing) ───────────────────
  const onImportPreview = useCallback(async () => {
    const trimmed = srcDir.trim();
    if (!trimmed) {
      toast.error("Enter an absolute source vault path to preview.");
      return;
    }
    setBusy("import-preview");
    try {
      const env = await post<ProjectMemoryImportData>({
        action: "import",
        srcDir: trimmed,
      });
      if (!env) return;
      setImportPreview(env.data ?? null);
      const n = env.data?.plan?.create?.length ?? 0;
      toast.success(`Preview: ${n} entr${n === 1 ? "y" : "ies"} would be created.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [post, srcDir]);

  // ── Import: APPLY (explicit confirm → apply:true → additive writes) ───────
  const onImportApply = useCallback(async () => {
    const trimmed = srcDir.trim();
    if (!trimmed) {
      toast.error("Enter an absolute source vault path to import.");
      return;
    }
    setBusy("import-apply");
    try {
      const env = await post<ProjectMemoryImportData>({
        action: "import",
        srcDir: trimmed,
        apply: true,
      });
      if (!env) return;
      const written = env.data?.written ?? env.data?.plan?.create?.length ?? 0;
      toast.success(
        `Imported ${written} new entr${written === 1 ? "y" : "ies"} (additive).`,
      );
      setImportPreview(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [post, router, srcDir]);

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-5 font-mono">
        {/* Summary line + active-scope management note. */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" aria-hidden />
            <span className="text-xs text-muted-foreground">
              {total === 0
                ? "Vault is clean — no curation candidates."
                : `${total} curation candidate${total === 1 ? "" : "s"}`}
            </span>
            {analysis.indexOutOfSync ? (
              <Badge variant="destructive" className="text-[9px]">
                index out of sync
              </Badge>
            ) : null}
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
            Manages the ACTIVE harness&apos;s memory vault. Reindex and import are
            guarded writes (preview → apply); re-validate is read-only.
          </p>
        </div>

        {/* ── Management actions (ACTIVE-scope, POST /api/memory) ──────────── */}
        <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              disabled={isBusy}
              onClick={onReindexPreview}
              title="Preview the regenerated index (dry-run, writes nothing)"
            >
              {busy === "reindex-preview" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              Regenerate index
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={isBusy}
              onClick={onRevalidate}
              title="Re-run the integrity validator (read-only)"
            >
              {busy === "validate" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <ShieldCheck className="size-3" />
              )}
              Re-validate
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={isBusy}
              onClick={() => setImportOpen((v) => !v)}
              title="Map a foreign vault into the active scope's forge schema"
            >
              {importOpen ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              <Upload className="size-3" />
              Import from vault
            </Button>
          </div>

          {/* Reindex disclosure: preview the index → explicit write. */}
          {reindexOpen && reindexPreview ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <RefreshCw className="size-3" />
                  index preview ({reindexPreview.activeEntries ?? 0} active)
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={isBusy}
                  onClick={() => {
                    setReindexOpen(false);
                    setReindexPreview(null);
                  }}
                >
                  close
                </Button>
              </div>
              {reindexPreview.indexPath ? (
                <p className="break-all text-[10px] text-muted-foreground/70">
                  {reindexPreview.indexPath}
                </p>
              ) : null}
              <pre className="max-h-48 overflow-auto rounded border border-border bg-background p-2 text-[10px] leading-relaxed text-foreground">
                {reindexPreview.index || "(empty index)"}
              </pre>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] italic text-muted-foreground/70">
                  This OVERWRITES index.md with the content above (regenerated
                  from ACTIVE entries).
                </p>
                <Button
                  variant="default"
                  size="xs"
                  disabled={isBusy}
                  onClick={onReindexWrite}
                >
                  {busy === "reindex-write" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  Write index.md
                </Button>
              </div>
            </div>
          ) : null}

          {/* Import disclosure: source path → preview plan → apply. */}
          {importOpen ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-2.5">
              <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                <Upload className="size-3" />
                import from a foreign vault
              </span>
              <p className="text-[10px] text-muted-foreground/70">
                Maps a foreign vault into the active scope&apos;s forge schema.
                Preview first; Apply writes NEW entries only — additive, it never
                overwrites.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  value={srcDir}
                  placeholder={DEFAULT_IMPORT_SRC}
                  spellCheck={false}
                  disabled={isBusy}
                  onChange={(e) => {
                    setSrcDir(e.target.value);
                    setImportPreview(null);
                  }}
                  className="text-[11px]"
                  aria-label="source vault path (absolute)"
                />
                <Button
                  variant="outline"
                  size="xs"
                  disabled={isBusy || !srcDir.trim()}
                  onClick={onImportPreview}
                >
                  {busy === "import-preview" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                  Preview
                </Button>
              </div>

              {importPreview ? (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                    <Badge
                      variant="outline"
                      className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-600 dark:text-emerald-400"
                    >
                      create {importPreview.plan?.create?.length ?? 0}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px]">
                      skip {importPreview.plan?.skipped?.length ?? 0}
                    </Badge>
                  </div>

                  {importPreview.plan?.create?.length ? (
                    <ul className="flex max-h-40 flex-col gap-1 overflow-auto">
                      {importPreview.plan.create.slice(0, 12).map((item, i) => {
                        const { to, from, meta } = importItemLabel(item);
                        return (
                          <li
                            key={`${to}:${i}`}
                            className="rounded border border-emerald-500/20 bg-emerald-500/5 px-2 py-1 text-[10px]"
                          >
                            <span className="break-all text-foreground">
                              {to}
                            </span>
                            {meta ? (
                              <span className="text-muted-foreground">
                                {" "}
                                · {meta}
                              </span>
                            ) : null}
                            {from ? (
                              <span className="block break-all text-muted-foreground/60">
                                ← {from}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                      {importPreview.plan.create.length > 12 ? (
                        <li className="px-2 text-[10px] italic text-muted-foreground/60">
                          … and {importPreview.plan.create.length - 12} more
                        </li>
                      ) : null}
                    </ul>
                  ) : (
                    <p className="text-[10px] italic text-muted-foreground/70">
                      nothing to create — every source note maps to an existing
                      entry (or none were found).
                    </p>
                  )}

                  {importPreview.plan?.create?.length ? (
                    <div className="flex items-center justify-between gap-2">
                      <p className="flex items-start gap-1.5 text-[10px] italic text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                        Apply WRITES {importPreview.plan.create.length} new entr
                        {importPreview.plan.create.length === 1 ? "y" : "ies"}{" "}
                        (additive — never overwrites existing files).
                      </p>
                      <Button
                        variant="default"
                        size="xs"
                        disabled={isBusy}
                        onClick={onImportApply}
                      >
                        {busy === "import-apply" ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Upload className="size-3" />
                        )}
                        Apply import
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Index drift — a single binary signal; show only when present. */}
        {analysis.indexOutOfSync ? (
          <Section
            icon={<FileX2 className="size-3 shrink-0" />}
            title="Index drift"
            count={1}
            emptyLabel="index in sync"
            defaultOpen
          >
            <Note>
              The generated index.md differs from the on-disk index — use
              “Regenerate index” above to bring them back in sync.
            </Note>
          </Section>
        ) : (
          <Section
            icon={<FileX2 className="size-3 shrink-0" />}
            title="Index drift"
            count={0}
            emptyLabel="index in sync"
            defaultOpen={false}
          >
            {null}
          </Section>
        )}

        {/* Unresolved (dangling) wiki-links — source → target. */}
        <Section
          icon={<Link2Off className="size-3 shrink-0" />}
          title="Unresolved links"
          count={analysis.unresolved.length}
          emptyLabel="no unresolved links"
          defaultOpen={analysis.unresolved.length > 0}
        >
          {analysis.unresolved.map((u, i) => (
            <Worklist
              key={`${u.source}::${u.target}::${i}`}
              title={`${name(u.source)} → ${u.target}`}
              path={pathOf(u.source)}
            >
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {name(u.source)}
              </span>
              <span className="shrink-0 text-muted-foreground/60">→</span>
              <span className="min-w-0 flex-1 truncate text-destructive">
                {u.target}
              </span>
            </Worklist>
          ))}
        </Section>

        {/* Duplicate candidates — a ↔ b + reason. */}
        <Section
          icon={<Copy className="size-3 shrink-0" />}
          title="Duplicate candidates"
          count={analysis.duplicates.length}
          emptyLabel="no duplicate candidates"
          defaultOpen={analysis.duplicates.length > 0}
        >
          {analysis.duplicates.map((d, i) => (
            <Worklist
              key={`${d.a}::${d.b}::${i}`}
              title={`${name(d.a)} ↔ ${name(d.b)} — ${d.reason}`}
              path={pathOf(d.a)}
              secondaryPath={pathOf(d.b)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <Swatch color={swatch(d.a)} />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {name(d.a)}
                </span>
                <span className="shrink-0 text-muted-foreground/60">↔</span>
                <Swatch color={swatch(d.b)} />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {name(d.b)}
                </span>
              </span>
              <span className="shrink-0 text-[9px] text-muted-foreground/70">
                {d.reason}
              </span>
            </Worklist>
          ))}
        </Section>

        {/* Low confidence — confidence < 0.4. */}
        <Section
          icon={<AlertTriangle className="size-3 shrink-0" />}
          title="Low confidence"
          count={analysis.lowConfidence.length}
          emptyLabel="no low-confidence entries"
          defaultOpen={analysis.lowConfidence.length > 0}
        >
          {analysis.lowConfidence.map((id) => (
            <SingleRow
              key={id}
              id={id}
              name={name(id)}
              color={swatch(id)}
              path={pathOf(id)}
            />
          ))}
        </Section>

        {/* Orphans — no resolved in/out links. */}
        <Section
          icon={<GitBranch className="size-3 shrink-0" />}
          title="Orphans"
          count={analysis.orphans.length}
          emptyLabel="no orphans"
          defaultOpen={analysis.orphans.length > 0}
        >
          {analysis.orphans.map((id) => (
            <SingleRow
              key={id}
              id={id}
              name={name(id)}
              color={swatch(id)}
              path={pathOf(id)}
            />
          ))}
        </Section>

        {/* Stale — old or missing `updated`. */}
        <Section
          icon={<Clock className="size-3 shrink-0" />}
          title="Stale"
          count={analysis.stale.length}
          emptyLabel="no stale entries"
          defaultOpen={analysis.stale.length > 0}
        >
          {analysis.stale.map((id) => (
            <SingleRow
              key={id}
              id={id}
              name={name(id)}
              color={swatch(id)}
              path={pathOf(id)}
            />
          ))}
        </Section>
      </div>
    </ScrollArea>
  );
}

/** Build the live vault file path for an entry (display only). */
function filePath(vaultDir: string, entry: MemoryEntry): string {
  const dir = vaultDir.replace(/\/+$/, "");
  return `${dir}/${entry.relPath}`;
}

/** A single-entry worklist row (low-confidence / orphans / stale share this). */
function SingleRow({
  name,
  color,
  path,
}: {
  id: string;
  name: string;
  color: string;
  path: string | null;
}) {
  return (
    <Worklist title={path ?? name} path={path}>
      <Swatch color={color} />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {name}
      </span>
    </Worklist>
  );
}

/**
 * One curation worklist row: the candidate content on the first line, the live
 * vault file path(s) beneath it (display only — NO link target, NO write). Not
 * a button: there is no action to take in this read-only version.
 */
function Worklist({
  title,
  path,
  secondaryPath,
  children,
}: {
  title?: string;
  path: string | null;
  secondaryPath?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div
      title={title}
      className="flex flex-col gap-0.5 rounded px-1.5 py-1 hover:bg-muted"
    >
      <div className="flex items-center gap-1.5">{children}</div>
      {path ? (
        <code className="truncate text-[9px] text-muted-foreground/50">
          {path}
        </code>
      ) : null}
      {secondaryPath ? (
        <code className="truncate text-[9px] text-muted-foreground/50">
          {secondaryPath}
        </code>
      ) : null}
    </div>
  );
}

/** A small type-color swatch dot. */
function Swatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ background: color }}
      aria-hidden
    />
  );
}

/** A short explanatory note inside a section body. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1.5 py-1 text-[10px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

interface SectionProps {
  icon: React.ReactNode;
  title: string;
  count: number;
  emptyLabel: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}

/** A collapsible, count-badged section with a scrollable body + empty state. */
function Section({
  icon,
  title,
  count,
  emptyLabel,
  defaultOpen,
  children,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
      >
        <Chevron className="size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="flex-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <Badge
          variant={count > 0 ? "destructive" : "outline"}
          className="text-[9px]"
        >
          {count}
        </Badge>
      </button>

      {open ? (
        <div className={cn("border-t border-border", count === 0 && "px-2 py-2")}>
          {count === 0 ? (
            <p className="text-[10px] text-muted-foreground">{emptyLabel}</p>
          ) : (
            <ScrollArea className="max-h-48">
              <div className="space-y-0.5 p-1 font-mono text-[11px]">
                {children}
              </div>
            </ScrollArea>
          )}
        </div>
      ) : null}
    </div>
  );
}
