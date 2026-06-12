#!/usr/bin/env node
/**
 * validate-no-personal-paths — Forge self-validator (Phase 2).
 *
 * Forge is meant to be shared/installed on other machines. We also sync a
 * prod DB and keep local-path notes during development, so a leaked absolute
 * machine path is a real exfiltration / portability hazard. This validator
 * fails the build if a shipped asset contains an absolute PERSONAL path:
 *
 *   - POSIX home:   /home/<user>/...
 *   - macOS home:   /Users/<user>/...
 *   - Windows home: C:\Users\<user>\...   (any drive letter)
 *
 * ALLOWED (never flagged):
 *   - the author email in plugin.json / marketplace.json
 *   - portable tokens: ~/.claude, $CLAUDE_PROJECT_DIR, ${CLAUDE_PLUGIN_ROOT},
 *     $HOME, ${HOME}
 *   - placeholder usernames used in examples (<user>, user, you, ...)
 *   - relative paths (only absolute home paths are matched)
 *
 * Usage:
 *   node lint/validate-no-personal-paths.mjs [--strict] [rootDir]
 *
 * Exit 0 = pass, exit 1 = fail (>=1 leak).
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
const STRICT = argv.includes('--strict'); // reserved; behaviour identical for now
const positional = argv.filter((a) => !a.startsWith('--'));
const ROOT = positional.length > 0 ? path.resolve(positional[0]) : DEFAULT_ROOT;

const IGNORED_DIRS = new Set(['node_modules', '.git', '.claude']);

// Shipped text assets to scan: docs/, manifests/, schemas/, README, and any
// agents/skills/commands/rules + the plugin manifests.
const SCAN_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.json',
  '.mjs',
  '.js',
  '.cjs',
  '.txt',
  '.yml',
  '.yaml',
  '.sh',
  '.toml',
]);
const EXTENSIONLESS_ALLOW = new Set(['VERSION']);

// Usernames that are obviously placeholders, not a real leaked account.
// (`someone`/`victim`/`alice`/`bob` are the canonical example-actor names the
// telemetry redaction tests plant as adversarial fixtures — never a real path.)
const PLACEHOLDER_USERS = new Set([
  'user',
  'username',
  'example',
  'me',
  'you',
  'your-username',
  'yourusername',
  'yourname',
  'name',
  '<user>',
  'someone',
  'somebody',
  'victim',
  'alice',
  'bob',
]);

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// Capture the first path segment after the home root as the "username".
// A real OS username starts with a letter or digit, then word chars / dots /
// hyphens. Requiring a valid leading char avoids self-matching this file's
// own regex literals (e.g. `/home/(${SEG})`) and other non-path prose.
const SEG = `[A-Za-z0-9][A-Za-z0-9._-]*`;

const PATTERNS = [
  { name: 'posix-home', re: new RegExp(`/home/(${SEG})`, 'g') },
  { name: 'macos-home', re: new RegExp(`/Users/(${SEG})`, 'g') },
  // Any drive letter, both slash directions for the leading separator.
  { name: 'windows-home', re: new RegExp(`[A-Za-z]:\\\\Users\\\\(${SEG})`, 'g') },
];

function normalizeUser(raw) {
  // Trailing punctuation sometimes clings to a path in prose; strip a few.
  return raw.replace(/[).,;:]+$/, '').toLowerCase();
}

function findLeaks(content) {
  const leaks = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lineText)) !== null) {
        const user = normalizeUser(m[1]);
        if (PLACEHOLDER_USERS.has(user)) continue;
        // Treat a bare placeholder angle-bracket token as a placeholder too.
        if (user.startsWith('<') && user.endsWith('>')) continue;
        leaks.push({
          line: i + 1,
          column: m.index + 1,
          match: m[0],
          user: m[1],
          kind: name,
        });
      }
    }
  }
  return leaks;
}

// ---------------------------------------------------------------------------
// FS walk
// ---------------------------------------------------------------------------

function isScannable(filePath) {
  const base = path.basename(filePath);
  if (EXTENSIONLESS_ALLOW.has(base)) return true;
  return SCAN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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
// Main
// ---------------------------------------------------------------------------

function main() {
  const files = collectRoot(ROOT);
  let leakCount = 0;
  let filesWithLeaks = 0;

  for (const filePath of files) {
    const rel = path.relative(ROOT, filePath) || path.basename(filePath);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const leaks = findLeaks(content);
    if (leaks.length > 0) filesWithLeaks += 1;

    for (const leak of leaks) {
      leakCount += 1;
      process.stdout.write(
        `ERROR  ${rel}:${leak.line}:${leak.column}  ` +
          `leaked personal path "${leak.match}" (user="${leak.user}", ${leak.kind})\n`,
      );
    }
  }

  const summary =
    `\nvalidate-no-personal-paths: scanned ${files.length} file(s); ` +
    `${leakCount} leak(s) in ${filesWithLeaks} file(s).`;
  process.stdout.write(`${summary}\n`);

  process.exit(leakCount > 0 ? 1 : 0);
}

main();
