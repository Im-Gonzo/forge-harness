/**
 * forge-bridge/memory-vault — the MEMORY VAULT read surface.
 *
 * ADDITIVE to the bridge: a read-only view over a flat directory of `*.md`
 * memory entries plus an `MEMORY.md` index, WITHOUT changing any existing
 * export. This is the /memory route's only on-disk touch-point.
 *
 * VAULT SHAPE (the LIVE vault, "location 3" — Claude Code's per-project
 * auto-memory dir): a flat dir of `*.md` entries + an `MEMORY.md` index file.
 * Live entry frontmatter is:
 *   { name, description, metadata?: { node_type, type, originSessionId } }
 * NOTE the live entries carry NO `confidence` and NO decision/gotcha/runbook
 * `type` taxonomy — `type` here is a coarse domain tag (e.g. "project").
 *
 * Entry bodies cross-link with Obsidian-style `[[wiki-link]]` slugs whose
 * target is another entry's `name` slug (== its filename without `.md`).
 * `MEMORY.md` indexes entries with MARKDOWN links `[label](file.md)`.
 *
 * Parsing is DEFENSIVE so the SAME reader also works for the richer forge
 * memory schema when present (title / type taxonomy / numeric confidence /
 * status / updated). Anything absent resolves to null — never throws.
 *
 * Fail-soft throughout: a missing vault dir yields an empty vault; an
 * unreadable / malformed entry file is skipped; bad frontmatter degrades to
 * defaults. The whole read NEVER throws.
 *
 * NOTE: server-only module (node:fs). Import from server components and route
 * handlers only — never from a "use client" boundary.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import matter from "gray-matter";

import { memoryList } from "./memory-project";

/**
 * Default vault directory. The LIVE vault is Claude Code's per-project
 * auto-memory dir at `~/.claude/projects/<project-path-slug>/memory`, where the
 * slug encodes the directory Claude Code runs in — which is environment-specific
 * and NOT derivable from this web app's location. So point MEMORY_VAULT_DIR at
 * your real vault (e.g. in `web/.env.local`, which is gitignored) to use the
 * live-import feature; the home-based fallback below simply doesn't exist on most
 * machines, and the reader fails soft to an EMPTY vault when the dir is missing.
 * It can also be set per-call via readMemoryVault(vaultDir).
 */
export const DEFAULT_MEMORY_VAULT_DIR =
  process.env.MEMORY_VAULT_DIR ??
  path.join(os.homedir(), ".claude", "memory-vault");

/** Index filenames that are NOT entries (case-insensitive). */
const INDEX_FILES = new Set(["memory.md", "index.md"]);

/**
 * One memory entry — a single `*.md` file in the vault.
 *
 * Live vaults populate { id, title, description, type, relPath, body } and
 * leave the forge-only fields (confidence / status / updated) null. Readers
 * must tolerate any field being null/absent — the vault is lossy-by-design.
 */
export interface MemoryEntry {
  /** Filename without `.md` — the stable id and wiki-link target slug. */
  id: string;
  /** frontmatter.name ?? frontmatter.title ?? id. */
  title: string;
  /** frontmatter.description (trimmed) or "". */
  description: string;
  /** frontmatter.type ?? frontmatter.metadata?.type ?? null. */
  type: string | null;
  /** Numeric frontmatter.confidence, else null (live entries have none). */
  confidence: number | null;
  /** frontmatter.status ?? null. */
  status: string | null;
  /** frontmatter.updated ?? null (raw — not parsed to a Date). */
  updated: string | null;
  /** Path relative to the vault dir (the filename for a flat vault). */
  relPath: string;
  /** Raw markdown body (frontmatter stripped). */
  body: string;
}

/**
 * One directed cross-link extracted from an entry body's `[[target]]`.
 *
 * `target` is the resolved entry id when the wiki-link points at a known
 * entry, otherwise the raw (sanitized) target text. `resolved` distinguishes
 * the two so the UI can render dangling links differently.
 */
export interface MemoryLink {
  /** id of the entry whose body contains the link. */
  source: string;
  /** Resolved entry id, or the raw target text when unresolved. */
  target: string;
  /** true iff `target` is a known entry id. */
  resolved: boolean;
}

/**
 * The whole vault read in one shot.
 *
 * `indexed` is the set of entry ids that the `MEMORY.md` index references via
 * markdown links — informational (an entry can exist on disk yet be absent
 * from the index, or vice-versa). `indexExists` reports whether `MEMORY.md`
 * (or `index.md`) was found at all.
 */
export interface MemoryVault {
  /** Absolute path of the vault dir that was read. */
  vaultDir: string;
  /** Every `*.md` entry (excluding the index), sorted by id. */
  entries: MemoryEntry[];
  /** Every `[[wiki-link]]` extracted from entry bodies. */
  links: MemoryLink[];
  /** Entry ids referenced by markdown links inside the index file. */
  indexed: string[];
  /** true iff an `MEMORY.md` / `index.md` index file exists. */
  indexExists: boolean;
  /**
   * Raw on-disk index body (frontmatter stripped) when an index file exists,
   * else null. Additive/optional — lets analyzeCuration detect index drift
   * against the generated index without a second disk read.
   */
  indexBody: string | null;
}

/** Slug-normalize a name/filename for tolerant matching. */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

/** Coerce an unknown frontmatter value to a trimmed string, else null. */
function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/** Coerce an unknown frontmatter value to a finite number, else null. */
function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Read `metadata` as a record when present, else an empty record. */
function asMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Strip fenced (``` / ~~~) and inline (`code`) code spans from a body so
 * wiki-links that only appear inside code samples are NOT counted as real
 * cross-links. Replaces them with whitespace of comparable length to keep the
 * surrounding text intact.
 */
function stripCode(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/**
 * Extract `[[target]]` wiki-link targets from a body. Handles `[[target|alias]]`
 * (alias dropped) and `[[target#anchor]]` (anchor dropped). Returns the raw
 * (trimmed) target text for each occurrence, in document order — duplicates
 * are de-duped per source so an entry linked twice yields one edge.
 */
function extractWikiTargets(body: string): string[] {
  const clean = stripCode(body);
  const re = /\[\[([^\]]+?)\]\]/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(clean)) !== null) {
    // Drop `|alias` then `#anchor`, then trim.
    const raw = match[1].split("|")[0].split("#")[0].trim();
    if (raw.length === 0) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/**
 * Extract markdown-link targets `[label](target.md)` from the index body and
 * map each to an entry id via the same id/slug resolution as wiki-links.
 * Returns the set of resolved entry ids (unresolved index links are dropped —
 * the index is informational).
 */
function extractIndexedIds(
  indexBody: string,
  byId: Map<string, string>,
  bySlug: Map<string, string>,
): string[] {
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  const out = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(indexBody)) !== null) {
    const href = match[1].trim();
    // Ignore external links / anchors; keep local `.md` targets.
    if (/^[a-z]+:\/\//i.test(href) || href.startsWith("#")) continue;
    const resolved = resolveTarget(href, byId, bySlug);
    if (resolved) out.add(resolved);
  }
  return [...out];
}

/**
 * Resolve a link target (a wiki slug or a markdown href) to a known entry id.
 * Tries, in order: exact id, basename-without-ext id, exact slug, basename
 * slug. Returns the entry id or null when nothing matches.
 */
function resolveTarget(
  target: string,
  byId: Map<string, string>,
  bySlug: Map<string, string>,
): string | null {
  // Normalize a possible path/href down to its bare name.
  const bare = target.replace(/\.md$/i, "");
  const base = bare.split("/").pop() ?? bare;

  if (byId.has(bare)) return byId.get(bare)!;
  if (byId.has(base)) return byId.get(base)!;

  const slug = slugify(bare);
  if (bySlug.has(slug)) return bySlug.get(slug)!;
  const baseSlug = slugify(base);
  if (bySlug.has(baseSlug)) return bySlug.get(baseSlug)!;

  return null;
}

/**
 * Read + parse the whole memory vault, FAIL-SOFT.
 *
 * @param vaultDir absolute vault path; defaults to MEMORY_VAULT_DIR or the
 *   built-in per-project memory dir. A missing dir yields an empty vault.
 *
 * Steps: list `*.md` (excluding MEMORY.md / index.md) → parse each entry's
 * frontmatter + body defensively → build id/slug lookup maps → extract and
 * resolve `[[wiki-link]]` edges → read the index for `indexed` ids. Any single
 * unreadable/malformed file is skipped; the read never throws.
 */
export async function readMemoryVault(vaultDir?: string): Promise<MemoryVault> {
  const dir = vaultDir ?? DEFAULT_MEMORY_VAULT_DIR;

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Missing / unreadable dir → empty vault (never throw).
    return {
      vaultDir: dir,
      entries: [],
      links: [],
      indexed: [],
      indexExists: false,
      indexBody: null,
    };
  }

  const mdFiles = dirents
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".md"))
    .map((d) => d.name);

  const indexExists = mdFiles.some((name) =>
    INDEX_FILES.has(name.toLowerCase()),
  );

  // ── Pass 1: parse every entry file (skip index files). ──────────────────
  const entries: MemoryEntry[] = [];
  const bodyById = new Map<string, string>();
  for (const name of mdFiles) {
    if (INDEX_FILES.has(name.toLowerCase())) continue;

    const abs = path.join(dir, name);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch {
      continue; // unreadable file → skip
    }

    let fm: Record<string, unknown> = {};
    let body = raw;
    try {
      const parsed = matter(raw);
      fm = (parsed.data as Record<string, unknown>) ?? {};
      body = parsed.content;
    } catch {
      // Malformed frontmatter → treat the whole file as body, defaults below.
      fm = {};
      body = raw;
    }

    const id = name.replace(/\.md$/i, "");
    const metadata = asMetadata(fm.metadata);
    const title = asString(fm.name) ?? asString(fm.title) ?? id;
    const type = asString(fm.type) ?? asString(metadata.type);

    entries.push({
      id,
      title,
      description: asString(fm.description) ?? "",
      type,
      confidence: asNumber(fm.confidence),
      status: asString(fm.status),
      updated: asString(fm.updated),
      relPath: name,
      body,
    });
    bodyById.set(id, body);
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  // ── Lookup maps for tolerant link resolution. ──────────────────────────
  const byId = new Map<string, string>();
  const bySlug = new Map<string, string>();
  for (const entry of entries) {
    byId.set(entry.id, entry.id);
    bySlug.set(slugify(entry.id), entry.id);
    // Also index by the entry's `name`/title slug so wiki-links targeting a
    // human name (not the filename) still resolve.
    const titleSlug = slugify(entry.title);
    if (!bySlug.has(titleSlug)) bySlug.set(titleSlug, entry.id);
  }

  // ── Pass 2: extract + resolve wiki-link edges. ─────────────────────────
  const links: MemoryLink[] = [];
  for (const entry of entries) {
    const targets = extractWikiTargets(bodyById.get(entry.id) ?? "");
    for (const rawTarget of targets) {
      const resolvedId = resolveTarget(rawTarget, byId, bySlug);
      links.push({
        source: entry.id,
        target: resolvedId ?? rawTarget,
        resolved: resolvedId !== null,
      });
    }
  }

  // ── Index: which entries does MEMORY.md reference? (informational) ──────
  let indexed: string[] = [];
  let indexBody: string | null = null;
  if (indexExists) {
    const indexName = mdFiles.find((name) =>
      INDEX_FILES.has(name.toLowerCase()),
    );
    if (indexName) {
      try {
        const raw = await fs.readFile(path.join(dir, indexName), "utf8");
        let body = raw;
        try {
          body = matter(raw).content;
        } catch {
          body = raw;
        }
        indexBody = body;
        indexed = extractIndexedIds(body, byId, bySlug);
      } catch {
        indexed = [];
        indexBody = null;
      }
    }
  }

  return { vaultDir: dir, entries, links, indexed, indexExists, indexBody };
}

// ──────────────────────────────────────────────────────────────────────────
// Read-only analysis surface (PURE) — what a generator / curator WOULD do.
//
// Both functions are deterministic, side-effect-free, and NEVER write. They
// describe the canonical index.md and surface curation candidates so the UI can
// PREVIEW them — the actual write-target vault is an unresolved decision, so v1
// is preview-only.
// ──────────────────────────────────────────────────────────────────────────

/** Group key for typeless entries in the generated index. */
const UNCATEGORIZED_GROUP = "Uncategorized";

/** Staleness threshold: an entry untouched longer than this is "stale". */
const STALE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Confidence below this (when set at all) flags an entry as low-confidence. */
const LOW_CONFIDENCE = 0.4;

/** Title-similarity (Dice coefficient) at/above this flags a likely duplicate. */
const TITLE_SIMILARITY = 0.6;

/** An entry is "active" when it carries no status (status === null) or "active". */
function isActive(entry: MemoryEntry): boolean {
  return entry.status === null || entry.status.toLowerCase() === "active";
}

/**
 * First-sentence "hook" from a description: trim, take up to the first
 * sentence-ending `.`/`!`/`?` (or the first newline), collapse inner
 * whitespace. Returns "" when the description is empty.
 */
function hookFromDescription(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "";
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : flat).trim();
}

/**
 * The index.md content the (not-yet-built) generator WOULD produce — PURE.
 *
 * Active entries only (status === null treated as active), grouped by `type`
 * (typeless entries land in an "Uncategorized" group that always sorts last),
 * id-ordered within each group. One line per entry:
 *   `- <id> — <title> — <hook>`  (the `— <hook>` tail is dropped when empty).
 * Groups are rendered under a `## <Type>` heading, type names sorted
 * alphabetically (case-insensitive). Read-only: derives a string, writes
 * nothing.
 */
export function generateIndexMarkdown(vault: MemoryVault): string {
  const active = vault.entries.filter(isActive);

  // Bucket by type (typeless → Uncategorized).
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of active) {
    const key = entry.type ?? UNCATEGORIZED_GROUP;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(entry);
  }

  // Type headings sorted alphabetically; Uncategorized always last.
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

/** A pair of entries that look like duplicates, with a human-readable reason. */
export interface CurationDuplicate {
  /** id of the first entry in the pair. */
  a: string;
  /** id of the second entry in the pair. */
  b: string;
  /** Why the pair was flagged (overlapping links/type or similar titles). */
  reason: string;
}

/** A read-only curation report — all references are entry ids (or link ends). */
export interface CurationAnalysis {
  /** Likely duplicate pairs (shared links/type or high title similarity). */
  duplicates: CurationDuplicate[];
  /** Entry ids updated >~90d ago or missing an `updated` date. */
  stale: string[];
  /** Entry ids with a numeric confidence < 0.4. */
  lowConfidence: string[];
  /** Entry ids with zero in AND zero out resolved links. */
  orphans: string[];
  /** Unresolved (dangling) wiki-links: {source, target} as-found. */
  unresolved: { source: string; target: string }[];
  /** true iff the generated index.md differs from the on-disk index. */
  indexOutOfSync: boolean;
}

/** Tokenize a title into a lower-cased word set for similarity scoring. */
function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

/** Sørensen–Dice coefficient over two token sets (0..1). */
function diceSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return (2 * inter) / (a.size + b.size);
}

/** Parse an `updated` string to epoch ms, or null when absent/unparseable. */
function updatedMs(updated: string | null): number | null {
  if (!updated) return null;
  const t = Date.parse(updated);
  return Number.isNaN(t) ? null : t;
}

/**
 * Surface curation candidates over a vault — PURE, READ-ONLY.
 *
 * Detects (all by entry id, never mutating):
 *  - duplicates: entry pairs that share ≥1 resolved link neighbor + the same
 *    type, OR whose titles are ≥0.6 similar (Dice over word tokens).
 *  - stale: entries updated more than ~90d ago, or with no `updated` date.
 *  - lowConfidence: entries whose confidence is set and < 0.4.
 *  - orphans: entries with no resolved in- AND no resolved out-links.
 *  - unresolved: every dangling wiki-link {source, target}.
 *  - indexOutOfSync: generateIndexMarkdown(vault) ≠ the on-disk index
 *    (only when an index file exists; false otherwise — nothing to compare).
 *
 * @param vault the vault read by readMemoryVault.
 * @param diskIndex the on-disk index.md/MEMORY.md contents for the
 *   indexOutOfSync compare. Defaults to `vault.indexBody` (captured by
 *   readMemoryVault), so the single-arg `analyzeCuration(vault)` call detects
 *   drift on its own. Pass null to force the compare off.
 */
export function analyzeCuration(
  vault: MemoryVault,
  diskIndex: string | null | undefined = vault.indexBody,
): CurationAnalysis {
  const { entries, links } = vault;

  // ── Resolved neighbor sets (both directions) per entry id. ───────────────
  const neighbors = new Map<string, Set<string>>();
  const hasOut = new Set<string>();
  const hasIn = new Set<string>();
  for (const e of entries) neighbors.set(e.id, new Set());
  for (const l of links) {
    if (!l.resolved) continue;
    hasOut.add(l.source);
    hasIn.add(l.target);
    neighbors.get(l.source)?.add(l.target);
    neighbors.get(l.target)?.add(l.source);
  }

  // ── Duplicates: pairwise scan (vault is small; O(n²) is fine). ───────────
  const tokensById = new Map(entries.map((e) => [e.id, titleTokens(e.title)]));
  const duplicates: CurationDuplicate[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];

      // Shared resolved neighbors (excluding each other).
      const na = neighbors.get(a.id)!;
      const nb = neighbors.get(b.id)!;
      const shared: string[] = [];
      for (const t of na) if (t !== b.id && nb.has(t)) shared.push(t);

      const sameType = a.type !== null && a.type === b.type;
      const sim = diceSimilarity(tokensById.get(a.id)!, tokensById.get(b.id)!);

      const reasons: string[] = [];
      if (shared.length > 0 && sameType) {
        reasons.push(
          `shared ${shared.length} link${shared.length === 1 ? "" : "s"} + same type "${a.type}"`,
        );
      } else if (shared.length > 0) {
        reasons.push(
          `shared ${shared.length} link${shared.length === 1 ? "" : "s"}`,
        );
      }
      if (sim >= TITLE_SIMILARITY) {
        reasons.push(`titles ${(sim * 100).toFixed(0)}% similar`);
      }
      if (reasons.length > 0) {
        duplicates.push({ a: a.id, b: b.id, reason: reasons.join("; ") });
      }
    }
  }

  // ── Stale: old or missing `updated`. ─────────────────────────────────────
  const now = Date.now();
  const stale = entries
    .filter((e) => {
      const ms = updatedMs(e.updated);
      return ms === null || now - ms > STALE_AGE_MS;
    })
    .map((e) => e.id);

  // ── Low confidence: set AND below threshold. ─────────────────────────────
  const lowConfidence = entries
    .filter((e) => e.confidence !== null && e.confidence < LOW_CONFIDENCE)
    .map((e) => e.id);

  // ── Orphans: no resolved in AND no resolved out. ─────────────────────────
  const orphans = entries
    .filter((e) => !hasIn.has(e.id) && !hasOut.has(e.id))
    .map((e) => e.id);

  // ── Unresolved (dangling) wiki-links. ────────────────────────────────────
  const unresolved = links
    .filter((l) => !l.resolved)
    .map((l) => ({ source: l.source, target: l.target }));

  // ── Index drift: only meaningful when an index exists AND we have its text.
  const indexOutOfSync =
    vault.indexExists && diskIndex != null
      ? generateIndexMarkdown(vault).trim() !== diskIndex.trim()
      : false;

  return {
    duplicates,
    stale,
    lowConfidence,
    orphans,
    unresolved,
    indexOutOfSync,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// PROJECT-SCOPED vault read — the SELECTED PROJECT's `forge` memory.
//
// THE SCOPE FIX (#6): the global `readMemoryVault()` above reads a FLAT
// `~/.claude/memory-vault` straight off disk and is NOT scoped to the active
// harness. The project plane must instead show the SELECTED PROJECT's memory.
// `memoryList()` (memory-project.ts) runs `forge memory list` with cwd = the
// ACTIVE root (getActiveRoot — the selected project's `.claude`), so it is the
// authoritative, correctly-scoped enumeration. It also correctly walks NESTED
// entry dirs (decisions/, gotchas/, …) that the flat reader above would miss.
//
// We adapt that CLI enumeration into the SAME `MemoryVault` shape the existing
// /memory UI (graph / vault / curate) already consumes, then enrich each entry
// from disk (`memDir` + `rel`) for the body + `updated` + cross-links. Cross-
// links come from BOTH the forge frontmatter `links.vault` array AND any body
// `[[wiki-link]]`, resolved against the enumerated ids/titles. Fail-soft at
// every level: a CLI failure or any unreadable entry degrades to fewer
// entries / fewer links, never throws.
// ──────────────────────────────────────────────────────────────────────────

/** Extract forge-frontmatter `links.vault[]` targets (string entries only). */
function frontmatterVaultLinks(fm: Record<string, unknown>): string[] {
  const links = fm.links;
  if (!links || typeof links !== "object" || Array.isArray(links)) return [];
  const vault = (links as Record<string, unknown>).vault;
  if (!Array.isArray(vault)) return [];
  const out: string[] = [];
  for (const v of vault) {
    const s = asString(v);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Read the SELECTED PROJECT's `forge` memory vault as a `MemoryVault`,
 * FAIL-SOFT. Scoped to the active harness root via `memoryList()` (the CLI runs
 * with cwd = getActiveRoot). A missing vault / failed CLI run yields an empty
 * vault, never throws.
 *
 * Steps: enumerate entries via the (scoped) CLI → enrich each from disk for the
 * body + `updated` + frontmatter `links.vault` → build id/slug lookup maps →
 * resolve cross-link edges (frontmatter `links.vault` + body `[[wiki-link]]`) →
 * read `index.md` for the `indexed` ids. The CLI `memDir` is the vault root we
 * report and resolve `rel` paths against.
 */
export async function readProjectMemoryVault(): Promise<MemoryVault> {
  const envelope = await memoryList();
  const data = envelope.ok ? envelope.data : null;
  const memDir = data?.memDir ?? null;
  const rows = data?.entries ?? [];

  // No vault resolved (CLI found none, or the run failed) → empty vault. We
  // still report a sensible vaultDir for the UI's empty-state caption.
  if (!memDir || rows.length === 0) {
    return {
      vaultDir: memDir ?? "(no project memory vault)",
      entries: [],
      links: [],
      indexed: [],
      indexExists: false,
      indexBody: null,
    };
  }

  // ── Enrich each enumerated entry from disk (body + updated + fm links). ───
  const entries: MemoryEntry[] = [];
  const bodyById = new Map<string, string>();
  const fmLinksById = new Map<string, string[]>();
  for (const row of rows) {
    const abs = path.join(memDir, row.rel);
    let body = "";
    let updated: string | null = null;
    let fmLinks: string[] = [];
    let descr = "";
    try {
      const raw = await fs.readFile(abs, "utf8");
      try {
        const parsed = matter(raw);
        const fm = (parsed.data as Record<string, unknown>) ?? {};
        body = parsed.content;
        updated = asString(fm.updated);
        descr = asString(fm.description) ?? "";
        fmLinks = frontmatterVaultLinks(fm);
      } catch {
        body = raw;
      }
    } catch {
      // Unreadable entry file → keep the CLI-enumerated metadata, no body.
    }

    // Prefer the CLI id; fall back to the file stem. The CLI gives "" for a
    // non-entry file (e.g. the schema example) — use the stem so it still has a
    // stable graph node id.
    const id = row.id || path.basename(row.rel).replace(/\.md$/i, "");
    entries.push({
      id,
      title: row.title || id,
      description: descr,
      type: row.type || null,
      confidence: row.confidence,
      status: row.status || null,
      updated,
      relPath: row.rel,
      body,
    });
    bodyById.set(id, body);
    fmLinksById.set(id, fmLinks);
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));

  // ── Lookup maps for tolerant link resolution. ──────────────────────────
  const byId = new Map<string, string>();
  const bySlug = new Map<string, string>();
  for (const entry of entries) {
    byId.set(entry.id, entry.id);
    bySlug.set(slugify(entry.id), entry.id);
    const titleSlug = slugify(entry.title);
    if (!bySlug.has(titleSlug)) bySlug.set(titleSlug, entry.id);
  }

  // ── Resolve cross-link edges: frontmatter links.vault[] + body wiki-links. ─
  const links: MemoryLink[] = [];
  for (const entry of entries) {
    const seen = new Set<string>();
    const targets = [
      ...(fmLinksById.get(entry.id) ?? []),
      ...extractWikiTargets(bodyById.get(entry.id) ?? ""),
    ];
    for (const rawTarget of targets) {
      const resolvedId = resolveTarget(rawTarget, byId, bySlug);
      const key = (resolvedId ?? rawTarget).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        source: entry.id,
        target: resolvedId ?? rawTarget,
        resolved: resolvedId !== null,
      });
    }
  }

  // ── Index: which entries does index.md / MEMORY.md reference? ──────────
  let indexed: string[] = [];
  let indexBody: string | null = null;
  let indexExists = false;
  for (const name of ["index.md", "MEMORY.md", "memory.md"]) {
    const abs = path.join(memDir, name);
    let raw: string;
    try {
      raw = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    indexExists = true;
    let body = raw;
    try {
      body = matter(raw).content;
    } catch {
      body = raw;
    }
    indexBody = body;
    // forge index lines reference entries as a bracketed path `[<type>/<id>-…md]`
    // rather than a `[label](href)` markdown link, so resolve BOTH forms.
    indexed = extractForgeIndexedIds(body, byId, bySlug);
    break;
  }

  return { vaultDir: memDir, entries, links, indexed, indexExists, indexBody };
}

/**
 * Resolve entry ids referenced by a forge `index.md` body. Handles BOTH the
 * markdown-link form `[label](path.md)` AND the forge bracketed-path form
 * `… [decisions/d-0001-….md]` (a `[path]` with no following `(href)`). Returns
 * the resolved entry-id set; unresolved references are dropped (informational).
 */
function extractForgeIndexedIds(
  indexBody: string,
  byId: Map<string, string>,
  bySlug: Map<string, string>,
): string[] {
  const out = new Set<string>(extractIndexedIds(indexBody, byId, bySlug));
  // Bracketed bare paths: `[something/with-a-slash.md]` NOT followed by `(`.
  const re = /\[([^\]]+?\.md)\](?!\()/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(indexBody)) !== null) {
    const resolved = resolveTarget(match[1].trim(), byId, bySlug);
    if (resolved) out.add(resolved);
  }
  return [...out];
}
