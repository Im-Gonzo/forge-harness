/**
 * POST /api/rule-matches — READ-ONLY "which files would this rule scope?" preview.
 *
 * The Visual rule form (forms/rule.tsx) edits a rule's `paths:` glob list. To make
 * that scope tangible, this route globs the FORGE_ROOT tree for those globs and
 * returns the repo-relative files that match — a live "this rule applies to these
 * files" panel. It NEVER writes, spawns the CLI, or touches the registry; it only
 * walks the filesystem under FORGE_ROOT and matches in memory.
 *
 * Request:  { paths: string[] }   // the rule's globs (e.g. ["**\/*.ts", "rules/**"])
 * Response: {
 *   ok: true,
 *   patterns: string[],           // the globs actually evaluated (trimmed/deduped)
 *   matches: string[],            // repo-relative paths that matched (sorted, capped)
 *   total: number,                // matches BEFORE the cap (so the UI can say "+N more")
 *   truncated: boolean,           // total > matches.length
 *   scanned: number,              // files visited (for the "out of N" denominator)
 * }
 *
 * GLOB SEMANTICS (zero-dependency, mirrors the rule conventions in rules/**):
 *   **        any path segments (including none)            → "**\/*.ts" matches "a/b/c.ts" and "c.ts"
 *   *         any run of chars except the path separator
 *   ?         exactly one char except the path separator
 *   {a,b,c}   alternation
 *   [abc]     a character class (passed through to the RegExp)
 * Matching is done on POSIX-style (forward-slash) repo-relative paths.
 *
 * Empty / no globs ⇒ an EMPTY match set (an always-on rule with no `paths:` scopes
 * "everywhere", but a file list of the entire tree is noise — the form labels this
 * "always-on, no path scope"). Heavy/irrelevant dirs (node_modules, .git, the
 * generated .forge cache) are skipped so the walk is fast and the preview is signal.
 *
 * Server-only: it reads the filesystem under FORGE_ROOT (node:fs). The form fetches
 * it client-side; this route is the only path to the walk.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { FORGE_ROOT } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Dirs never worth walking for a rule-scope preview. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".forge",
  ".next",
  ".turbo",
]);

/** Hard cap on returned matches so a broad glob can't ship a giant payload. */
const MATCH_CAP = 500;
/** Hard cap on files visited so a pathological tree can't hang the request. */
const SCAN_CAP = 20000;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

// ──────────────────────────────────────────────────────────────────────────
// Zero-dependency glob → RegExp
// ──────────────────────────────────────────────────────────────────────────

/** Escape a literal char for use inside a RegExp. */
function escapeRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a single glob into an anchored RegExp over a forward-slash path.
 * Supports `**`, `*`, `?`, `{a,b}`, and `[...]` classes. Returns null for an
 * empty/whitespace glob (the caller skips it). Unsupported constructs degrade to
 * literal matching, which is safe (it just matches less, never throws).
 */
function globToRegExp(glob: string): RegExp | null {
  const g = glob.trim();
  if (g === "") return null;
  // Normalize to forward slashes and strip a leading "./".
  const pattern = g.replace(/\\/g, "/").replace(/^\.\//, "");

  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — any number of segments. Consume a following "/" so that
        // "**/*.ts" also matches a top-level "x.ts" (zero leading segments).
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        // `*` — any run of non-separator chars.
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      // `{a,b,c}` alternation — split on top-level commas.
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        re += "\\{";
      } else {
        const inner = pattern.slice(i + 1, close);
        const alts = inner.split(",").map((alt) =>
          alt
            .split("")
            .map((c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : escapeRe(c)))
            .join(""),
        );
        re += "(?:" + alts.join("|") + ")";
        i = close;
      }
    } else if (ch === "[") {
      // Character class — pass through to the close bracket verbatim.
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
      } else {
        re += pattern.slice(i, close + 1);
        i = close;
      }
    } else {
      re += escapeRe(ch);
    }
  }
  try {
    return new RegExp("^" + re + "$");
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Walk
// ──────────────────────────────────────────────────────────────────────────

interface WalkState {
  matchers: RegExp[];
  matches: string[];
  total: number;
  scanned: number;
}

/** True when any compiled glob matches the repo-relative POSIX path. */
function isMatch(relPosix: string, matchers: RegExp[]): boolean {
  for (const m of matchers) if (m.test(relPosix)) return true;
  return false;
}

/** Recursively walk `absDir`, collecting matches into `state` (caps respected). */
async function walk(
  absDir: string,
  relDir: string,
  state: WalkState,
): Promise<void> {
  if (state.scanned >= SCAN_CAP) return;

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (state.scanned >= SCAN_CAP) return;
    const name = entry.name;
    const childRelPosix = relDir ? `${relDir}/${name}` : name;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      await walk(path.join(absDir, name), childRelPosix, state);
      continue;
    }
    if (!entry.isFile()) continue;

    state.scanned++;
    if (isMatch(childRelPosix, state.matchers)) {
      state.total++;
      if (state.matches.length < MATCH_CAP) state.matches.push(childRelPosix);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const rawPaths =
    body && typeof body === "object" && "paths" in body
      ? (body as { paths?: unknown }).paths
      : undefined;

  if (!Array.isArray(rawPaths)) {
    return bad("Body must be { paths: string[] }.");
  }

  // Trim, drop empties, dedupe — preserving first-seen order.
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const p of rawPaths) {
    if (typeof p !== "string") continue;
    const t = p.trim();
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    patterns.push(t);
  }

  // No globs ⇒ empty match set (an always-on rule isn't a file list — the form
  // labels this case rather than dumping the whole tree).
  if (patterns.length === 0) {
    return Response.json(
      {
        ok: true,
        patterns: [],
        matches: [],
        total: 0,
        truncated: false,
        scanned: 0,
      },
      { status: 200 },
    );
  }

  const matchers = patterns
    .map(globToRegExp)
    .filter((m): m is RegExp => m !== null);

  const state: WalkState = { matchers, matches: [], total: 0, scanned: 0 };
  await walk(FORGE_ROOT, "", state);

  state.matches.sort((a, b) => a.localeCompare(b));

  return Response.json(
    {
      ok: true,
      patterns,
      matches: state.matches,
      total: state.total,
      truncated: state.total > state.matches.length,
      scanned: state.scanned,
    },
    { status: 200 },
  );
}
