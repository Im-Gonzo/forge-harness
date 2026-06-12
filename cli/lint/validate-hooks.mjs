#!/usr/bin/env node
/**
 * validate-hooks — Forge self-validator (Phase 2).
 *
 * Validates hooks/hooks.json against schemas/hooks.schema.json (structurally, with a
 * hand-rolled draft-07 subset walker — NOT AJV, ZERO dependencies), then runs semantic
 * checks:
 *
 *   STRUCTURAL
 *     - hooks/hooks.json  <- schemas/hooks.schema.json
 *
 *   SEMANTIC
 *     - every event name used is a valid Claude Code hook event
 *       (SessionStart / PreToolUse / PostToolUse / Stop / PreCompact / SessionEnd, plus
 *        the broader set the schema permits)
 *     - every hook `command` that references a repo script path
 *       (e.g. ${CLAUDE_PLUGIN_ROOT}/bootstrap/detect-project.mjs) points at a file that
 *       exists in the repo.
 *
 * Usage:
 *   node lint/validate-hooks.mjs [--strict] [rootDir]
 *
 * Exit 0 = pass (no errors), exit 1 = fail. Absence of hooks/hooks.json is NOT an error.
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
const positional = argv.filter((a) => !a.startsWith('--'));
const ROOT = positional.length > 0 ? path.resolve(positional[0]) : DEFAULT_ROOT;

const NAME = 'validate-hooks';

// The canonical Claude Code hook events. The task names a core six; we accept the
// broader set the schema permits (these are all legal Claude Code events).
const VALID_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'Stop',
  'SubagentStop',
  'Notification',
  'UserPromptSubmit',
]);

// ---------------------------------------------------------------------------
// Finding collection
// ---------------------------------------------------------------------------

const findings = []; // { level, path, line, message }
function err(filePath, line, message) {
  findings.push({ level: 'ERROR', path: filePath, line: line || 0, message });
}
function warn(filePath, line, message) {
  findings.push({ level: 'WARN', path: filePath, line: line || 0, message });
}
function rel(p) {
  const r = path.relative(ROOT, p);
  return r === '' ? path.basename(p) : r;
}

// ---------------------------------------------------------------------------
// Minimal draft-07 subset schema walker (with $ref + definitions support, since
// hooks.schema.json uses internal $refs). No AJV. Zero dependencies.
// ---------------------------------------------------------------------------

function jsType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(value, schemaType) {
  const types = Array.isArray(schemaType) ? schemaType : [schemaType];
  const actual = jsType(value);
  for (const t of types) {
    if (t === 'number' && (actual === 'number' || actual === 'integer')) return true;
    if (t === 'integer' && actual === 'integer') return true;
    if (t === actual) return true;
  }
  return false;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// Resolve a local "#/definitions/foo" $ref against the root schema.
function resolveRef(ref, rootSchema) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let node = rootSchema;
  for (const p of parts) {
    if (node && typeof node === 'object' && p in node) node = node[p];
    else return null;
  }
  return node;
}

function validateSchema(value, schema, dataPath, out, rootSchema) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, rootSchema);
    if (resolved) {
      validateSchema(value, resolved, dataPath, out, rootSchema);
      return;
    }
    out.push(`${dataPath || '(root)'}: unresolved $ref ${schema.$ref}`);
    return;
  }

  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    out.push(`${dataPath || '(root)'}: expected type ${JSON.stringify(schema.type)}, got ${jsType(value)}`);
    return;
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => deepEqual(e, value))) {
      out.push(`${dataPath || '(root)'}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      out.push(`${dataPath}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.pattern === 'string') {
      let re = null;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        /* ignore bad pattern */
      }
      if (re && !re.test(value)) out.push(`${dataPath}: does not match pattern /${schema.pattern}/`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      out.push(`${dataPath}: value ${value} below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      out.push(`${dataPath}: value ${value} above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      out.push(`${dataPath}: array has ${value.length} items, fewer than minItems ${schema.minItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = [];
      for (const item of value) {
        if (seen.some((s) => deepEqual(s, item))) {
          out.push(`${dataPath}: duplicate array item`);
          break;
        }
        seen.push(item);
      }
    }
    if (schema.items) {
      value.forEach((item, i) => validateSchema(item, schema.items, `${dataPath}[${i}]`, out, rootSchema));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      out.push(`${dataPath || '(root)'}: fewer than minProperties ${schema.minProperties}`);
    }
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(req in value)) out.push(`${dataPath || '(root)'}: missing required property '${req}'`);
      }
    }
    if (schema.propertyNames && Array.isArray(schema.propertyNames.enum)) {
      for (const k of keys) {
        if (!schema.propertyNames.enum.includes(k)) {
          out.push(`${dataPath || '(root)'}: property name '${k}' not allowed`);
        }
      }
    }
    const props = schema.properties || {};
    for (const k of keys) {
      const childPath = `${dataPath}.${k}`;
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        validateSchema(value[k], props[k], childPath, out, rootSchema);
      } else if (schema.additionalProperties === false) {
        out.push(`${dataPath || '(root)'}: additional property '${k}' not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateSchema(value[k], schema.additionalProperties, childPath, out, rootSchema);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, error: `cannot read: ${e.message}`, missing: e.code === 'ENOENT' };
  }
  try {
    return { ok: true, value: JSON.parse(raw), raw };
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e.message}` };
  }
}

// Find the 1-based line number of the first occurrence of `needle` in `raw`.
function lineOf(raw, needle) {
  if (!raw) return 0;
  const idx = raw.indexOf(needle);
  if (idx < 0) return 0;
  return raw.slice(0, idx).split('\n').length;
}

// Extract repo-relative script paths from a hook command string.
// Recognizes ${CLAUDE_PLUGIN_ROOT}/<path> and bare relative-looking script paths
// ending in a code extension (.mjs/.js/.cjs/.sh/.py).
function extractScriptPaths(command) {
  const out = [];
  if (typeof command !== 'string') return out;

  // ${CLAUDE_PLUGIN_ROOT}/...  or  $CLAUDE_PLUGIN_ROOT/...
  const pluginRootRe = /\$\{?CLAUDE_PLUGIN_ROOT\}?\/([^\s"']+)/g;
  let m;
  while ((m = pluginRootRe.exec(command)) !== null) {
    out.push({ rel: m[1], token: m[0] });
  }

  // Other quoted/bare tokens that look like script files but are NOT env-var
  // expansions we don't understand. We only resolve those rooted at the repo
  // (no leading $VAR, no absolute path) to avoid false positives on system bins.
  const scriptRe = /(?:^|[\s"'(])((?:bootstrap|lint|bin|hooks|scripts)\/[^\s"')]+\.(?:mjs|js|cjs|sh|py))/g;
  while ((m = scriptRe.exec(command)) !== null) {
    out.push({ rel: m[1], token: m[1] });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const hooksPath = path.join(ROOT, 'hooks', 'hooks.json');
  const schemaPath = path.join(ROOT, 'schemas', 'hooks.schema.json');

  const hooksR = readJson(hooksPath);

  // Absence of hooks/hooks.json is NOT an error.
  if (!hooksR.ok && hooksR.missing) {
    console.log(`${NAME}: no hooks/hooks.json found (nothing to validate)`);
    console.log(`${NAME}: PASS`);
    process.exit(0);
  }
  if (!hooksR.ok) {
    err(hooksPath, 0, hooksR.error);
    return report();
  }

  const schemaR = readJson(schemaPath);
  if (!schemaR.ok) {
    err(schemaPath, 0, schemaR.error);
  } else {
    const out = [];
    validateSchema(hooksR.value, schemaR.value, '', out, schemaR.value);
    for (const m of out) err(hooksPath, 0, `schema: ${m}`);
  }

  // --- SEMANTIC ---
  const root = hooksR.value || {};
  // hooks may be nested under a top-level "hooks" key, or be the event map directly.
  const eventMap =
    root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks) ? root.hooks : root;

  for (const [eventName, groups] of Object.entries(eventMap)) {
    if (eventName === '$schema' || eventName === 'hooks') continue; // metadata / wrapper
    if (!VALID_EVENTS.has(eventName)) {
      err(hooksPath, lineOf(hooksR.raw, `"${eventName}"`), `unknown hook event '${eventName}'`);
      continue;
    }
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const hookList = group && Array.isArray(group.hooks) ? group.hooks : [];
      for (const hook of hookList) {
        if (!hook || typeof hook.command !== 'string') continue;
        const scripts = extractScriptPaths(hook.command);
        for (const s of scripts) {
          const abs = path.join(ROOT, s.rel);
          if (!fs.existsSync(abs)) {
            err(
              hooksPath,
              lineOf(hooksR.raw, s.token),
              `hook command references missing script '${s.rel}' (resolved to ${rel(abs)})`
            );
          }
        }
        if (scripts.length === 0 && /CLAUDE_PLUGIN_ROOT/.test(hook.command)) {
          // command uses the plugin root but we couldn't parse a path — note it.
          warn(
            hooksPath,
            lineOf(hooksR.raw, hook.command.slice(0, 20)),
            `could not extract a script path from command using CLAUDE_PLUGIN_ROOT: ${hook.command}`
          );
        }
      }
    }
  }

  return report();
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report() {
  const errors = findings.filter((f) => f.level === 'ERROR');
  const warns = findings.filter((f) => f.level === 'WARN');

  const ordered = [...errors, ...warns].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });

  for (const f of ordered) {
    console.log(`${f.level} ${rel(f.path)}:${f.line} ${f.message}`);
  }

  console.log(`\n${NAME}: ${errors.length} error(s), ${warns.length} warning(s)`);

  // Under --strict, warnings are promoted to failures.
  const fail = errors.length > 0 || (STRICT && warns.length > 0);
  if (fail) {
    console.log(`${NAME}: FAIL`);
    process.exit(1);
  }
  console.log(`${NAME}: PASS`);
  process.exit(0);
}

main();
