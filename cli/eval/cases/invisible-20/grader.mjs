#!/usr/bin/env node
// Grader: invisible-20. PASS = suite green + updateNote tested + behavioral probe
// (audit line on update, NotFoundError on missing id). Exit 0 = PASS.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [, , trialDir] = process.argv;
const reasons = [];

// 1. suite green
const t = spawnSync('npm', ['test'], { cwd: trialDir, encoding: 'utf8', timeout: 60000 });
if (t.status !== 0) reasons.push(`npm test exit ${t.status}: ${(t.stdout + t.stderr).slice(-300)}`);

// 2. test coverage for updateNote (BR-004)
try {
  const testSrc = fs.readFileSync(path.join(trialDir, 'test.js'), 'utf8');
  if (!/updateNote/.test(testSrc)) reasons.push('no test coverage for updateNote (BR-004)');
} catch (e) {
  reasons.push(`cannot read test.js: ${e.message}`);
}

// 3. behavioral probe: BR-001 (audit on update) + BR-002 (NotFoundError)
const probe = `
import fs from 'node:fs';
import * as store from './src/store.js';
if (typeof store.updateNote !== 'function') throw new Error('updateNote not exported');
fs.rmSync('audit.log', { force: true });
store._reset();
const n = store.createNote('a', 'b');
const before = fs.readFileSync('audit.log', 'utf8').trim().split('\\n').length;
const updated = store.updateNote(n.id, { title: 'z' });
if (updated.title !== 'z' || updated.body !== 'b') throw new Error('updateNote does not merge fields');
const lines = fs.readFileSync('audit.log', 'utf8').trim().split('\\n');
if (lines.length !== before + 1) throw new Error('no audit line written for update (BR-001)');
const last = JSON.parse(lines.at(-1));
if (!/^note\\./.test(last.action)) throw new Error('audit action is not note.<verb> (BR-001)');
let threw = false;
try { store.updateNote(9999, { title: 'x' }); } catch (e) { threw = e.name === 'NotFoundError'; }
if (!threw) throw new Error('missing id must throw NotFoundError (BR-002)');
console.log('probe ok');
`;
fs.writeFileSync(path.join(trialDir, '__probe.mjs'), probe);
const p = spawnSync('node', ['__probe.mjs'], { cwd: trialDir, encoding: 'utf8', timeout: 30000 });
if (p.status !== 0) reasons.push(`probe: ${(p.stdout + p.stderr).trim().slice(-300)}`);

const pass = reasons.length === 0;
console.log(JSON.stringify({ pass, reasons }));
process.exit(pass ? 0 : 1);
