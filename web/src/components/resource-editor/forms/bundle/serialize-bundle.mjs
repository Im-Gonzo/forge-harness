/**
 * serialize-bundle — PURE, framework-free, VALIDATOR-PARSEABLE serializer for a
 * Forge context-bundle's frontmatter (bundles/<id>.md).
 *
 * WHY THIS EXISTS (the load-bearing detail):
 *   A bundle's frontmatter is the only resource frontmatter with NESTED shapes —
 *   arrays of maps (`adrs`, `spec_sections`, `invisible_20`) and scalar arrays
 *   nested INSIDE those maps (`spec_sections[].sections`, `invisible_20[].refs`).
 *   The generic write cores cannot emit a shape `forge validate` accepts here:
 *     • frontmatter-edit-core's `serializeDocument` (the bridge CREATE path)
 *       JSON-flows an array-of-maps onto ONE line — `adrs: [{"id":…}]` — which is
 *       valid YAML but the self-validator (lint/validate-bundles.mjs) uses a tiny
 *       dependency-free reader that parses each flow element as a STRING, so the
 *       schema check fails: `.adrs[0]: expected type "object", got string`.
 *     • gray-matter's `matter.stringify` (the bridge UPDATE fallback) emits
 *       BLOCK sequences for the nested `sections`/`refs` arrays, and the same
 *       reader can't descend a block sequence inside a mapping item, so it reads
 *       `sections` as an empty scalar: `.spec_sections[0].sections: expected
 *       type "array", got string`.
 *
 *   The hand-authored bundles in forge/bundles/ avoid BOTH traps with exactly one
 *   convention: BLOCK sequences of mappings, but the nested scalar arrays written
 *   INLINE (`sections: ["a", "b"]`). The validator's reader parses that perfectly
 *   (block `- key: scalar` lines + `parseScalar` on an inline `[ … ]`). This
 *   module reproduces that convention deterministically.
 *
 * GUARANTEES
 *   • Output is byte-faithful to the hand-authored bundle style: top-level
 *     scalars, inline scalar arrays (`[1, 2]`), block sequences of mappings whose
 *     nested scalar arrays stay inline.
 *   • Real YAML parsers (gray-matter / js-yaml) AND the self-validator's reader
 *     both read it back to the identical object — verified end-to-end by
 *     scripts/verify-bundle-crud.mjs (create→edit→delete, validate PASS).
 *   • Key ORDER is the object's own insertion order (the form preserves the
 *     canonical 16-key order); a re-serialize of an unchanged object is stable.
 *   • Pure: no Next/React/fs/yaml dependency, so it is safe inside a
 *     "use client" boundary AND importable by the node verification script —
 *     the test exercises the exact bytes the form projects.
 */

// ──────────────────────────────────────────────────────────────────────────
// Scalar quoting (a focused subset matching the hand-authored bundle style)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Quote a YAML scalar string ONLY when required, preferring bare words (the
 * hand-authored bundles keep `path: docs/adr/ADR-0001.md` and
 * `sections: [1 HOT/WARM/COLD]` unquoted). Mirrors frontmatter-edit-core's
 * `needsQuote` so a scalar serialized here is byte-identical to the generic core.
 */
function needsQuote(s) {
  if (s === "") return true;
  if (/^[\s]|[\s]$/.test(s)) return true; // leading/trailing space
  if (/^[!&*?|>%@`"'#\-[\]{},]/.test(s)) return true; // leading indicator char
  if (/:(\s|$)/.test(s)) return true; // a colon YAML reads as a map
  if (/\s#/.test(s)) return true; // an inline-comment marker
  if (/[\n\r]/.test(s)) return true; // newlines
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true; // bare keyword
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return true; // number-like
  return false;
}

/** Serialize one scalar (string / number / boolean / null) as a YAML token. */
function scalarToYaml(v) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  const s = String(v);
  if (!needsQuote(s)) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** True for a scalar JS value (string / number / boolean / null). */
function isScalar(v) {
  return v === null || (typeof v !== "object" && typeof v !== "undefined");
}

/** True for an array all of whose members are scalars. */
function isScalarArray(v) {
  return Array.isArray(v) && v.every(isScalar);
}

/** Render an inline flow array of scalars: `[a, "b c", 3]` (empty → `[]`). */
function inlineScalarArray(arr) {
  if (arr.length === 0) return "[]";
  return "[" + arr.map(scalarToYaml).join(", ") + "]";
}

// ──────────────────────────────────────────────────────────────────────────
// Block sequence of mappings (adrs / spec_sections / invisible_20)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Render an array of plain maps as a block sequence, with each map's keys in
 * insertion order. A nested SCALAR ARRAY value (sections / refs) is rendered
 * INLINE — the one rule that keeps the self-validator's reader happy. A nested
 * scalar is rendered as a normal `key: value`. Deeper nesting is not part of the
 * bundle schema; if encountered it degrades to a compact inline flow (still valid
 * YAML), which keeps the serializer total rather than throwing.
 */
function blockSequenceOfMaps(key, arr) {
  let out = `${key}:\n`;
  for (const item of arr) {
    const entries = Object.entries(item ?? {}).filter(
      ([, v]) => typeof v !== "undefined",
    );
    if (entries.length === 0) {
      out += "  - {}\n";
      continue;
    }
    entries.forEach(([ik, iv], i) => {
      const prefix = i === 0 ? "  - " : "    "; // `- ` opens the item; rest aligns
      if (isScalarArray(iv)) {
        out += `${prefix}${ik}: ${inlineScalarArray(iv)}\n`;
      } else if (isScalar(iv)) {
        out += `${prefix}${ik}: ${scalarToYaml(iv)}\n`;
      } else {
        // Non-schema deeper structure — keep total via a compact JSON-ish flow.
        out += `${prefix}${ik}: ${JSON.stringify(iv)}\n`;
      }
    });
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Public — frontmatter block + whole-document serialize
// ──────────────────────────────────────────────────────────────────────────

/**
 * Serialize a bundle frontmatter object to the raw YAML BLOCK (no fences),
 * ending in a trailing newline. Keys are emitted in the object's own order;
 * `undefined` values are skipped (so an absent optional key is simply omitted).
 */
export function serializeBundleFrontmatter(frontmatter) {
  let out = "";
  for (const [key, value] of Object.entries(frontmatter)) {
    if (typeof value === "undefined") continue;
    if (isScalar(value)) {
      out += `${key}: ${scalarToYaml(value)}\n`;
      continue;
    }
    if (isScalarArray(value)) {
      out += `${key}: ${inlineScalarArray(value)}\n`;
      continue;
    }
    if (Array.isArray(value)) {
      // Array of maps (adrs / spec_sections / invisible_20) or mixed → block.
      out += value.length === 0
        ? `${key}: []\n`
        : blockSequenceOfMaps(key, value);
      continue;
    }
    // A bare nested map at top level is not in the bundle schema; emit a stable
    // inline flow so the serializer stays total (valid YAML, deterministic).
    out += `${key}: ${JSON.stringify(value)}\n`;
  }
  return out;
}

/**
 * Serialize a whole bundle document (`---\n<frontmatter>---<body>`), byte-faithful
 * to the hand-authored bundle style. The body is written verbatim after the
 * closing fence (a leading newline is inserted only when the body doesn't already
 * start with one, matching serializeDocument's body handling).
 */
export function serializeBundleDocument(frontmatter, body) {
  const fm = serializeBundleFrontmatter(frontmatter);
  const safeBody = typeof body === "string" ? body : "";
  const bodyOut =
    safeBody.length === 0
      ? ""
      : safeBody.startsWith("\n")
        ? safeBody
        : "\n" + safeBody;
  return `---\n${fm}---${bodyOut}`;
}
