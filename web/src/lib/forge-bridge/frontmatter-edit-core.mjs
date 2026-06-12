/**
 * frontmatter-edit-core — PURE, framework-free minimal-diff editing of a
 * gray-matter document's YAML frontmatter.
 *
 * Mirrors graph-edit-core.mjs: it carries NO Next/React/fs dependency so the
 * verification scripts exercise the EXACT bytes the bridge writes. The bridge
 * (crud.ts) adds the FORGE_ROOT IO + the validate → registry-build cycle on top.
 *
 * Why not gray-matter's `matter.stringify`? It reflows the whole document —
 * folds long scalars onto `>-` continuation lines, expands inline `[a, b]`
 * arrays to block style, and re-quotes values. That is a massive, noisy diff.
 * The CRITICAL contract (AGENTS.md) is the opposite: an edit must touch ONLY the
 * lines whose values actually changed, preserve frontmatter KEY ORDER, and
 * preserve the BODY verbatim. So updates here operate on the raw frontmatter
 * TEXT line-by-line; only `create` (a brand-new file) serializes from scratch.
 *
 * Scope of YAML handled (sufficient for the forge resource frontmatters):
 *   - scalar values: string / number / boolean / null
 *   - inline flow arrays of scalars: `[Read, Grep]` or `["Read", "Grep"]`
 *   - block (one-item-per-line `- x`) arrays of scalars
 * Anything richer (nested maps, arrays of maps such as a bundle's `adrs:`) is
 * NOT minimal-diff-editable here and the caller is told so (see
 * `frontmatterEditable`) — those kinds fall back to a whole-frontmatter rewrite
 * that the caller opts into explicitly.
 */

// ──────────────────────────────────────────────────────────────────────────
// Document split (delimiter-preserving)
// ──────────────────────────────────────────────────────────────────────────

const DELIM = /^---[ \t]*\r?\n/;

/**
 * Split a gray-matter document into its three byte-exact regions:
 *   { hasFrontmatter, open, fm, close, body }
 * where `open` is the leading `---\n`, `fm` is the raw frontmatter text
 * (between the delimiters, INCLUDING its trailing newline), `close` is the
 * closing `---\n`, and `body` is everything after — all concatenated back
 * reproduces the original file byte-for-byte.
 */
export function splitDocument(raw) {
  if (!DELIM.test(raw)) {
    return { hasFrontmatter: false, open: "", fm: "", close: "", body: raw };
  }
  const openMatch = raw.match(DELIM);
  const open = openMatch[0];
  const rest = raw.slice(open.length);
  // Find the closing delimiter line.
  const closeRe = /^---[ \t]*\r?\n?/m;
  const lines = rest.split(/(?<=\n)/); // keep line terminators
  let fm = "";
  let close = "";
  let body = "";
  let closed = false;
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^---[ \t]*\r?\n?$/.test(lines[i])) {
      close = lines[i];
      closed = true;
      i++;
      break;
    }
    fm += lines[i];
  }
  if (!closed) {
    // No closing delimiter — treat as no frontmatter (defensive).
    return { hasFrontmatter: false, open: "", fm: "", close: "", body: raw };
  }
  body = lines.slice(i).join("");
  void closeRe;
  return { hasFrontmatter: true, open, fm, close, body };
}

// ──────────────────────────────────────────────────────────────────────────
// Minimal YAML value (de)serialization for the supported value shapes
// ──────────────────────────────────────────────────────────────────────────

/** Quote a YAML scalar string only when required, preferring no quotes. */
function needsQuote(s) {
  if (s === "") return true;
  // Leading/trailing space, or a leading indicator char, or YAML specials.
  if (/^[\s]|[\s]$/.test(s)) return true;
  if (/^[!&*?|>%@`"'#\-\[\]{},]/.test(s)) return true;
  if (/:(\s|$)/.test(s)) return true; // a colon that YAML would read as a map
  if (/\s#/.test(s)) return true; // an inline comment marker
  if (/[\n\r]/.test(s)) return true;
  // Bare words that YAML would coerce to non-strings.
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return true;
  return false;
}

/** Serialize a single scalar (string/number/boolean/null) as a YAML token. */
function scalarToYaml(v) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (!needsQuote(s)) return s;
  // Double-quote, escaping backslash and double-quote.
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Serialize an inline flow array of scalars, honoring a `quoted` style hint so
 * an existing `["Read", …]` stays quoted and an existing `[Read, …]` stays
 * bare when its items don't require quoting.
 */
function arrayToInlineYaml(arr, quoted) {
  const items = arr.map((v) => {
    if (typeof v === "string" && quoted && !needsQuote(v)) {
      return '"' + v + '"';
    }
    return scalarToYaml(v);
  });
  return "[" + items.join(", ") + "]";
}

/** True for a scalar JS value (string/number/boolean/null). */
function isScalar(v) {
  return v === null || (typeof v !== "object" && typeof v !== "undefined");
}

/** True for an array all of whose members are scalars. */
function isScalarArray(v) {
  return Array.isArray(v) && v.every(isScalar);
}

// ──────────────────────────────────────────────────────────────────────────
// Frontmatter line model
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse the raw frontmatter text into a list of TOP-LEVEL key entries, each
 * recording the byte range it spans (so a value rewrite is surgical). Block
 * arrays (`- item` lines) and a value's continuation lines are attributed to
 * the preceding key.
 *
 * Returns { keys: [{ key, start, end, valueText, style }], lineEnds }.
 *   - `start`/`end` are character offsets into `fm` for the WHOLE entry
 *     (from the `key:` line through any continuation/block lines).
 *   - `style` is "inline-array" | "block-array" | "scalar" — a hint used to
 *     keep a rewrite in the same shape.
 */
function parseFrontmatterKeys(fm) {
  const lines = fm.split(/(?<=\n)/);
  const entries = [];
  let offset = 0;
  let current = null;

  const keyLineRe = /^([A-Za-z0-9_$][\w$.-]*|"[^"]*"|'[^']*'):(?:[ \t]+(.*?))?[ \t]*\r?\n?$/;

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length;
    const blockItem = /^[ \t]*-[ \t]/.test(line);
    const continuation = /^[ \t]+\S/.test(line) && !keyLineRe.test(line);
    const m = keyLineRe.exec(line);

    if (m && !blockItem) {
      // A new top-level (or any) key. Close the previous entry.
      if (current) {
        current.end = lineStart;
        entries.push(current);
      }
      const rawKey = m[1].replace(/^["']|["']$/g, "");
      const inlineVal = (m[2] ?? "").trim();
      current = {
        key: rawKey,
        start: lineStart,
        end: offset,
        keyLine: line,
        inlineValue: inlineVal,
        blockLines: [],
        style: inlineVal.startsWith("[") ? "inline-array" : "scalar",
      };
    } else if (current && (blockItem || continuation)) {
      // Attribute to the current key (block array item or folded continuation).
      current.blockLines.push(line);
      if (blockItem) current.style = "block-array";
      current.end = offset;
    } else if (current) {
      // Blank line or unrecognized — still part of the current entry's span if
      // it's trailing whitespace; otherwise close the entry here.
      if (line.trim() === "") {
        current.end = offset;
        current.blockLines.push(line);
      } else {
        current.end = lineStart;
        entries.push(current);
        current = null;
      }
    }
  }
  if (current) {
    current.end = offset;
    entries.push(current);
  }
  return entries;
}

/** Detect the quoting style of an existing inline-array value text. */
function inlineArrayIsQuoted(valueText) {
  return /\[\s*"/.test(valueText) || /\[\s*'/.test(valueText);
}

/**
 * Render the full text (key line + any block lines) for a key whose value is
 * `value`, matching `style` where possible. Returns a string ending in "\n".
 */
function renderKey(key, value, style, quotedHint) {
  if (isScalarArray(value) && value.length > 0 && style === "block-array") {
    const head = `${key}:\n`;
    const items = value.map((v) => `  - ${scalarToYaml(v)}\n`).join("");
    return head + items;
  }
  if (isScalarArray(value)) {
    if (value.length === 0) return `${key}: []\n`;
    return `${key}: ${arrayToInlineYaml(value, quotedHint)}\n`;
  }
  return `${key}: ${scalarToYaml(value)}\n`;
}

// ──────────────────────────────────────────────────────────────────────────
// Public — editability probe
// ──────────────────────────────────────────────────────────────────────────

/**
 * True when EVERY value in `frontmatter` is a shape this module can edit with a
 * minimal diff (scalar or scalar array). Bundle-style nested structures return
 * false, signaling the caller to use a whole-frontmatter rewrite for that kind.
 */
export function frontmatterMinimalEditable(frontmatter) {
  for (const v of Object.values(frontmatter)) {
    if (isScalar(v) || isScalarArray(v)) continue;
    return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Public — UPDATE (minimal diff)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Produce a new document that differs from `raw` ONLY where the frontmatter or
 * body actually changed.
 *
 * @param raw        the current file text.
 * @param nextFm     the desired frontmatter object (key ORDER is taken from the
 *                   existing file for untouched keys; new keys are appended in
 *                   the order they appear in `nextFm`).
 * @param nextBody   the desired body. If byte-equal to the current body, the
 *                   body region is left untouched (preserved verbatim).
 *
 * Behaviour:
 *   - A key whose serialized value is unchanged is left byte-identical.
 *   - A changed scalar/array key has ONLY its entry rewritten (in place), in the
 *     same shape (inline vs block array; quoted vs bare) where possible.
 *   - A key present in the file but absent from `nextFm` is removed (its whole
 *     entry, including block lines).
 *   - A key in `nextFm` not in the file is appended after the last existing key.
 *
 * Throws if a value shape is not minimal-diff-editable (caller should have
 * probed with `frontmatterMinimalEditable`).
 */
export function updateDocument(raw, nextFm, nextBody) {
  const doc = splitDocument(raw);
  if (!doc.hasFrontmatter) {
    throw new Error("updateDocument: source has no frontmatter to edit.");
  }
  const entries = parseFrontmatterKeys(doc.fm);
  const byKey = new Map(entries.map((e) => [e.key, e]));

  // Build the new frontmatter text by walking the EXISTING entries in order,
  // rewriting/removing as needed, then appending any brand-new keys.
  let fmOut = "";
  let cursor = 0;
  const seen = new Set();

  for (const entry of entries) {
    // Preserve any inter-entry bytes (shouldn't normally exist, but be safe).
    fmOut += doc.fm.slice(cursor, entry.start);
    cursor = entry.end;

    const original = doc.fm.slice(entry.start, entry.end);

    if (!(entry.key in nextFm)) {
      // Removed key → drop its bytes entirely.
      continue;
    }
    seen.add(entry.key);
    const value = nextFm[entry.key];
    if (!isScalar(value) && !isScalarArray(value)) {
      throw new Error(
        `updateDocument: value for '${entry.key}' is not a scalar or scalar array (not minimal-diff-editable).`,
      );
    }
    const quotedHint =
      entry.style === "inline-array" && inlineArrayIsQuoted(entry.inlineValue);
    const rendered = renderKey(entry.key, value, entry.style, quotedHint);
    // If the rendered entry equals the original bytes, keep the original
    // (preserves exotic-but-equivalent formatting, e.g. extra spacing).
    fmOut += rendered === original ? original : rendered;
  }
  fmOut += doc.fm.slice(cursor);

  // Append brand-new keys (not in the original) in nextFm declaration order.
  for (const [key, value] of Object.entries(nextFm)) {
    if (seen.has(key) || byKey.has(key)) continue;
    if (!isScalar(value) && !isScalarArray(value)) {
      throw new Error(
        `updateDocument: new key '${key}' has a non-scalar value (not minimal-diff-editable).`,
      );
    }
    // Ensure the running frontmatter ends with a newline before appending.
    if (fmOut.length > 0 && !fmOut.endsWith("\n")) fmOut += "\n";
    fmOut += renderKey(key, value, "scalar", false);
  }

  const body = typeof nextBody === "string" ? nextBody : doc.body;
  return doc.open + fmOut + doc.close + body;
}

// ──────────────────────────────────────────────────────────────────────────
// Public — CREATE (clean serialize, new files only)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Serialize a brand-new gray-matter document from a frontmatter object + body.
 * Keys are emitted in `frontmatter`'s own order; arrays of scalars render
 * inline (`[a, b]`); the body is written verbatim after the closing delimiter.
 *
 * This is ONLY for create (no existing formatting to preserve). For an edit of
 * an existing file, use `updateDocument` (minimal diff).
 */
export function serializeDocument(frontmatter, body) {
  let fm = "";
  for (const [key, value] of Object.entries(frontmatter)) {
    if (typeof value === "undefined") continue;
    if (isScalar(value) || isScalarArray(value)) {
      fm += renderKey(key, value, "scalar", false);
    } else {
      // Fallback for nested shapes (e.g. a bundle's arrays of maps): emit JSON-
      // compatible flow YAML on one line. Valid YAML, deterministic, rare path.
      fm += `${key}: ${JSON.stringify(value)}\n`;
    }
  }
  const safeBody = typeof body === "string" ? body : "";
  const bodyOut =
    safeBody.length === 0 ? "" : safeBody.startsWith("\n") ? safeBody : "\n" + safeBody;
  return `---\n${fm}---${bodyOut}`;
}
