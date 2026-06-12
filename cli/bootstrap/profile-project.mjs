#!/usr/bin/env node
// @ts-check
/**
 * Forge — Step 1: PROFILE (deterministic fact collection).
 *
 * Scans a target repository READ-ONLY and emits a pure-JSON facts document.
 * This script makes NO decisions: it gathers signals exhaustively and reports
 * them. The `bootstrap-harness` skill (LLM) composes a profile from these facts
 * (see docs/BOOTSTRAP.md §"Step 2 — Compose" and docs/METHOD.md §7).
 *
 * Output field names match docs/BOOTSTRAP.md §"Step 1 — Profile" EXACTLY:
 *   languages, packageManager, frameworks, testRunner, database, lintFormat,
 *   monorepo, ci, commands, docs   (+ hasTests, intended; both used by
 *   moduleSelectionRules).
 *
 * `intended` is a spec-aware HINT (not a materialized fact): it scans prose in the
 * detected doc/spec dirs + root doc files for stack KEYWORDS (e.g. "FastAPI",
 * "PostgreSQL", "Next.js") so a spec-first project whose code doesn't exist yet
 * still nudges the composer toward the right profile. It is kept STRICTLY separate
 * from the materialized `languages`/`frameworks`/`database` facts and is never
 * merged into them.
 *
 * Conventions: Node ESM, single file, ZERO dependencies (node: builtins only).
 * Robustness: missing files are normal. Never throw on absent files; fail open
 * with sensible empty defaults so the caller always gets a valid JSON document.
 *
 * Usage:
 *   node profile-project.mjs [targetDir] [--write]
 *
 *   targetDir : positional arg, else $CLAUDE_PROJECT_DIR, else process.cwd().
 *   --write   : also write <targetDir>/.claude/profile-project.json
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------------------
// Tiny fail-open filesystem helpers. None of these ever throw.
// ---------------------------------------------------------------------------

/** @param {string} p */
function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** @param {string} p */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} p */
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** @param {string} p @returns {string} */
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** @param {string} p @returns {any} */
function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string} p @returns {fs.Dirent[]} */
function readDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Directories we never descend into when sampling the tree.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  'env',
  '.env',
  '__pycache__',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
  '.tox',
  'target',
  'vendor',
  '.idea',
  '.vscode',
  '.gradle',
  'tmp',
]);

/**
 * Walk the tree shallowly + bounded, collecting facts via a visitor. We cap the
 * number of directories visited so we never traverse a pathological tree, and we
 * never descend into SKIP_DIRS. Read-only throughout.
 *
 * @param {string} root
 * @param {(dirent: fs.Dirent, full: string, depth: number) => void} visit
 * @param {{maxDirs?: number, maxDepth?: number}} [opts]
 */
function walk(root, visit, opts = {}) {
  const maxDirs = opts.maxDirs ?? 4000;
  const maxDepth = opts.maxDepth ?? 8;
  let dirsSeen = 0;
  /** @type {Array<{dir: string, depth: number}>} */
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (dirsSeen++ > maxDirs) break;
    if (depth > maxDepth) continue;
    for (const dirent of readDir(dir)) {
      const full = path.join(dir, dirent.name);
      try {
        visit(dirent, full, depth);
      } catch {
        /* a misbehaving visitor must not abort the walk */
      }
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue;
        if (dirent.name.startsWith('.') && depth >= 1) {
          // Don't descend into nested dotdirs (e.g. atlas/.next handled above,
          // but also generic hidden caches). Top-level dotdirs like .github are
          // probed explicitly elsewhere.
          continue;
        }
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
}

/** @template T @param {T[]} arr @returns {T[]} */
function uniq(arr) {
  return [...new Set(arr)];
}

// ---------------------------------------------------------------------------
// Main detection
// ---------------------------------------------------------------------------

/** @param {string} targetDir */
function profile(targetDir) {
  const root = path.resolve(targetDir);

  // -- gathered raw signals ------------------------------------------------
  // `manifestLangs` are languages confirmed by a project descriptor (pyproject,
  // package.json/tsconfig, Cargo.toml, go.mod, …) — strong signal, always kept.
  // `langFileCounts` tallies source-extension hits; a language is only promoted
  // from file evidence alone if it clears LANG_FILE_THRESHOLD, so a single stray
  // fixture (e.g. one .swift utility) doesn't pollute the result.
  const LANG_FILE_THRESHOLD = 3;
  const manifestLangs = new Set();
  /** @type {Record<string, number>} */
  const langFileCounts = {};
  const bumpLang = (lang) => {
    langFileCounts[lang] = (langFileCounts[lang] || 0) + 1;
  };
  // `languages` (the final Set) is assembled AFTER the walk from manifestLangs +
  // thresholded file counts; see the promotion block below.
  const frameworks = new Set();
  const testRunner = new Set();
  const lintFormat = new Set();

  /** @type {{python?: string, node?: string}} */
  const packageManager = {};

  // Aggregated dependency name set across every package.json / pyproject found.
  const nodeDeps = new Set(); // dependency NAMES (deps + devDeps)
  const nodeScripts = new Set(); // raw script command strings
  const nodeScriptNames = new Set(); // script keys (test, lint, ...)
  const pyDeps = new Set(); // python dependency NAMES (lowercased)
  const pyConfigText = []; // raw pyproject text blobs for [tool.*] probing

  let monorepo = false;
  const monorepoSignals = [];
  let database = null;
  const databaseSignals = [];
  let hasTests = false;

  // -- top-level signal files ---------------------------------------------
  const rootHas = (name) => exists(path.join(root, name));

  // ---- Python project descriptors ----
  const pyprojectPath = path.join(root, 'pyproject.toml');
  const hasPyproject = isFile(pyprojectPath);
  const hasSetupPy = rootHas('setup.py');
  const hasSetupCfg = rootHas('setup.cfg');
  const hasRequirements = rootHas('requirements.txt');
  if (hasPyproject || hasSetupPy || hasSetupCfg || hasRequirements) {
    manifestLangs.add('python');
  }
  if (hasPyproject) {
    const txt = readText(pyprojectPath);
    pyConfigText.push(txt);
    for (const name of parsePyprojectDeps(txt)) pyDeps.add(name);
  }
  if (hasRequirements) {
    for (const name of parseRequirements(readText(path.join(root, 'requirements.txt')))) {
      pyDeps.add(name);
    }
  }
  // setup.cfg can carry [options]/install_requires + tool sections.
  if (hasSetupCfg) pyConfigText.push(readText(path.join(root, 'setup.cfg')));

  // ---- Python package manager ----
  if (rootHas('uv.lock')) packageManager.python = 'uv';
  else if (rootHas('poetry.lock')) packageManager.python = 'poetry';
  else if (rootHas('Pipfile.lock') || rootHas('Pipfile')) packageManager.python = 'pipenv';
  else if (hasPyproject || hasSetupPy || hasSetupCfg) packageManager.python = 'pip';
  else if (hasRequirements) packageManager.python = 'pip';
  // pyproject [tool.uv]/[tool.poetry] reinforce the lockfile signal.
  if (!packageManager.python || packageManager.python === 'pip') {
    const blob = pyConfigText.join('\n');
    if (/\[tool\.uv\b/.test(blob)) packageManager.python = 'uv';
    else if (/\[tool\.poetry\b/.test(blob)) packageManager.python = 'poetry';
  }

  // ---- Node project descriptors (root + nested) ----
  /** @type {string[]} */
  const packageJsonPaths = [];
  // Always probe the root package.json first.
  const rootPkgPath = path.join(root, 'package.json');
  if (isFile(rootPkgPath)) packageJsonPaths.push(rootPkgPath);

  // ---- Lockfiles + workspace/monorepo signals (root) ----
  const rootPmField = (() => {
    const p = readJson(rootPkgPath);
    return p && typeof p.packageManager === 'string' ? p.packageManager : '';
  })();
  // packageManager field (corepack) is the strongest node PM signal.
  const fromCorepack = /^(\w+)@/.exec(rootPmField);
  // Lockfiles, in priority order.
  const nodePmByLock =
    (rootHas('bun.lockb') && 'bun') ||
    (rootHas('pnpm-lock.yaml') && 'pnpm') ||
    (rootHas('yarn.lock') && 'yarn') ||
    (rootHas('package-lock.json') && 'npm') ||
    (rootHas('npm-shrinkwrap.json') && 'npm') ||
    null;

  // Collected during the single tree walk.
  let sampledFiles = 0;
  const dirNamesSeen = new Set();
  /** @type {string[]} */
  const nestedLockfiles = []; // node lockfiles found below root
  // Distinct directories that own a build manifest (package.json, Cargo.toml,
  // pyproject.toml, go.mod, …). ≥2 of these ⇒ a (poly)monorepo.
  const projectRootDirs = new Set();
  let sawTsconfig = rootHas('tsconfig.json');

  // ---- Single read-only tree walk: extensions, nested manifests, db/ci/test ----
  walk(root, (dirent, full, depth) => {
    if (dirent.isDirectory()) {
      dirNamesSeen.add(dirent.name.toLowerCase());
      const dn = dirent.name.toLowerCase();
      if (dn === 'alembic' || dn === 'prisma') databaseSignals.push(`${dn}/`);
      if (dn === 'migrations') databaseSignals.push('migrations/');
      return;
    }
    const name = dirent.name;
    // package.json / lockfiles inside a tooling dotdir (.opencode, .github, …)
    // are config, not real workspace members; ignore them for project facts.
    const underDotDir = path
      .relative(root, full)
      .split(path.sep)
      .slice(0, -1)
      .some((seg) => seg.startsWith('.'));

    // nested package.json (monorepo signal + extra dep harvesting)
    if (name === 'package.json' && depth >= 1 && !underDotDir) {
      packageJsonPaths.push(full);
      projectRootDirs.add(path.dirname(full));
    }

    // tsconfig anywhere → typescript project (ignore those inside dotdirs)
    if ((name === 'tsconfig.json' || /^tsconfig\..+\.json$/.test(name)) && !underDotDir) {
      sawTsconfig = true;
    }

    // nested node lockfiles (for repos whose node app lives in a subdir)
    if (
      depth >= 1 &&
      !underDotDir &&
      ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb'].includes(name)
    ) {
      nestedLockfiles.push(full);
    }

    // other-language manifests (authoritative — bypass the file-count threshold).
    // Also record the OWNING directory so we can recognize polyglot monorepos
    // (several independent project roots living under one repo).
    let manifestLang = '';
    if (name === 'Cargo.toml') manifestLang = 'rust';
    else if (name === 'go.mod') manifestLang = 'go';
    else if (name === 'Gemfile') manifestLang = 'ruby';
    else if (name === 'composer.json') manifestLang = 'php';
    else if (name === 'pom.xml' || name === 'build.gradle' || name === 'build.gradle.kts') {
      manifestLang = 'java';
    } else if (name === 'pyproject.toml' || name === 'setup.py') {
      manifestLang = 'python';
    }
    if (manifestLang && !underDotDir) {
      manifestLangs.add(manifestLang);
      projectRootDirs.add(path.dirname(full));
    }

    // extension sampling for language detection (counted, then thresholded)
    if (sampledFiles < 20000) {
      const ext = path.extname(name).toLowerCase();
      switch (ext) {
        case '.ts': case '.tsx': case '.mts': case '.cts':
          bumpLang('typescript'); sampledFiles++; break;
        case '.js': case '.jsx': case '.mjs': case '.cjs':
          bumpLang('javascript'); sampledFiles++; break;
        case '.py': case '.pyi':
          bumpLang('python'); sampledFiles++; break;
        case '.go': bumpLang('go'); sampledFiles++; break;
        case '.rs': bumpLang('rust'); sampledFiles++; break;
        case '.rb': bumpLang('ruby'); sampledFiles++; break;
        case '.java': bumpLang('java'); sampledFiles++; break;
        case '.kt': case '.kts': bumpLang('kotlin'); sampledFiles++; break;
        case '.php': bumpLang('php'); sampledFiles++; break;
        case '.cs': bumpLang('csharp'); sampledFiles++; break;
        case '.swift': bumpLang('swift'); sampledFiles++; break;
        case '.sql': databaseSignals.push('*.sql'); break;
        default: break;
      }
    }
  });

  // ---- Promote languages: manifest-confirmed OR over the file threshold ----
  const languages = new Set(manifestLangs);
  if (sawTsconfig) languages.add('typescript');
  for (const [lang, count] of Object.entries(langFileCounts)) {
    if (manifestLangs.has(lang) || count >= LANG_FILE_THRESHOLD) languages.add(lang);
  }
  // package.json present (root or nested) confirms a node/JS project even if the
  // sampled sources are all .ts (typescript already added) — keep js if any .js.

  // ---- Non-node manifest package managers ----
  if (manifestLangs.has('rust')) packageManager.rust = 'cargo';
  if (manifestLangs.has('go')) packageManager.go = 'go';
  if (manifestLangs.has('ruby')) packageManager.ruby = 'bundler';

  // ---- Harvest dependencies/scripts from every package.json found ----
  for (const pkgPath of uniq(packageJsonPaths)) {
    const pkg = readJson(pkgPath);
    if (!pkg) continue;
    for (const k of Object.keys(pkg.dependencies || {})) nodeDeps.add(k);
    for (const k of Object.keys(pkg.devDependencies || {})) nodeDeps.add(k);
    for (const k of Object.keys(pkg.peerDependencies || {})) nodeDeps.add(k);
    // npm/yarn/pnpm workspaces field is a monorepo signal.
    if (pkg.workspaces) {
      monorepo = true;
      monorepoSignals.push(
        `workspaces in ${path.relative(root, pkgPath) || 'package.json'}`,
      );
    }
  }

  // ---- Choose the PRIMARY node project ----
  // The package.json whose scripts/lockfile drive `commands` + packageManager.node.
  // Root wins if present; otherwise the shallowest nested one (e.g. v2's atlas/).
  const allPkgs = uniq(packageJsonPaths);
  let primaryPkgPath = isFile(rootPkgPath) ? rootPkgPath : null;
  if (!primaryPkgPath && allPkgs.length) {
    primaryPkgPath = [...allPkgs].sort((a, b) => {
      const da = path.relative(root, a).split(path.sep).length;
      const db = path.relative(root, b).split(path.sep).length;
      return da - db || a.localeCompare(b);
    })[0];
  }
  const primaryPkgDir = primaryPkgPath ? path.dirname(primaryPkgPath) : root;

  // Scripts come from the primary package.json only.
  if (primaryPkgPath) {
    const ppkg = readJson(primaryPkgPath) || {};
    for (const [k, v] of Object.entries(ppkg.scripts || {})) {
      nodeScriptNames.add(k);
      if (typeof v === 'string') nodeScripts.add(v);
    }
  }

  const hasAnyNodePkg = allPkgs.length > 0 || sawTsconfig;

  // ---- Node package manager resolution ----
  // Prefer a corepack field on the primary pkg, then a lockfile colocated with it,
  // then any root/nested lockfile, then config files, then npm as the fallback.
  if (hasAnyNodePkg) {
    const primaryCorepack = (() => {
      const p = primaryPkgPath ? readJson(primaryPkgPath) : null;
      const f = p && typeof p.packageManager === 'string' ? p.packageManager : '';
      return /^(\w+)@/.exec(f);
    })();
    const pmFromDir = (dir) =>
      (exists(path.join(dir, 'bun.lockb')) && 'bun') ||
      (exists(path.join(dir, 'pnpm-lock.yaml')) && 'pnpm') ||
      (exists(path.join(dir, 'yarn.lock')) && 'yarn') ||
      (exists(path.join(dir, 'package-lock.json')) && 'npm') ||
      (exists(path.join(dir, 'npm-shrinkwrap.json')) && 'npm') ||
      null;
    const pmFromNested = (() => {
      for (const lf of nestedLockfiles) {
        const base = path.basename(lf);
        if (base === 'bun.lockb') return 'bun';
        if (base === 'pnpm-lock.yaml') return 'pnpm';
        if (base === 'yarn.lock') return 'yarn';
        if (base === 'package-lock.json') return 'npm';
      }
      return null;
    })();

    packageManager.node =
      (fromCorepack && fromCorepack[1]) ||
      (primaryCorepack && primaryCorepack[1]) ||
      nodePmByLock ||
      pmFromDir(primaryPkgDir) ||
      pmFromNested ||
      ((rootHas('.yarnrc.yml') || rootHas('.yarnrc')) && 'yarn') ||
      (rootHas('pnpm-workspace.yaml') && 'pnpm') ||
      'npm';
  }

  // ---- Monorepo signals ----
  if (rootHas('pnpm-workspace.yaml')) {
    monorepo = true;
    monorepoSignals.push('pnpm-workspace.yaml');
  }
  if (rootHas('turbo.json')) {
    monorepo = true;
    monorepoSignals.push('turbo.json');
  }
  if (rootHas('lerna.json')) {
    monorepo = true;
    monorepoSignals.push('lerna.json');
  }
  if (rootHas('nx.json')) {
    monorepo = true;
    monorepoSignals.push('nx.json');
  }
  if (rootHas('rush.json')) {
    monorepo = true;
    monorepoSignals.push('rush.json');
  }
  // apps/ + packages/ convention
  if (isDir(path.join(root, 'apps')) && isDir(path.join(root, 'packages'))) {
    monorepo = true;
    monorepoSignals.push('apps/ + packages/');
  }
  // multiple distinct project roots (each owning a build manifest) → monorepo.
  // Covers both same-ecosystem workspaces and polyglot repos (e.g. a Rust crate +
  // a Python package + a Node app side by side).
  if (isFile(rootPkgPath) || hasPyproject || hasSetupPy || rootHas('Cargo.toml') || rootHas('go.mod')) {
    projectRootDirs.add(root);
  }
  if (projectRootDirs.size >= 2) {
    monorepo = true;
    monorepoSignals.push(`${projectRootDirs.size} project roots with build manifests`);
  }

  // ---- Frameworks (from harvested deps) ----
  // Python frameworks
  const pyHas = (name) => pyDeps.has(name);
  if (pyHas('fastapi')) frameworks.add('fastapi');
  if (pyHas('pydantic')) frameworks.add('pydantic');
  if (pyHas('django')) frameworks.add('django');
  if (pyHas('flask')) frameworks.add('flask');
  if (pyHas('starlette') && !frameworks.has('fastapi')) frameworks.add('starlette');
  if (pyHas('sqlalchemy')) frameworks.add('sqlalchemy');
  if (pyHas('litestar')) frameworks.add('litestar');
  // Node frameworks
  const ndHas = (name) => nodeDeps.has(name);
  if (ndHas('next')) frameworks.add('next');
  if (ndHas('react') || ndHas('react-dom')) frameworks.add('react');
  if (ndHas('vue')) frameworks.add('vue');
  if (ndHas('svelte') || ndHas('@sveltejs/kit')) frameworks.add('svelte');
  if (ndHas('@angular/core')) frameworks.add('angular');
  if (ndHas('solid-js')) frameworks.add('solid');
  if (ndHas('astro')) frameworks.add('astro');
  if (ndHas('express')) frameworks.add('express');
  if (ndHas('fastify')) frameworks.add('fastify');
  if (ndHas('@nestjs/core')) frameworks.add('nestjs');
  if (ndHas('nuxt')) frameworks.add('nuxt');

  // ---- Test runners ----
  const pyBlob = pyConfigText.join('\n');
  // pytest: config section, dep, or config files
  if (
    pyHas('pytest') ||
    /\[tool\.pytest\b/.test(pyBlob) ||
    /\[pytest\]/.test(pyBlob) ||
    rootHas('pytest.ini') ||
    rootHas('tox.ini') ||
    rootHas('conftest.py') ||
    dirNamesSeen.has('tests') ||
    findFirst(root, ['conftest.py', 'tests/conftest.py'])
  ) {
    if (languages.has('python') && (pyHas('pytest') || /pytest/.test(pyBlob) || rootHas('pytest.ini') || rootHas('conftest.py') || findFirst(root, ['conftest.py', 'tests/conftest.py']))) {
      testRunner.add('pytest');
    }
  }
  if (pyHas('unittest') === false && /\bunittest\b/.test(pyBlob)) {
    // rarely declared; ignore unless explicit
  }
  // Node test runners (deps + script commands)
  const scriptBlob = [...nodeScripts].join('\n');
  if (ndHas('vitest') || /\bvitest\b/.test(scriptBlob)) testRunner.add('vitest');
  if (ndHas('jest') || ndHas('ts-jest') || /\bjest\b/.test(scriptBlob)) testRunner.add('jest');
  if (ndHas('@playwright/test') || ndHas('playwright') || /\bplaywright\b/.test(scriptBlob)) {
    testRunner.add('playwright');
  }
  if (ndHas('mocha') || /\bmocha\b/.test(scriptBlob)) testRunner.add('mocha');
  if (ndHas('@cypress/react') || ndHas('cypress') || /\bcypress\b/.test(scriptBlob)) {
    testRunner.add('cypress');
  }
  if (ndHas('ava') || /\bava\b/.test(scriptBlob)) testRunner.add('ava');
  if (ndHas('@japa/runner')) testRunner.add('japa');

  // Note: 'spec'/'specs' are deliberately EXCLUDED — in spec-driven repos those
  // hold specifications (already captured under docs.specs), not test suites.
  hasTests =
    testRunner.size > 0 ||
    dirNamesSeen.has('tests') ||
    dirNamesSeen.has('test') ||
    dirNamesSeen.has('__tests__') ||
    dirNamesSeen.has('e2e');

  // ---- Lint / format tools ----
  // Python
  if (pyHas('ruff') || /\[tool\.ruff\b/.test(pyBlob) || rootHas('ruff.toml') || rootHas('.ruff.toml')) {
    lintFormat.add('ruff');
  }
  if (pyHas('black') || /\[tool\.black\b/.test(pyBlob)) lintFormat.add('black');
  if (pyHas('mypy') || /\[tool\.mypy\b/.test(pyBlob) || rootHas('mypy.ini') || rootHas('.mypy.ini')) {
    lintFormat.add('mypy');
  }
  if (pyHas('flake8') || rootHas('.flake8') || /\[flake8\]/.test(pyBlob)) lintFormat.add('flake8');
  if (pyHas('isort') || /\[tool\.isort\b/.test(pyBlob)) lintFormat.add('isort');
  if (pyHas('pyright') || rootHas('pyrightconfig.json')) lintFormat.add('pyright');
  // Node — eslint
  if (
    ndHas('eslint') ||
    hasGlobAtRoot(root, /^\.eslintrc(\..+)?$/) ||
    hasGlobAtRoot(root, /^eslint\.config\.(js|mjs|cjs|ts)$/)
  ) {
    lintFormat.add('eslint');
  }
  // prettier
  if (
    ndHas('prettier') ||
    hasGlobAtRoot(root, /^\.prettierrc(\..+)?$/) ||
    hasGlobAtRoot(root, /^prettier\.config\.(js|mjs|cjs)$/)
  ) {
    lintFormat.add('prettier');
  }
  // biome
  if (ndHas('@biomejs/biome') || rootHas('biome.json') || rootHas('biome.jsonc')) {
    lintFormat.add('biome');
  }

  // ---- Database ----
  // alembic.ini / config
  if (rootHas('alembic.ini')) databaseSignals.push('alembic.ini');
  // dependency-based DB driver signals
  const dbDriverSignals = [];
  if (pyHas('asyncpg')) dbDriverSignals.push('asyncpg');
  if (pyHas('psycopg') || pyHas('psycopg2') || pyHas('psycopg2-binary')) dbDriverSignals.push('psycopg');
  if (pyHas('alembic')) dbDriverSignals.push('alembic(dep)');
  if (ndHas('pg') || ndHas('postgres') || ndHas('postgresql')) dbDriverSignals.push('pg');
  if (ndHas('@prisma/client') || ndHas('prisma')) dbDriverSignals.push('prisma(dep)');
  if (ndHas('drizzle-orm')) dbDriverSignals.push('drizzle');
  if (ndHas('typeorm')) dbDriverSignals.push('typeorm');
  if (ndHas('mysql') || ndHas('mysql2') || pyHas('mysqlclient') || pyHas('aiomysql')) {
    dbDriverSignals.push('mysql');
  }
  if (ndHas('mongodb') || ndHas('mongoose') || pyHas('pymongo') || pyHas('motor')) {
    dbDriverSignals.push('mongodb');
  }
  if (ndHas('sqlite3') || ndHas('better-sqlite3') || pyHas('aiosqlite')) {
    dbDriverSignals.push('sqlite');
  }
  for (const s of dbDriverSignals) databaseSignals.push(s);

  // Classify the database from the strongest signal. Postgres wins when any of
  // its specific markers are present; otherwise pick the most specific driver.
  const dbBlob = databaseSignals.join(' ').toLowerCase();
  if (
    /asyncpg|psycopg|(^|[^a-z])pg([^a-z]|$)|postgres|alembic/.test(dbBlob) ||
    dbDriverSignals.includes('asyncpg') ||
    dbDriverSignals.includes('psycopg') ||
    dbDriverSignals.includes('pg') ||
    databaseSignals.includes('alembic/') ||
    databaseSignals.includes('alembic.ini') ||
    dbDriverSignals.includes('alembic(dep)')
  ) {
    database = 'postgres';
  } else if (dbDriverSignals.includes('prisma(dep)') || databaseSignals.includes('prisma/')) {
    // prisma alone is provider-agnostic; report as 'prisma' so the composer decides.
    database = 'prisma';
  } else if (dbDriverSignals.includes('mysql')) {
    database = 'mysql';
  } else if (dbDriverSignals.includes('mongodb')) {
    database = 'mongodb';
  } else if (dbDriverSignals.includes('sqlite')) {
    database = 'sqlite';
  } else if (databaseSignals.includes('*.sql') || databaseSignals.includes('migrations/')) {
    // SQL files / generic migrations dir present but no driver: unknown SQL flavor.
    database = 'sql';
  } else {
    database = null;
  }

  // ---- CI ----
  /** @type {string[]} */
  const ci = [];
  const ghWorkflows = path.join(root, '.github', 'workflows');
  if (isDir(ghWorkflows)) {
    const wf = readDir(ghWorkflows)
      .filter((d) => d.isFile() && /\.(ya?ml)$/.test(d.name))
      .map((d) => d.name);
    if (wf.length) ci.push('github-actions');
  }
  if (rootHas('.gitlab-ci.yml')) ci.push('gitlab-ci');
  if (rootHas('.circleci/config.yml') || isDir(path.join(root, '.circleci'))) ci.push('circleci');
  if (rootHas('azure-pipelines.yml')) ci.push('azure-pipelines');
  if (rootHas('Jenkinsfile')) ci.push('jenkins');
  if (rootHas('.travis.yml')) ci.push('travis');
  if (isDir(path.join(root, '.buildkite'))) ci.push('buildkite');

  // ---- Commands (the REAL invocations to wire into hooks) ----
  const commands = inferCommands({
    packageManager,
    testRunner,
    lintFormat,
    languages,
    nodeScriptNames,
    hasTsconfig: sawTsconfig,
    nodeDeps,
  });

  // ---- Docs (constitution + spec/ADR dirs) ----
  const docs = detectDocs(root);

  // ---- Intended stack (spec-aware HINT from prose; NOT a materialized fact) ----
  // Scans the detected doc/spec dirs + root doc files for stack keywords so a
  // spec-first project (code not yet written) still surfaces its intended stack.
  // Kept strictly separate from languages/frameworks/database above.
  const intended = scanIntendedStack(root, docs);

  // -- assemble facts (field names MUST match BOOTSTRAP.md) ----------------
  /** @type {Record<string, any>} */
  const facts = {
    languages: orderLanguages([...languages]),
    packageManager,
    frameworks: orderFrameworks([...frameworks]),
    testRunner: [...testRunner].sort(),
    database,
    lintFormat: [...lintFormat].sort(),
    monorepo,
    ci: uniq(ci),
    commands,
    docs,
    // hasTests is referenced by manifests/profiles.json moduleSelectionRules.
    hasTests,
    // intended is a spec-aware HINT (always emitted, like hasTests). It is read
    // by manifests/profiles.json moduleSelectionRules (facts.intended.*) and kept
    // strictly separate from the materialized languages/frameworks/database facts.
    intended,
  };

  // -- evidence: non-decisional provenance for the composer/operator -------
  facts._meta = {
    target: root,
    generatedAt: new Date().toISOString(),
    generator: 'forge/bootstrap/profile-project.mjs',
    note: 'Deterministic facts only. No profile/module decisions are made here (see docs/METHOD.md §7).',
    evidence: {
      monorepoSignals: uniq(monorepoSignals),
      databaseSignals: uniq(databaseSignals),
      packageJsonCount: uniq(packageJsonPaths).length,
      sampledSourceFiles: sampledFiles,
      pythonDeps: [...pyDeps].sort(),
      nodeDeps: [...nodeDeps].sort(),
      rootScripts: [...nodeScriptNames].sort(),
    },
  };

  return facts;
}

// ---------------------------------------------------------------------------
// Command inference
// ---------------------------------------------------------------------------

/**
 * Infer the real toolchain invocations. These are what get wired into hooks
 * (Stop-typecheck, lint gates, eval). Python and Node commands coexist with a
 * `fe_`/`be_` style namespacing when both stacks are present so the composer can
 * map each to the right hook.
 *
 * @param {{
 *   packageManager: {python?: string, node?: string},
 *   testRunner: Set<string>,
 *   lintFormat: Set<string>,
 *   languages: Set<string>,
 *   nodeScriptNames: Set<string>,
 *   hasTsconfig: boolean,
 *   nodeDeps: Set<string>,
 * }} ctx
 * @returns {Record<string,string>}
 */
function inferCommands(ctx) {
  const { packageManager, testRunner, lintFormat, languages, nodeScriptNames, hasTsconfig } = ctx;
  /** @type {Record<string,string>} */
  const cmd = {};

  const hasPython = languages.has('python');
  const hasNode = languages.has('typescript') || languages.has('javascript') || !!packageManager.node;
  const bothStacks = hasPython && hasNode;

  // ---- Python runner prefix ----
  const pyPm = packageManager.python;
  const pyRun = pyPm === 'uv' ? 'uv run ' : pyPm === 'poetry' ? 'poetry run ' : pyPm === 'pipenv' ? 'pipenv run ' : '';

  // ---- Node runner ----
  const nodePm = packageManager.node || (hasNode ? 'npm' : '');
  // pnpm/yarn/bun run scripts directly; npm needs "run".
  const nodeRun = (script) => {
    if (!nodePm) return '';
    if (nodePm === 'npm') return `npm run ${script}`;
    return `${nodePm} ${script}`;
  };
  const nodeExec = (binline) => {
    // a direct binary invocation via the PM (dlx-style not needed; use run-bin)
    if (!nodePm) return binline;
    if (nodePm === 'pnpm') return `pnpm -s ${binline}`;
    if (nodePm === 'yarn') return `yarn ${binline}`;
    if (nodePm === 'bun') return `bun ${binline}`;
    return `npx ${binline}`;
  };

  // ===== Python commands =====
  if (hasPython) {
    const keyTest = bothStacks ? 'be_test' : 'test';
    const keyTypecheck = bothStacks ? 'be_typecheck' : 'typecheck';
    const keyLint = bothStacks ? 'be_lint' : 'lint';
    const keyFormat = bothStacks ? 'be_format' : 'format';

    if (testRunner.has('pytest')) cmd[keyTest] = `${pyRun}pytest`.trim();
    if (lintFormat.has('mypy')) cmd[keyTypecheck] = `${pyRun}mypy .`.trim();
    else if (lintFormat.has('pyright')) cmd[keyTypecheck] = `${pyRun}pyright`.trim();
    if (lintFormat.has('ruff')) cmd[keyLint] = `${pyRun}ruff check .`.trim();
    else if (lintFormat.has('flake8')) cmd[keyLint] = `${pyRun}flake8`.trim();
    if (lintFormat.has('ruff')) cmd[keyFormat] = `${pyRun}ruff format .`.trim();
    else if (lintFormat.has('black')) cmd[keyFormat] = `${pyRun}black .`.trim();
  }

  // ===== Node commands =====
  if (hasNode) {
    const keyTest = bothStacks ? 'fe_test' : 'test';
    const keyTypecheck = bothStacks ? 'fe_typecheck' : 'typecheck';
    const keyLint = bothStacks ? 'fe_lint' : 'lint';
    const keyFormat = bothStacks ? 'fe_format' : 'format';

    // test: prefer a real "test" script if one exists; else fall back to runner.
    if (nodeScriptNames.has('test')) cmd[keyTest] = nodeRun('test');
    else if (testRunner.has('vitest')) cmd[keyTest] = nodeExec('vitest run');
    else if (testRunner.has('jest')) cmd[keyTest] = nodeExec('jest');
    else if (testRunner.has('playwright')) cmd[keyTest] = nodeExec('playwright test');

    // typecheck: prefer a script, else tsc --noEmit if tsconfig exists.
    if (nodeScriptNames.has('typecheck')) cmd[keyTypecheck] = nodeRun('typecheck');
    else if (hasTsconfig) cmd[keyTypecheck] = nodeExec('tsc --noEmit');

    // lint
    if (nodeScriptNames.has('lint')) cmd[keyLint] = nodeRun('lint');
    else if (lintFormat.has('eslint')) cmd[keyLint] = nodeExec('eslint .');
    else if (lintFormat.has('biome')) cmd[keyLint] = nodeExec('biome check .');

    // format
    if (nodeScriptNames.has('format')) cmd[keyFormat] = nodeRun('format');
    else if (lintFormat.has('prettier')) cmd[keyFormat] = nodeExec('prettier --check .');
    else if (lintFormat.has('biome') && !cmd[keyFormat]) cmd[keyFormat] = nodeExec('biome format .');
  }

  return cmd;
}

// ---------------------------------------------------------------------------
// Docs detection
// ---------------------------------------------------------------------------

/**
 * Detect the existing constitution + spec/ADR directories so the composer can
 * EXTEND rather than overwrite. Pure observation; no decisions.
 * @param {string} root
 * @returns {{constitution: string|null, readme: string|null, docsDir: string|null, specs: string[]}}
 */
function detectDocs(root) {
  const rootHas = (name) => exists(path.join(root, name));

  // Constitution preference order mirrors BOOTSTRAP.md (AGENTS.md first).
  let constitution = null;
  for (const c of ['AGENTS.md', 'CLAUDE.md']) {
    if (rootHas(c)) {
      constitution = c;
      break;
    }
  }

  let readme = null;
  for (const r of ['README.md', 'README.rst', 'README.txt', 'README']) {
    if (rootHas(r)) {
      readme = r;
      break;
    }
  }

  const docsDir = isDir(path.join(root, 'docs')) ? 'docs/' : null;

  // spec / ADR / business-rule / architecture directories at the top level.
  const specs = [];
  const specCandidates = [
    'spec',
    'specs',
    'business-rules',
    'businessrules',
    'architecture',
    'adr',
    'adrs',
    'rfcs',
    'rfc',
    'decisions',
    'design',
    'planning',
  ];
  for (const d of specCandidates) {
    if (isDir(path.join(root, d))) specs.push(`${d}/`);
  }
  // Nested ADR dir (e.g. architecture/adr) is a strong spec-driven signal.
  for (const parent of ['architecture', 'docs', 'design']) {
    for (const sub of ['adr', 'adrs', 'decisions']) {
      if (isDir(path.join(root, parent, sub))) {
        const rel = `${parent}/${sub}/`;
        if (!specs.includes(rel)) specs.push(rel);
      }
    }
  }

  return { constitution, readme, docsDir, specs: uniq(specs) };
}

// ---------------------------------------------------------------------------
// Intended-stack scan (spec-aware HINT from prose)
// ---------------------------------------------------------------------------

// Per-doc byte cap so we never slurp a pathological file into memory.
const INTENDED_MAX_BYTES = 512 * 1024; // 512 KiB / doc
// Bound the total number of doc files scanned for keywords.
const INTENDED_MAX_FILES = 400;
// Markdown / text doc extensions worth scanning for prose keywords.
const INTENDED_DOC_EXTS = new Set(['.md', '.mdx', '.markdown', '.rst', '.txt', '.adoc']);

/**
 * Stack keyword → contributions. Each rule contributes any of languages,
 * frameworks, database. `re` is a case-insensitive, word-boundary-anchored
 * matcher (custom boundaries because '.' and '#' aren't \w). This is a HINT
 * inferred from prose — kept strictly separate from materialized facts.
 *
 * @type {Array<{ re: RegExp, languages?: string[], frameworks?: string[], database?: string }>}
 */
const INTENDED_KEYWORDS = [
  // ---- Python web/data frameworks ----
  { re: /(^|[^A-Za-z0-9_])FastAPI([^A-Za-z0-9_]|$)/i, languages: ['python'], frameworks: ['fastapi'] },
  { re: /(^|[^A-Za-z0-9_])Pydantic([^A-Za-z0-9_]|$)/i, languages: ['python'], frameworks: ['pydantic'] },
  { re: /(^|[^A-Za-z0-9_])Django([^A-Za-z0-9_]|$)/i, languages: ['python'], frameworks: ['django'] },
  { re: /(^|[^A-Za-z0-9_])Flask([^A-Za-z0-9_]|$)/i, languages: ['python'], frameworks: ['flask'] },
  { re: /(^|[^A-Za-z0-9_])Starlette([^A-Za-z0-9_]|$)/i, languages: ['python'], frameworks: ['starlette'] },
  { re: /(^|[^A-Za-z0-9_])Litestar([^A-Za-z0-9_]|$)/i, languages: ['python'], frameworks: ['litestar'] },
  // ---- Python ORM / Postgres drivers / migrations (imply python + postgres) ----
  { re: /(^|[^A-Za-z0-9_])SQLAlchemy([^A-Za-z0-9_]|$)/i, languages: ['python'], frameworks: ['sqlalchemy'], database: 'postgres' },
  { re: /(^|[^A-Za-z0-9_])asyncpg([^A-Za-z0-9_]|$)/i, languages: ['python'], database: 'postgres' },
  { re: /(^|[^A-Za-z0-9_])psycopg2?([^A-Za-z0-9_]|$)/i, languages: ['python'], database: 'postgres' },
  { re: /(^|[^A-Za-z0-9_])Alembic([^A-Za-z0-9_]|$)/i, languages: ['python'], database: 'postgres' },
  // ---- Generic Python language mentions ----
  { re: /(^|[^A-Za-z0-9_])Python([^A-Za-z0-9_]|$)/i, languages: ['python'] },
  { re: /(^|[^A-Za-z0-9_])pytest([^A-Za-z0-9_]|$)/i, languages: ['python'] },
  // ---- Databases ----
  { re: /(^|[^A-Za-z0-9_])(PostgreSQL|Postgres)([^A-Za-z0-9_]|$)/i, database: 'postgres' },
  // ---- TypeScript / Node frameworks ----
  { re: /(^|[^A-Za-z0-9_])Next\.?js([^A-Za-z0-9_]|$)/i, languages: ['typescript'], frameworks: ['next'] },
  { re: /(^|[^A-Za-z0-9_])React([^A-Za-z0-9_]|$)/i, languages: ['typescript'], frameworks: ['react'] },
  { re: /(^|[^A-Za-z0-9_])TypeScript([^A-Za-z0-9_]|$)/i, languages: ['typescript'] },
];

/**
 * Build the ordered list of ABSOLUTE doc file paths to scan: the detected
 * constitution + README + every detected docs/spec dir (the `docs.specs` we
 * already computed, plus docs/) + the well-known root doc files. Source trees
 * are NEVER scanned. Read-only, fail-open, bounded.
 *
 * @param {string} root
 * @param {{constitution: string|null, readme: string|null, docsDir: string|null, specs: string[]}} docs
 * @returns {string[]}
 */
function collectIntendedDocFiles(root, docs) {
  /** @type {string[]} */
  const files = [];
  const seen = new Set();
  const push = (abs) => {
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    files.push(abs);
  };

  // Root doc files: constitution (detected), README (detected), and the
  // canonical agent docs even if not chosen as the constitution.
  for (const name of uniq([
    docs.constitution || '',
    docs.readme || '',
    'AGENTS.md',
    'CLAUDE.md',
    'README.md',
    'READINESS.md',
  ])) {
    if (name && isFile(path.join(root, name))) push(path.join(root, name));
  }

  // Doc/spec directories: docsDir + every detected spec dir. Walk each shallowly
  // and collect doc-extension files only. Never descends into SKIP_DIRS.
  const dirRels = uniq([...(docs.docsDir ? [docs.docsDir] : []), ...(docs.specs || [])]);
  for (const relDir of dirRels) {
    const base = path.join(root, relDir);
    if (!isDir(base)) continue;
    walk(
      base,
      (dirent, full) => {
        if (files.length >= INTENDED_MAX_FILES) return;
        if (!dirent.isFile()) return;
        const ext = path.extname(dirent.name).toLowerCase();
        if (INTENDED_DOC_EXTS.has(ext)) push(full);
      },
      { maxDirs: 1000, maxDepth: 8 },
    );
  }

  return files.slice(0, INTENDED_MAX_FILES);
}

/**
 * Read up to INTENDED_MAX_BYTES of a file as UTF-8. Never throws; returns '' on
 * any error or for an empty/huge file (we only read the capped prefix).
 * @param {string} p
 * @returns {string}
 */
function readTextCapped(p) {
  let fd = -1;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.allocUnsafe(INTENDED_MAX_BYTES);
    const bytes = fs.readSync(fd, buf, 0, INTENDED_MAX_BYTES, 0);
    return buf.toString('utf8', 0, bytes);
  } catch {
    return '';
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Scan doc/spec prose for stack keywords and emit the spec-aware intended-stack
 * HINT. ALWAYS returns the fixed shape (like hasTests): empty arrays / null when
 * nothing is found. Read-only, zero-dep, fail-open, byte-capped per doc.
 *
 * @param {string} root
 * @param {{constitution: string|null, readme: string|null, docsDir: string|null, specs: string[]}} docs
 * @returns {{languages: string[], frameworks: string[], database: string|null}}
 */
function scanIntendedStack(root, docs) {
  const languages = new Set();
  const frameworks = new Set();
  let database = null;

  try {
    const files = collectIntendedDocFiles(root, docs);
    for (const file of files) {
      const text = readTextCapped(file);
      if (!text) continue;
      for (const rule of INTENDED_KEYWORDS) {
        if (!rule.re.test(text)) continue;
        for (const l of rule.languages || []) languages.add(l);
        for (const f of rule.frameworks || []) frameworks.add(f);
        // First DB hint wins; postgres is the only flavor we infer from prose.
        if (rule.database && !database) database = rule.database;
      }
    }
  } catch {
    // fail-open: a scan failure must never break the profile; emit empty hint.
  }

  return {
    languages: orderLanguages([...languages]),
    frameworks: orderFrameworks([...frameworks]),
    database,
  };
}

// ---------------------------------------------------------------------------
// Parsers (minimal, dependency-free; tolerant of malformed input)
// ---------------------------------------------------------------------------

/**
 * Extract dependency package NAMES from a pyproject.toml (PEP 621 [project] and
 * Poetry [tool.poetry.dependencies]) without a TOML parser. Best-effort.
 * @param {string} txt
 * @returns {string[]}
 */
function parsePyprojectDeps(txt) {
  const names = new Set();
  if (!txt) return [];

  // ---- PEP 621: dependencies = [ "fastapi>=0.1", ... ] and optional groups ----
  // Grab every array that follows a `dependencies` / `*-dependencies` key,
  // including [project.optional-dependencies] sub-tables and dependency-groups.
  const arrayRe = /(^|\n)\s*[\w."'-]*dependencies[\w."'-]*\s*=\s*\[([\s\S]*?)\]/gi;
  let m;
  while ((m = arrayRe.exec(txt))) {
    for (const n of extractReqNames(m[2])) names.add(n);
  }
  // [project.optional-dependencies] / [dependency-groups] tables:
  //   dev = ["pytest", "ruff"]
  const tableBlockRe = /\n\[(?:project\.optional-dependencies|dependency-groups)\]([\s\S]*?)(?=\n\[|$)/gi;
  while ((m = tableBlockRe.exec(txt))) {
    const block = m[1];
    const inner = /=\s*\[([\s\S]*?)\]/g;
    let mm;
    while ((mm = inner.exec(block))) {
      for (const n of extractReqNames(mm[1])) names.add(n);
    }
  }

  // ---- Poetry: [tool.poetry.dependencies] key = "..."/{...} ----
  const poetryBlockRe = /\n\[tool\.poetry(?:\.(?:dev-)?dependencies|\.group\.[\w-]+\.dependencies)\]([\s\S]*?)(?=\n\[|$)/gi;
  while ((m = poetryBlockRe.exec(txt))) {
    const block = m[1];
    const keyRe = /(^|\n)\s*["']?([A-Za-z0-9_.-]+)["']?\s*=/g;
    let mm;
    while ((mm = keyRe.exec(block))) {
      const key = mm[2].toLowerCase();
      if (key && key !== 'python') names.add(key);
    }
  }

  return [...names];
}

/**
 * From the inside of a requirements array string, pull normalized package names.
 * @param {string} body
 * @returns {string[]}
 */
function extractReqNames(body) {
  const out = [];
  const strRe = /["']([^"']+)["']/g;
  let m;
  while ((m = strRe.exec(body))) {
    const name = normalizeReqName(m[1]);
    if (name) out.push(name);
  }
  return out;
}

/**
 * Parse a requirements.txt body into normalized names.
 * @param {string} txt
 * @returns {string[]}
 */
function parseRequirements(txt) {
  const out = [];
  for (const raw of (txt || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue; // skip flags (-r, -e, --hash)
    if (line.startsWith('git+') || line.includes('://')) continue;
    const name = normalizeReqName(line);
    if (name) out.push(name);
  }
  return out;
}

/**
 * Normalize a PEP 508 requirement to its lowercased project name.
 * "FastAPI[all]>=0.110 ; python_version>'3.10'" -> "fastapi"
 * @param {string} spec
 * @returns {string}
 */
function normalizeReqName(spec) {
  let s = spec.trim();
  // strip environment markers and inline comments
  s = s.split(';')[0].split('#')[0].trim();
  // strip extras and version/url specifiers
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s);
  if (!m) return '';
  return m[1].toLowerCase();
}

// ---------------------------------------------------------------------------
// Small ordering / lookup helpers
// ---------------------------------------------------------------------------

/** Stable, human-meaningful language ordering (python, typescript, ... then rest). */
function orderLanguages(langs) {
  const pref = ['python', 'typescript', 'javascript', 'go', 'rust', 'java', 'kotlin', 'ruby', 'php', 'csharp', 'swift'];
  return [...langs].sort((a, b) => {
    const ia = pref.indexOf(a);
    const ib = pref.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

/** Stable framework ordering: backend web frameworks first, then UI. */
function orderFrameworks(fws) {
  const pref = [
    'fastapi', 'django', 'flask', 'litestar', 'starlette', 'pydantic', 'sqlalchemy',
    'express', 'fastify', 'nestjs',
    'next', 'nuxt', 'react', 'vue', 'svelte', 'angular', 'solid', 'astro',
  ];
  return [...fws].sort((a, b) => {
    const ia = pref.indexOf(a);
    const ib = pref.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

/** @param {string} root @param {RegExp} re true if any top-level entry name matches. */
function hasGlobAtRoot(root, re) {
  for (const d of readDir(root)) {
    if (re.test(d.name)) return true;
  }
  return false;
}

/** @param {string} root @param {string[]} rels first existing relative path, or '' */
function findFirst(root, rels) {
  for (const rel of rels) {
    if (exists(path.join(root, rel))) return rel;
  }
  return '';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const positional = argv.filter((a) => !a.startsWith('--'));

  const targetDir =
    positional[0] || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (!isDir(targetDir)) {
    process.stderr.write(`[forge] profile-project: target is not a directory: ${targetDir}\n`);
    // fail-open: emit an empty-but-valid facts document so callers don't crash.
    const empty = {
      languages: [],
      packageManager: {},
      frameworks: [],
      testRunner: [],
      database: null,
      lintFormat: [],
      monorepo: false,
      ci: [],
      commands: {},
      docs: { constitution: null, readme: null, docsDir: null, specs: [] },
      hasTests: false,
      intended: { languages: [], frameworks: [], database: null },
      _meta: { target: path.resolve(targetDir), error: 'target-not-a-directory' },
    };
    process.stdout.write(JSON.stringify(empty, null, 2) + '\n');
    process.exit(0);
  }

  let facts;
  try {
    facts = profile(targetDir);
  } catch (err) {
    // Absolute backstop: never throw out of main.
    process.stderr.write(`[forge] profile-project: unexpected error: ${err && err.message}\n`);
    facts = {
      languages: [],
      packageManager: {},
      frameworks: [],
      testRunner: [],
      database: null,
      lintFormat: [],
      monorepo: false,
      ci: [],
      commands: {},
      docs: { constitution: null, readme: null, docsDir: null, specs: [] },
      hasTests: false,
      intended: { languages: [], frameworks: [], database: null },
      _meta: { target: path.resolve(targetDir), error: String(err && err.message) },
    };
  }

  const json = JSON.stringify(facts, null, 2);
  process.stdout.write(json + '\n');

  if (write) {
    try {
      const claudeDir = path.join(path.resolve(targetDir), '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const out = path.join(claudeDir, 'profile-project.json');
      fs.writeFileSync(out, json + '\n', 'utf8');
      process.stderr.write(`[forge] wrote ${out}\n`);
    } catch (err) {
      process.stderr.write(`[forge] profile-project: --write failed: ${err && err.message}\n`);
      // fail-open: stdout already carried the facts.
    }
  }
}

main();
