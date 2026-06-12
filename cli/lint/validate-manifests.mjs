#!/usr/bin/env node
/**
 * validate-manifests — Forge self-validator (Phase 2). THE composition-integrity check.
 *
 * Validates the two composition manifests against their JSON Schemas (structurally,
 * with a hand-rolled draft-07 subset walker — NOT AJV, ZERO dependencies), then runs
 * the semantic cross-reference checks that are the whole point of Forge:
 *
 *   STRUCTURAL
 *     - manifests/modules.json   <- schemas/modules.schema.json
 *     - manifests/profiles.json  <- schemas/profiles.schema.json
 *
 *   SEMANTIC (composition integrity)
 *     - every module a profile names (profiles[].modules) EXISTS in modules.json
 *     - every module a moduleSelectionRules.add/.drop entry names EXISTS in modules.json
 *     - defaultProfile is a real profile
 *     - module component keys are members of componentKinds
 *     - (forward-looking) every component a module names resolves to a real asset file.
 *       In Phase 2 the asset dirs are empty, so an unresolved component is a WARN with a
 *       "(planned)" note. Under --strict these WARNs become ERRORs.
 *
 * Usage:
 *   node lint/validate-manifests.mjs [--strict] [rootDir]
 *
 * Exit 0 = pass (no errors), exit 1 = fail (>=1 error). Under --strict, planned-asset
 * WARNs count as errors.
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

const NAME = 'validate-manifests';

// ---------------------------------------------------------------------------
// Finding collection
// ---------------------------------------------------------------------------

const findings = []; // { level: 'ERROR'|'WARN', path, line, message }

function err(filePath, line, message) {
  findings.push({ level: 'ERROR', path: filePath, line: line || 0, message });
}
function warn(filePath, line, message) {
  findings.push({ level: 'WARN', path: filePath, line: line || 0, message });
}

function rel(p) {
  if (typeof p !== 'string' || p === '') return String(p);
  const r = path.relative(ROOT, p);
  return r === '' ? path.basename(p) : r;
}

// ---------------------------------------------------------------------------
// Minimal draft-07 subset schema walker (no AJV).
//
// Supports: type, required, properties, additionalProperties:false,
// items, enum, pattern, minimum, maximum, minLength, minItems, minProperties,
// uniqueItems, propertyNames.enum. Reports errors as JSON-path strings.
// ---------------------------------------------------------------------------

function jsType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v; // 'object' | 'string' | 'number' | 'boolean'
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

/**
 * Validate `value` against draft-07-subset `schema`. Pushes "instancePath: msg"
 * strings into `out`. `dataPath` is the running JSON pointer for messages.
 */
function validateSchema(value, schema, dataPath, out) {
  if (!schema || typeof schema !== 'object') return;

  // type
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    out.push(`${dataPath || '(root)'}: expected type ${JSON.stringify(schema.type)}, got ${jsType(value)}`);
    return; // a type mismatch makes deeper checks meaningless
  }

  // enum
  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((e) => deepEqual(e, value));
    if (!ok) out.push(`${dataPath || '(root)'}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  // string constraints
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      out.push(`${dataPath}: string shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.pattern === 'string') {
      let re;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        re = null;
      }
      if (re && !re.test(value)) {
        out.push(`${dataPath}: string ${JSON.stringify(value)} does not match pattern /${schema.pattern}/`);
      }
    }
  }

  // numeric constraints
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      out.push(`${dataPath}: value ${value} below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      out.push(`${dataPath}: value ${value} above maximum ${schema.maximum}`);
    }
  }

  // array constraints
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      out.push(`${dataPath}: array has ${value.length} items, fewer than minItems ${schema.minItems}`);
    }
    if (schema.uniqueItems === true) {
      const seen = [];
      for (const item of value) {
        if (seen.some((s) => deepEqual(s, item))) {
          out.push(`${dataPath}: array has duplicate item ${JSON.stringify(item)}`);
          break;
        }
        seen.push(item);
      }
    }
    if (schema.items) {
      value.forEach((item, idx) => validateSchema(item, schema.items, `${dataPath}[${idx}]`, out));
    }
  }

  // object constraints
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);

    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      out.push(`${dataPath || '(root)'}: object has ${keys.length} properties, fewer than minProperties ${schema.minProperties}`);
    }

    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(req in value)) {
          out.push(`${dataPath || '(root)'}: missing required property '${req}'`);
        }
      }
    }

    // propertyNames.enum
    if (schema.propertyNames && Array.isArray(schema.propertyNames.enum)) {
      for (const k of keys) {
        if (!schema.propertyNames.enum.includes(k)) {
          out.push(`${dataPath || '(root)'}: property name '${k}' not in allowed ${JSON.stringify(schema.propertyNames.enum)}`);
        }
      }
    }

    const props = schema.properties || {};
    for (const k of keys) {
      const childPath = `${dataPath}.${k}`;
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        validateSchema(value[k], props[k], childPath, out);
      } else if (schema.additionalProperties === false) {
        out.push(`${dataPath || '(root)'}: additional property '${k}' not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateSchema(value[k], schema.additionalProperties, childPath, out);
      }
    }

    // required props that are objects/arrays still validated above via properties loop
    for (const k of Object.keys(props)) {
      if (k in value) continue; // already handled
      // nothing: absence handled by `required`
    }
  }
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

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, error: `cannot read: ${e.message}` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e.message}` };
  }
}

// Component-kind -> function mapping a component name to the asset path(s) it
// would resolve to once the asset dirs are populated. Returns an array of
// candidate ABSOLUTE paths; the component resolves if ANY candidate exists.
function componentCandidates(kind, name) {
  switch (kind) {
    case 'agents':
      return [path.join(ROOT, 'agents', `${name}.md`)];
    case 'skills':
      return [path.join(ROOT, 'skills', name, 'SKILL.md')];
    case 'commands':
      return [path.join(ROOT, 'commands', `${name}.md`)];
    case 'rules':
      // rules live under rules/** — match any nesting depth.
      return globMatch(path.join(ROOT, 'rules'), `${name}.md`);
    case 'bundles':
      return [path.join(ROOT, 'bundles', `${name}.md`)];
    case 'workflows':
      // a workflow's component file is its .md (the optional sibling .js is not a
      // separate component); kept in lock-step with resolve-kind.mjs.
      return [path.join(ROOT, 'workflows', `${name}.md`)];
    case 'mcp':
      // an mcp component is a JSON config snippet: mcp/<name>.json (NOT markdown);
      // kept in lock-step with resolve-kind.mjs.
      return [path.join(ROOT, 'mcp', `${name}.json`)];
    case 'validators':
      return [path.join(ROOT, 'lint', `${name}.mjs`)];
    case 'engine':
      // engine names are repo-relative-ish "bootstrap/detect-project"
      return [path.join(ROOT, `${name}.mjs`)];
    case 'hooks':
      // hooks are identified by id (e.g. "detect-project@SessionStart") and live
      // in hooks/hooks.json, not as individual files. Resolution = the id's base
      // name appears as a hook in hooks/hooks.json (best-effort).
      return ['__HOOK__'];
    default:
      return [];
  }
}

// Recursively find any file named `fileName` under `dir`. Returns matched paths.
function globMatch(dir, fileName) {
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === fileName) out.push(full);
    }
  }
  walk(dir);
  // If the dir doesn't exist / nothing matched, still return the canonical
  // top-level candidate so the WARN message names a concrete expected path.
  if (out.length === 0) return [path.join(dir, fileName)];
  return out;
}

// Collect hook ids declared in hooks/hooks.json (best-effort, fail-soft).
function loadDeclaredHookIds() {
  const ids = new Set();
  const hooksFile = path.join(ROOT, 'hooks', 'hooks.json');
  const r = readJson(hooksFile);
  if (!r.ok) return ids;
  const root = r.value || {};
  const eventMap = root.hooks && typeof root.hooks === 'object' ? root.hooks : root;
  for (const [eventName, groups] of Object.entries(eventMap)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (g && typeof g.id === 'string') {
        // ids look like "forge:detect-project"; record bare and namespaced forms.
        ids.add(g.id);
        const bare = g.id.includes(':') ? g.id.split(':').pop() : g.id;
        ids.add(bare);
        ids.add(`${bare}@${eventName}`);
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const modulesPath = path.join(ROOT, 'manifests', 'modules.json');
  const profilesPath = path.join(ROOT, 'manifests', 'profiles.json');
  const modulesSchemaPath = path.join(ROOT, 'schemas', 'modules.schema.json');
  const profilesSchemaPath = path.join(ROOT, 'schemas', 'profiles.schema.json');

  // --- Absence of the manifests is not, by itself, an Phase-2 build error, but
  // a Forge repo without manifests is degenerate; treat a missing manifest as an
  // ERROR since these are the composition source of truth (and they exist today).
  const modulesR = readJson(modulesPath);
  const profilesR = readJson(profilesPath);
  const modulesSchemaR = readJson(modulesSchemaPath);
  const profilesSchemaR = readJson(profilesSchemaPath);

  if (!modulesR.ok) err(modulesPath, 0, modulesR.error);
  if (!profilesR.ok) err(profilesPath, 0, profilesR.error);
  if (!modulesSchemaR.ok) err(modulesSchemaPath, 0, modulesSchemaR.error);
  if (!profilesSchemaR.ok) err(profilesSchemaPath, 0, profilesSchemaR.error);

  // --- STRUCTURAL: validate each manifest against its schema ---
  if (modulesR.ok && modulesSchemaR.ok) {
    const out = [];
    validateSchema(modulesR.value, modulesSchemaR.value, '', out);
    for (const m of out) err(modulesPath, 0, `schema: ${m}`);
  }
  if (profilesR.ok && profilesSchemaR.ok) {
    const out = [];
    validateSchema(profilesR.value, profilesSchemaR.value, '', out);
    for (const m of out) err(profilesPath, 0, `schema: ${m}`);
  }

  // --- SEMANTIC checks require both manifests to have parsed ---
  if (modulesR.ok && profilesR.ok) {
    const modules = modulesR.value.modules || {};
    const moduleNames = new Set(Object.keys(modules));
    const profiles = profilesR.value.profiles || {};
    const componentKinds = Array.isArray(modulesR.value.componentKinds)
      ? new Set(modulesR.value.componentKinds)
      : new Set();

    // defaultProfile must be a real profile
    const defaultProfile = profilesR.value.defaultProfile;
    if (defaultProfile && !(defaultProfile in profiles)) {
      err(profilesPath, 0, `defaultProfile '${defaultProfile}' is not defined in profiles`);
    }

    // every profile's modules must exist in modules.json
    for (const [pName, pDef] of Object.entries(profiles)) {
      const mods = Array.isArray(pDef.modules) ? pDef.modules : [];
      for (const m of mods) {
        if (!moduleNames.has(m)) {
          err(profilesPath, 0, `profile '${pName}' references unknown module '${m}' (not in modules.json)`);
        }
      }
    }

    // moduleSelectionRules.add/.drop must name real modules
    const rules = profilesR.value.moduleSelectionRules || {};
    for (const bucket of ['add', 'drop']) {
      const arr = Array.isArray(rules[bucket]) ? rules[bucket] : [];
      arr.forEach((rule, idx) => {
        if (rule && typeof rule.module === 'string' && !moduleNames.has(rule.module)) {
          err(
            profilesPath,
            0,
            `moduleSelectionRules.${bucket}[${idx}] references unknown module '${rule.module}' (not in modules.json)`
          );
        }
      });
    }

    // module component keys must be members of componentKinds
    for (const [mName, mDef] of Object.entries(modules)) {
      const comps = mDef && mDef.components ? mDef.components : {};
      for (const kind of Object.keys(comps)) {
        if (componentKinds.size > 0 && !componentKinds.has(kind)) {
          err(modulesPath, 0, `module '${mName}' uses component kind '${kind}' not declared in componentKinds`);
        }
      }
    }

    // --- FORWARD-LOOKING: every component should resolve to a real asset file.
    // Phase 2: asset dirs are empty -> WARN "(planned)". --strict -> ERROR.
    const declaredHookIds = loadDeclaredHookIds();
    const emit = STRICT ? err : warn;

    for (const [mName, mDef] of Object.entries(modules)) {
      const comps = mDef && mDef.components ? mDef.components : {};
      for (const [kind, names] of Object.entries(comps)) {
        if (!Array.isArray(names)) continue;
        for (const name of names) {
          if (kind === 'hooks') {
            // hooks resolve against hooks/hooks.json ids. Strip "@Event" suffix.
            const base = String(name).split('@')[0];
            const resolved =
              declaredHookIds.has(name) ||
              declaredHookIds.has(base) ||
              declaredHookIds.has(`forge:${base}`);
            if (!resolved) {
              emit(
                modulesPath,
                0,
                `module '${mName}' hook '${name}' not declared in hooks/hooks.json (planned)`
              );
            }
            continue;
          }
          const candidates = componentCandidates(kind, name);
          // Unknown component kind => no resolution mapping. It's already reported
          // as a componentKinds violation above; don't also crash on it here.
          if (candidates.length === 0) continue;
          const resolved = candidates.some((c) => c !== '__HOOK__' && fs.existsSync(c));
          if (!resolved) {
            const shown = candidates[0] ? rel(candidates[0]) : `${kind}/${name}`;
            emit(
              modulesPath,
              0,
              `module '${mName}' component ${kind}:'${name}' does not resolve to an asset file (expected ${shown}) (planned)`
            );
          }
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

  // stable order: errors first, then warns, by path then message
  const ordered = [...errors, ...warns].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });

  for (const f of ordered) {
    console.log(`${f.level} ${rel(f.path)}:${f.line} ${f.message}`);
  }

  const planned = warns.length;
  console.log(
    `\n${NAME}: ${errors.length} error(s), ${warns.length} warning(s)` +
      (planned > 0 && !STRICT ? ` (${planned} planned-asset warning(s); run with --strict to enforce)` : '')
  );

  if (errors.length > 0) {
    console.log(`${NAME}: FAIL`);
    process.exit(1);
  }
  console.log(`${NAME}: PASS`);
  process.exit(0);
}

main();
