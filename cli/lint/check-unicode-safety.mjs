#!/usr/bin/env node
/**
 * check-unicode-safety — Forge self-validator (Phase 2).
 *
 * Flags dangerous INVISIBLE / control characters in shipped text assets:
 *   - zero-width chars: U+200B–U+200D, U+FEFF (when not a leading BOM)
 *   - bidi controls:    U+202A–U+202E, U+2066–U+2069
 *   - Unicode TAG block (U+E0000–U+E007F) — the canonical "ASCII/tag
 *     smuggling" prompt-injection vector: instructions hidden as invisible
 *     tag bytes that the LLM consumes but a human reviewer never sees.
 *
 * Visible emoji are ALLOWED — Forge docs intentionally use status/section
 * markers (✅ ⬜ ⭐ ▶ ⚠). They are NOT errors; under --strict they are
 * reported as WARN only.
 *
 * Usage:
 *   node lint/check-unicode-safety.mjs [--strict] [--write] [rootDir]
 *
 * Exit 0 = pass (no errors), exit 1 = fail (>=1 error).
 *
 * Zero dependencies. Self-contained (no shared-lib import).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Args / config
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const WRITE = argv.includes('--write');
const positional = argv.filter((a) => !a.startsWith('--'));
const ROOT = positional.length > 0 ? path.resolve(positional[0]) : DEFAULT_ROOT;

const IGNORED_DIRS = new Set(['node_modules', '.git', '.claude']);

// Shipped text assets to scan.
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.json',
  '.mjs',
  '.js',
  '.cjs',
  '.txt',
  '.yml',
  '.yaml',
]);

// Files with no extension that should still be scanned.
const EXTENSIONLESS_ALLOW = new Set(['VERSION']);

// ---------------------------------------------------------------------------
// Character classification
// ---------------------------------------------------------------------------

/**
 * Dangerous invisible / control code points (errors).
 * `isBom` is true only for a U+FEFF that is the very first code unit of the
 * file — a legitimate leading byte-order mark, which we do NOT flag.
 */
function isDangerousInvisible(codePoint, isBom) {
  return (
    // zero-width space / non-joiner / joiner
    (codePoint >= 0x200b && codePoint <= 0x200d) ||
    // zero-width no-break space (BOM elsewhere in file)
    (codePoint === 0xfeff && !isBom) ||
    // bidi embedding / override controls
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    // bidi isolate controls
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    // Unicode TAG block — tag smuggling
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  );
}

// Visible emoji / pictographs (allowed; WARN only under --strict).
const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})/gu;
// Common typographic symbols that match Extended_Pictographic but are benign
// and intentionally used as section markers; never warn on these.
const ALLOWED_SYMBOL_CODEPOINTS = new Set([
  0x00a9, // ©
  0x00ae, // ®
  0x2122, // ™
  0x2705, // ✅
  0x2b1c, // ⬜
  0x2b50, // ⭐
  0x25b6, // ▶
  0x26a0, // ⚠
]);

function isAllowedSymbol(codePoint) {
  return ALLOWED_SYMBOL_CODEPOINTS.has(codePoint);
}

function hexCp(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// FS walk
// ---------------------------------------------------------------------------

function isScannable(filePath) {
  const base = path.basename(filePath);
  if (EXTENSIONLESS_ALLOW.has(base)) return true;
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function listFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...listFiles(full));
    } else if (entry.isFile() && isScannable(full)) {
      out.push(full);
    }
  }
  return out;
}

/** Resolve the root (dir or single file) to a scannable file list. */
function collectRoot(root) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    return [];
  }
  if (stat.isFile()) return isScannable(root) ? [root] : [];
  return listFiles(root);
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Walk the text by code point, tracking line/column (1-based). `column`
 * counts code points within the line so wide chars don't desync.
 */
function scanText(text) {
  const errors = [];
  const warnings = [];

  let line = 1;
  let column = 1;
  let unitIndex = 0; // UTF-16 unit index (== 0 means file start)

  for (const ch of text) {
    const codePoint = ch.codePointAt(0);

    if (ch === '\n') {
      line += 1;
      column = 1;
      unitIndex += ch.length;
      continue;
    }

    const isBom = codePoint === 0xfeff && unitIndex === 0;

    if (isDangerousInvisible(codePoint, isBom)) {
      errors.push({ line, column, codePoint, kind: classify(codePoint) });
    } else if (STRICT && EMOJI_RE.test(ch) && !isAllowedSymbol(codePoint)) {
      warnings.push({ line, column, codePoint, kind: 'visible-emoji' });
    }
    // reset stateful regex lastIndex (we test single chars but stay safe)
    EMOJI_RE.lastIndex = 0;

    column += 1;
    unitIndex += ch.length;
  }

  return { errors, warnings };
}

function classify(codePoint) {
  if (codePoint >= 0x200b && codePoint <= 0x200d) return 'zero-width';
  if (codePoint === 0xfeff) return 'zero-width-bom';
  if (codePoint >= 0x202a && codePoint <= 0x202e) return 'bidi-control';
  if (codePoint >= 0x2066 && codePoint <= 0x2069) return 'bidi-isolate';
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return 'tag-smuggling';
  return 'dangerous-invisible';
}

/** Strip every dangerous invisible char (preserving a leading BOM). */
function stripDangerous(text) {
  let out = '';
  let unitIndex = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0);
    const isBom = codePoint === 0xfeff && unitIndex === 0;
    if (!isDangerousInvisible(codePoint, isBom)) {
      out += ch;
    }
    unitIndex += ch.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const files = collectRoot(ROOT);
  let errorCount = 0;
  let warnCount = 0;
  let filesWithErrors = 0;
  const changed = [];

  for (const filePath of files) {
    const rel = path.relative(ROOT, filePath) || path.basename(filePath);
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    if (WRITE) {
      const stripped = stripDangerous(text);
      if (stripped !== text) {
        try {
          fs.writeFileSync(filePath, stripped, 'utf8');
          changed.push(rel);
          text = stripped;
        } catch (err) {
          process.stderr.write(
            `WARN  ${rel}  could not write autofix: ${err.message}\n`,
          );
        }
      }
    }

    const { errors, warnings } = scanText(text);

    if (errors.length > 0) filesWithErrors += 1;

    for (const e of errors) {
      errorCount += 1;
      process.stdout.write(
        `ERROR  ${rel}:${e.line}:${e.column}  dangerous invisible char ${hexCp(e.codePoint)} (${e.kind})\n`,
      );
    }
    for (const w of warnings) {
      warnCount += 1;
      process.stdout.write(
        `WARN   ${rel}:${w.line}:${w.column}  visible emoji ${hexCp(w.codePoint)} (allowed; flagged under --strict)\n`,
      );
    }
  }

  if (changed.length > 0) {
    process.stdout.write(
      `\nAutofix: stripped dangerous chars from ${changed.length} file(s):\n`,
    );
    for (const c of changed) process.stdout.write(`  - ${c}\n`);
  }

  const summary =
    `\ncheck-unicode-safety: scanned ${files.length} file(s); ` +
    `${errorCount} error(s) in ${filesWithErrors} file(s); ${warnCount} warning(s).`;
  process.stdout.write(`${summary}\n`);

  process.exit(errorCount > 0 ? 1 : 0);
}

main();
