// @ts-check
/**
 * graph-edit-core — the PURE, framework-free manifest-editing primitives.
 *
 * These functions do byte-minimal, format-preserving edits of a composition
 * manifest's JSON text using jsonc-parser. They have ZERO dependence on Next,
 * `@/` path aliases, node:fs, or any forge config — they take a string in and
 * return a string out — so they are equally importable from:
 *   • graph.ts (the server bridge — re-exports these), and
 *   • plain Node verification scripts (scripts/verify-minimal-diff.mjs).
 *
 * Keeping them here (a single source of truth) means the round-trip test
 * exercises the EXACT code the route runs, not a copy.
 *
 * @module forge-bridge/graph-edit-core
 */
import { applyEdits, findNodeAtLocation, modify, parseTree } from "jsonc-parser";

/**
 * @typedef {(string|number)[]} JsonPath A JSON path (object keys + array indices).
 */

/**
 * Add `value` to (or remove it from) the scalar array at `jsonPath` by editing
 * ONLY the bytes around the single element — never re-serializing the array or
 * the document. An inline array stays inline; a hand-wrapped multi-line array
 * stays wrapped; every other byte (incl. unrelated arrays) is preserved
 * verbatim. Idempotent: add of a present value / remove of an absent one is a
 * no-op (returns the text unchanged).
 *
 * @param {string} text the manifest's full JSON text
 * @param {JsonPath} jsonPath path to the scalar array
 * @param {"add"|"remove"} op
 * @param {string} value the scalar element
 * @returns {string} the edited text (or `text` unchanged for a no-op)
 */
export function editScalarArray(text, jsonPath, op, value) {
  const root = parseTree(text);
  if (!root) throw new Error("editScalarArray: manifest is not valid JSON.");
  const arr = findNodeAtLocation(root, jsonPath);
  if (!arr || arr.type !== "array") {
    throw new Error(
      `editScalarArray: no array at path ${JSON.stringify(jsonPath)}.`,
    );
  }
  const items = arr.children ?? [];

  if (op === "add") {
    if (items.some((c) => c.value === value)) return text; // already present
    const valueText = JSON.stringify(value);
    if (items.length === 0) {
      // Empty "[]" — insert between the brackets (offset+1 is just past "[").
      const open = arr.offset + 1;
      return text.slice(0, open) + valueText + text.slice(open);
    }
    const last = items[items.length - 1];
    const insertAt = last.offset + last.length;
    // Reuse the array's own inter-element separator (comma + its own whitespace);
    // for a single-element array fall back to a plain ", ".
    const sep =
      items.length >= 2
        ? text.slice(
            items[items.length - 2].offset + items[items.length - 2].length,
            last.offset,
          )
        : ", ";
    return text.slice(0, insertAt) + sep + valueText + text.slice(insertAt);
  }

  // op === "remove"
  const idx = items.findIndex((c) => c.value === value);
  if (idx === -1) return text; // not present
  const node = items[idx];
  let start;
  let end;
  if (idx > 0) {
    // Drop the element and the separator BEFORE it.
    const prev = items[idx - 1];
    start = prev.offset + prev.length;
    end = node.offset + node.length;
  } else if (items.length > 1) {
    // First of several: drop the element and the separator AFTER it.
    start = node.offset;
    end = items[idx + 1].offset;
  } else {
    // Sole element: drop just the element, leaving an empty "[]".
    start = node.offset;
    end = node.offset + node.length;
  }
  return text.slice(0, start) + text.slice(end);
}

/**
 * Delete the whole object property at `jsonPath` (e.g. a now-empty
 * `components.skills` key). Uses jsonc-parser modify(undefined) + applyEdits,
 * which removes only that property's bytes and its trailing comma; every other
 * line is preserved.
 *
 * @param {string} text the manifest's full JSON text
 * @param {JsonPath} jsonPath path to the property to delete
 * @returns {string} the edited text (or `text` unchanged when absent)
 */
export function deleteProperty(text, jsonPath) {
  const edits = modify(text, jsonPath, undefined, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  return applyEdits(text, edits);
}

/**
 * Surgically rewrite every occurrence of `rawRef` in one source file's text to
 * resolve a dangling reference. Pure (string in, string out). Three forms are
 * handled, in priority order, all anchored so only the WHOLE token matches:
 *   1. a frontmatter pointer line  `^<key>:<ws>"?<rawRef>"?\s*$`
 *      → remove (delete the line) | redirect (swap the value to toId)
 *   2. an inline backticked token  `` `<rawRef>` ``
 *      → remove (unbacktick to plain text) | redirect (`` `toId` ``)
 *   3. anything else is left untouched (conservative).
 *
 * @param {string} text the source file's full text
 * @param {string} rawRef the exact reference token to rewrite
 * @param {"remove"|"redirect"} action
 * @param {string} [toId] the existing artifact id to point at (redirect only)
 * @returns {string} the rewritten text (or `text` unchanged when nothing matched)
 */
export function rewriteRef(text, rawRef, action, toId) {
  const esc = rawRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // (1) Frontmatter pointer line: `<key>: <rawRef>` (optionally quoted), where
  // the value is exactly rawRef. Match within the leading --- … --- block only.
  const fmMatch = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (fmMatch) {
    const head = fmMatch[1];
    const block = fmMatch[2];
    const tail = fmMatch[3];
    const lineRe = new RegExp(
      `^([ \\t]*[A-Za-z0-9_-]+:[ \\t]*)["']?${esc}["']?[ \\t]*$`,
      "m",
    );
    if (lineRe.test(block)) {
      let nextBlock;
      if (action === "redirect") {
        nextBlock = block.replace(lineRe, `$1${toId}`);
      } else {
        // remove the whole pointer line (and its newline)
        nextBlock = block
          .split(/\r?\n/)
          .filter((ln) => !lineRe.test(ln))
          .join("\n");
      }
      const rest = text.slice(fmMatch[0].length);
      return head + nextBlock + tail + rest;
    }
  }

  // (2) Inline backticked token: `` `rawRef` `` anywhere in the file.
  const tickRe = new RegExp("`" + esc + "`", "g");
  if (tickRe.test(text)) {
    if (action === "redirect") {
      return text.replace(tickRe, "`" + toId + "`");
    }
    // remove → unbacktick to plain prose (drops the edge, keeps readability)
    return text.replace(tickRe, rawRef);
  }

  // Nothing matched in this file — leave it untouched.
  return text;
}
