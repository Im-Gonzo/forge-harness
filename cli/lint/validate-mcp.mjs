#!/usr/bin/env node
/**
 * validate-mcp — lint Forge's own catalog of available MCP server configs.
 *
 * An mcp component is a Model Context Protocol server config snippet stored as JSON
 * (NOT markdown): `mcp/<name>.json`. It is the catalog of AVAILABLE MCP servers;
 * enablement / merging into a project's settings is a SEPARATE later change and is
 * NOT validated here.
 *
 * Chosen, documented shape (the `mcpServers`-wrapped form):
 *   {
 *     "mcpServers": {
 *       "<name>": { "command": "...", "args": [ ... ], ... }
 *     }
 *   }
 *
 * For each `mcp/*.json` at the plugin root:
 *   - non-empty, readable
 *   - valid JSON (parse error -> ERROR)
 *   - top level is a JSON object
 *   - has a `mcpServers` object that is non-empty
 *   - each server entry is an object with a non-empty string `command`
 *   - if present, a server's `args` must be an array of strings (WARN otherwise)
 *
 * Absence of the mcp/ dir (or no *.json) is NOT an error.
 *
 * Invocation: node lint/validate-mcp.mjs [--strict] [rootDir]
 * Zero dependencies; self-contained. Mirrors lint/validate-workflows.mjs.
 *
 * NOTE: mcp/*.json files are PLAIN JSON — they must NOT carry a leading UTF-8 BOM
 * (check-unicode-safety flags a raw BOM). If a BOM ever needs to appear in a string
 * literal here, write it as the JS escape backslash-u-FEFF, never as a raw byte.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- argument parsing ------------------------------------------------------

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const positional = args.filter(a => !a.startsWith('--'));
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = positional[0]
  ? path.resolve(positional[0])
  : path.resolve(SELF_DIR, '..');

const MCP_DIR = path.join(ROOT, 'mcp');

// ---- validation ------------------------------------------------------------

const errors = [];
const warnings = [];

function err(loc, msg) { errors.push(`ERROR  ${loc}  ${msg}`); }
function warn(loc, msg) { warnings.push(`WARN  ${loc}  ${msg}`); }

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateMcp(file) {
  const rel = path.join('mcp', file);
  const filePath = path.join(MCP_DIR, file);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    err(rel, `unreadable: ${e.message}`);
    return;
  }

  if (content.trim().length === 0) {
    err(rel, 'empty mcp config file');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    err(`${rel}:1`, `invalid JSON: ${e.message}`);
    return;
  }

  if (!isPlainObject(parsed)) {
    err(rel, 'top-level value must be a JSON object');
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, 'mcpServers')) {
    err(rel, "missing required key: 'mcpServers'");
    return;
  }
  const servers = parsed.mcpServers;
  if (!isPlainObject(servers)) {
    err(rel, "'mcpServers' must be an object");
    return;
  }
  const names = Object.keys(servers);
  if (names.length === 0) {
    err(rel, "'mcpServers' is empty (declare at least one server)");
    return;
  }

  for (const name of names) {
    const loc = `${rel} (mcpServers.${name})`;
    const def = servers[name];
    if (!isPlainObject(def)) {
      err(loc, 'server definition must be an object');
      continue;
    }
    const cmd = def.command;
    if (typeof cmd !== 'string' || cmd.trim().length === 0) {
      err(loc, "server is missing a non-empty string 'command'");
    }
    if (Object.prototype.hasOwnProperty.call(def, 'args')) {
      const a = def.args;
      if (!Array.isArray(a) || a.some(x => typeof x !== 'string')) {
        warn(loc, "'args' should be an array of strings");
      }
    }
  }
}

function main() {
  if (!fs.existsSync(MCP_DIR) || !fs.statSync(MCP_DIR).isDirectory()) {
    console.log('no mcp configs found (mcp/ absent) — nothing to validate');
    process.exit(0);
  }

  const files = fs.readdirSync(MCP_DIR).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log('no mcp configs found (mcp/ empty) — nothing to validate');
    process.exit(0);
  }

  for (const file of files) validateMcp(file);

  for (const line of errors) console.error(line);
  for (const line of warnings) console.warn(line);

  const failed = errors.length > 0 || (STRICT && warnings.length > 0);
  console.log(
    `validate-mcp: ${files.length} mcp config file(s), ${errors.length} error(s), ${warnings.length} warning(s) — ${failed ? 'FAIL' : 'PASS'}`
  );
  process.exit(failed ? 1 : 0);
}

main();
