/**
 * frontmatter — tolerant YAML-ish frontmatter parser shared by the registry scan.
 *
 * The registry (SPEC-01) needs `owner`/`description`/`tags`/`criticality` and an
 * optional advisory `version`/`status` from each artifact's leading `--- ... ---`
 * block. This is a NEW shared module (BUILD-PLAN-v0.2 decision 3): it deliberately
 * does NOT rewire the three existing per-validator parsers — it copies the same
 * BOM/CRLF-tolerant splitting idea from `lint/validate-agents.mjs` and extends it
 * with a tiny value reader.
 *
 * Design constraints (HARD INVARIANTS): zero runtime deps (node builtins / relative
 * only), fail-open — `parseFrontmatter` NEVER throws; on any malformed input it
 * degrades to `{ present:false, data:{}, body:'' }` (or as much as it parsed).
 *
 * Recognised keys (everything else is ignored, BR-VER-008):
 *   name, description, owner, tags, criticality, version, status
 * `tags` is normalised to a string[] whether it was inline (`[a, b]`) or a block
 * list (`- a` / `- b`); all other keys are returned as trimmed strings.
 *
 * @module manager/lib/frontmatter
 */

const SCALAR_KEYS = ['name', 'description', 'owner', 'criticality', 'version', 'status'];
const LIST_KEYS = ['tags'];
const KNOWN_KEYS = new Set([...SCALAR_KEYS, ...LIST_KEYS]);

/**
 * Split a markdown document into its leading YAML frontmatter block and body.
 * Tolerant of a UTF-8 BOM and CRLF line endings. Never throws.
 *
 * @param {string} content - raw file text
 * @returns {{present: boolean, lines: string[], body: string}}
 */
function splitFrontmatter(content) {
  if (typeof content !== 'string') return { present: false, lines: [], body: '' };
  const clean = content.replace(/^\uFEFF/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) return { present: false, lines: [], body: clean };
  return {
    present: true,
    lines: match[1].split(/\r?\n/),
    body: match[2] ?? '',
  };
}

/**
 * Strip an unquoted trailing `# comment` and surrounding whitespace from a raw
 * scalar value. Quoted values are returned verbatim (minus the quotes).
 *
 * @param {string} raw
 * @returns {string}
 */
function cleanScalar(raw) {
  let v = String(raw).trim();
  if (/^["']/.test(v)) {
    // Quoted: take the quoted span, drop the surrounding quotes.
    const q = v[0];
    const end = v.indexOf(q, 1);
    if (end > 0) return v.slice(1, end);
    return v.slice(1);
  }
  // Unquoted: a `#` preceded by whitespace begins a comment.
  v = v.replace(/\s+#.*$/, '').trim();
  return v;
}

/**
 * Parse an inline YAML list (`[a, b, "c d"]`) into a string[]. Returns null if the
 * value is not bracketed. Fail-open: malformed brackets degrade gracefully.
 *
 * @param {string} raw
 * @returns {string[]|null}
 */
function parseInlineList(raw) {
  const v = String(raw).trim();
  if (!(v.startsWith('[') && v.endsWith(']'))) return null;
  const inner = v.slice(1, -1).trim();
  if (inner === '') return [];
  return inner
    .split(',')
    .map((s) => cleanScalar(s))
    .filter((s) => s.length > 0);
}

/**
 * Parse the leading frontmatter of a document into a tolerant `data` object.
 *
 * Extracts only the known registry-relevant keys (name, description, owner, tags,
 * criticality, version, status); unknown keys are ignored. Inline and block YAML-ish
 * lists are both understood for `tags`. BOM- and CRLF-tolerant, trailing comments on
 * unquoted scalars are stripped, duplicate keys keep the FIRST occurrence (matching
 * a top-down read). NEVER throws — on any failure returns the partial/empty result.
 *
 * @param {string} content - raw file text
 * @returns {{present: boolean, data: {name?:string, description?:string, owner?:string, tags?:string[], criticality?:string, version?:string, status?:string}, body: string}}
 */
export function parseFrontmatter(content) {
  try {
    const fm = splitFrontmatter(content);
    if (!fm.present) return { present: false, data: {}, body: fm.body };

    const data = {};
    const seen = new Set();
    let lastListKey = null; // a known LIST key currently collecting block items

    for (const rawLine of fm.lines) {
      // Indented line: a block-list item or nested value for the preceding key.
      if (/^\s/.test(rawLine)) {
        const m = rawLine.match(/^\s*-\s+(.*)$/);
        if (m && lastListKey && Array.isArray(data[lastListKey])) {
          const item = cleanScalar(m[1]);
          if (item.length > 0) data[lastListKey].push(item);
        }
        continue;
      }

      const colonIdx = rawLine.indexOf(':');
      if (colonIdx <= 0) continue;
      const key = rawLine.slice(0, colonIdx).trim();
      const rawVal = rawLine.slice(colonIdx + 1);

      if (!KNOWN_KEYS.has(key)) {
        lastListKey = null; // a new top-level (unknown) key ends any block list
        continue;
      }
      if (seen.has(key)) {
        lastListKey = LIST_KEYS.includes(key) ? key : null;
        continue; // keep first occurrence of a known key
      }
      seen.add(key);

      if (LIST_KEYS.includes(key)) {
        const inline = parseInlineList(rawVal);
        if (inline !== null) {
          data[key] = inline;
          lastListKey = null; // inline list is complete on this line
        } else {
          // Empty value -> a block list may follow on indented lines.
          data[key] = [];
          lastListKey = key;
        }
        continue;
      }

      // Scalar key.
      data[key] = cleanScalar(rawVal);
      lastListKey = null;
    }

    return { present: true, data, body: fm.body };
  } catch {
    // Fail-open: degrade to empty rather than throwing past this entry point.
    return { present: false, data: {}, body: '' };
  }
}

export default { parseFrontmatter };
