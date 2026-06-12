/**
 * resource-editor/serialize — CLIENT-side, byte-faithful projection between the
 * draft `{ frontmatter, body }` and the full file TEXT.
 *
 * The draft → text direction reuses the SAME pure core the bridge writes with
 * (forge-bridge/frontmatter-edit-core.mjs) so the text the Raw tab shows and the
 * additive-write DIFF the Preview tab renders are byte-identical to what the
 * server will persist — minimal-diff on update, clean serialize on create, body
 * preserved verbatim, frontmatter key order preserved.
 *
 * The text → draft direction (parsing edited Raw text back into a frontmatter
 * object) is handled here by a small SELF-CONTAINED parser that covers exactly
 * the shapes the writer covers: top-level scalars (string/number/bool/null),
 * inline flow arrays `[a, b]`, and block arrays (`- item`). This deliberately
 * mirrors the writer (no external YAML dep, no node), so the round-trip stays
 * symmetric. The body is the verbatim remainder — never reparsed.
 *
 * Pure module — safe in a "use client" boundary (no node, no IO, no deps).
 */
import {
  serializeDocument,
  updateDocument,
  splitDocument,
  frontmatterMinimalEditable,
} from "@/lib/forge-bridge/frontmatter-edit-core.mjs";

import type { ResourceKind } from "@/lib/types";

import type { ResourceDraft } from "./types";

/**
 * Render the draft to the full file text, byte-faithful to the bridge:
 *  - create (no `original`): clean `serializeDocument`.
 *  - update (an `original` file exists and is minimal-diff-editable): splice only
 *    changed frontmatter lines via `updateDocument`, body preserved verbatim.
 *  - nested/non-editable frontmatter: clean serialize (rare; e.g. bundles — the
 *    server falls back to a whole-frontmatter rewrite there anyway).
 */
export function draftToText(
  draft: ResourceDraft,
  original?: string,
  kind?: ResourceKind,
): string {
  // mcp resources are RAW JSON config files: the body IS the file (no
  // frontmatter), so the projection is the identity of draft.body.
  if (kind === "mcp") {
    return draft.body;
  }
  if (
    original &&
    (splitDocument(original) as { hasFrontmatter: boolean }).hasFrontmatter &&
    frontmatterMinimalEditable(draft.frontmatter)
  ) {
    return updateDocument(original, draft.frontmatter, draft.body) as string;
  }
  return serializeDocument(draft.frontmatter, draft.body) as string;
}

// ──────────────────────────────────────────────────────────────────────────
// text → draft (self-contained scalar / scalar-array YAML reader)
// ──────────────────────────────────────────────────────────────────────────

type Scalar = string | number | boolean | null;

/** Coerce a YAML scalar token to a JS value (string/number/bool/null). */
function parseScalar(tokenRaw: string): Scalar {
  const token = tokenRaw.trim();
  if (token === "" || token === "~" || token.toLowerCase() === "null") {
    return token === "" ? "" : null;
  }
  // Quoted strings keep their content verbatim (with basic escape handling).
  if (token.length >= 2 && token[0] === '"' && token.endsWith('"')) {
    return token
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (token.length >= 2 && token[0] === "'" && token.endsWith("'")) {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(true|false)$/i.test(token)) return token.toLowerCase() === "true";
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(token)) {
    return Number(token);
  }
  return token;
}

/** Split an inline flow array body (`a, "b", c`) into scalar tokens. */
function splitInlineArray(inner: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      buf += ch;
      if (ch === quote && inner[i - 1] !== "\\") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
    } else if (ch === ",") {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out.map((s) => s.trim());
}

/**
 * Parse the raw frontmatter TEXT into an object of top-level keys. Handles
 * scalars, inline arrays, and block arrays — the exact shapes the writer emits.
 * Anything richer is preserved as its raw string value (lossy, but the affected
 * kinds use the Raw tab's whole-frontmatter rewrite path anyway).
 */
function parseFrontmatter(fm: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = fm.split(/\r?\n/);
  const keyLineRe = /^([A-Za-z0-9_$][\w$.-]*|"[^"]*"|'[^']*'):(?:[ \t]+(.*))?$/;
  let currentBlockKey: string | null = null;

  // Track which keys opened as a (possibly empty) block head, so a head with no
  // following `- item` lines resolves to an empty scalar, not a spurious [].
  const blockHeads = new Set<string>();

  for (const line of lines) {
    const blockItem = /^[ \t]*-[ \t]+(.*)$/.exec(line);
    if (blockItem && currentBlockKey) {
      (out[currentBlockKey] as Scalar[]).push(parseScalar(blockItem[1]));
      continue;
    }
    const m = keyLineRe.exec(line);
    if (!m) continue;
    const key = m[1].replace(/^["']|["']$/g, "");
    const valueText = (m[2] ?? "").trim();

    if (valueText === "") {
      // Either an empty scalar or the head of a block array — start a block and
      // remember it; resolved after the loop.
      out[key] = [] as Scalar[];
      currentBlockKey = key;
      blockHeads.add(key);
      continue;
    }
    currentBlockKey = null;
    if (valueText.startsWith("[") && valueText.endsWith("]")) {
      const inner = valueText.slice(1, -1).trim();
      out[key] = inner === "" ? [] : splitInlineArray(inner).map(parseScalar);
    } else {
      out[key] = parseScalar(valueText);
    }
  }

  // A block head that never received a `- item` line is an empty scalar value.
  for (const key of blockHeads) {
    if (Array.isArray(out[key]) && (out[key] as Scalar[]).length === 0) {
      out[key] = "";
    }
  }

  return out;
}

/**
 * Parse full file TEXT back into a draft. Frontmatter is parsed by the reader
 * above; the body is the verbatim remainder (the bytes after the closing
 * delimiter, exactly as `splitDocument` carved them).
 */
export function textToDraft(text: string, kind?: ResourceKind): ResourceDraft {
  // mcp resources are RAW JSON: the whole text IS the body; frontmatter is
  // always empty (no gray-matter, so JSON round-trips with no mangling).
  if (kind === "mcp") {
    return { frontmatter: {}, body: text };
  }
  const doc = splitDocument(text) as {
    hasFrontmatter: boolean;
    fm: string;
    body: string;
  };
  if (!doc.hasFrontmatter) {
    return { frontmatter: {}, body: text };
  }
  return { frontmatter: parseFrontmatter(doc.fm), body: doc.body };
}
