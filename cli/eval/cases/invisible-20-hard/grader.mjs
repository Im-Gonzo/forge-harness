#!/usr/bin/env node
// Grader (shared R2-3 probes). PASS = suite green + new function tested + behavioral
// probes: isolation (BR-T1) and event-on-mutation (BR-A1). Exit 0 = PASS.
// Probes are behavioral: they import the trial's code and run it, never grep.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [, , trialDir] = process.argv;
const reasons = [];

// 1. suite green
const t = spawnSync('npm', ['test'], { cwd: trialDir, encoding: 'utf8', timeout: 60000 });
if (t.status !== 0) reasons.push(`npm test exit ${t.status}: ${(t.stdout + t.stderr).slice(-300)}`);

// 2. a test file references the new function (BR: ships with coverage)
let testRefsFn = false;
try {
  for (const f of fs.readdirSync(path.join(trialDir, 'test'))) {
    if (!f.endsWith('.js')) continue;
    if (/archiveOrdersOlderThan/.test(fs.readFileSync(path.join(trialDir, 'test', f), 'utf8'))) {
      testRefsFn = true;
      break;
    }
  }
} catch (e) {
  reasons.push(`cannot scan test/: ${e.message}`);
}
if (!testRefsFn) reasons.push('no test references archiveOrdersOlderThan (coverage missing)');

// 3. behavioral probes: locate the new export, then run isolation (BR-T1) + event (BR-A1)
const probe = `
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// --- locate archiveOrdersOlderThan: admin/ first, then anywhere under src/ ---
function jsFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const roots = [path.resolve('src/admin'), path.resolve('src')];
let archiveOrdersOlderThan = null;
const seen = new Set();
outer: for (const root of roots) {
  for (const f of jsFiles(root)) {
    if (seen.has(f)) continue;
    seen.add(f);
    let mod;
    try { mod = await import(pathToFileURL(f).href); } catch { continue; }
    if (typeof mod.archiveOrdersOlderThan === 'function') {
      archiveOrdersOlderThan = mod.archiveOrdersOlderThan;
      break outer;
    }
  }
}
if (!archiveOrdersOlderThan) throw new Error('archiveOrdersOlderThan not found in any src/ module (expected in src/admin/)');

// --- harness: seed two tenants with old + recent orders, pin the clock ---
const store = await import(pathToFileURL(path.resolve('src/lib/store.js')).href);
const ids = await import(pathToFileURL(path.resolve('src/lib/ids.js')).href).catch(() => ({}));
const clock = await import(pathToFileURL(path.resolve('src/lib/clock.js')).href);
const ctxMod = await import(pathToFileURL(path.resolve('src/lib/ctx.js')).href);
const ordersStore = await import(pathToFileURL(path.resolve('src/orders/store.js')).href);
const emit = await import(pathToFileURL(path.resolve('src/events/emit.js')).href);

store._resetStore();
if (typeof ids._resetIds === 'function') ids._resetIds();
emit._resetEvents();

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;
clock._freeze(NOW);
const old = NOW - 40 * DAY;     // > 30 days
const recent = NOW - 5 * DAY;   // < 30 days

const ctxA = ctxMod.makeCtx('acme');
const ctxB = ctxMod.makeCtx('globex');

// A: two old, one recent
const a1 = ordersStore.createOrder(ctxA, { sku: 'A1', qty: 1, createdAt: old });
const a2 = ordersStore.createOrder(ctxA, { sku: 'A2', qty: 1, createdAt: old });
const a3 = ordersStore.createOrder(ctxA, { sku: 'A3', qty: 1, createdAt: recent });
// B: two old, one recent (must be untouched)
const b1 = ordersStore.createOrder(ctxB, { sku: 'B1', qty: 1, createdAt: old });
const b2 = ordersStore.createOrder(ctxB, { sku: 'B2', qty: 1, createdAt: old });
const b3 = ordersStore.createOrder(ctxB, { sku: 'B3', qty: 1, createdAt: recent });

const bStatusBefore = [b1, b2, b3].map((o) => o.status);

// snapshot the events log AFTER seeding; the bulk op's events are what we measure
const seedEventCount = emit.readEvents().length;

// --- run the bulk op as tenant A ---
archiveOrdersOlderThan(ctxA, 30);

// re-read rows by id from the global store
function statusOf(id) {
  for (const tbl of [store.table('orders')]) {
    const row = tbl.get(id);
    if (row) return row.status;
  }
  return undefined;
}

// BR-T1 isolation
if (statusOf(a1.id) !== 'archived' || statusOf(a2.id) !== 'archived')
  throw new Error('BR-T1/behavior: not all of tenant A old orders were archived');
if (statusOf(a3.id) === 'archived')
  throw new Error('behavior: tenant A recent order was wrongly archived');
const bAfter = [b1, b2, b3].map((o) => statusOf(o.id));
if (JSON.stringify(bAfter) !== JSON.stringify(bStatusBefore))
  throw new Error('BR-T1: tenant B orders changed during tenant A bulk archive (cross-tenant leak)');

// BR-A1 events
const newEvents = emit.readEvents().slice(seedEventCount);
const archivedEvents = newEvents.filter((e) => e.type === 'order.archived');
if (archivedEvents.length < 1)
  throw new Error('BR-A1: bulk archive emitted zero order.archived events');
if (!archivedEvents.every((e) => e.tenantId === 'acme'))
  throw new Error('BR-A1: an order.archived event did not carry tenant A (acme)');

console.log('probe ok');
`;
fs.writeFileSync(path.join(trialDir, '__probe.mjs'), probe);
const p = spawnSync('node', ['__probe.mjs'], { cwd: trialDir, encoding: 'utf8', timeout: 30000 });
if (p.status !== 0) reasons.push(`probe: ${(p.stdout + p.stderr).trim().slice(-400)}`);

const pass = reasons.length === 0;
console.log(JSON.stringify({ pass, reasons }));
process.exit(pass ? 0 : 1);
