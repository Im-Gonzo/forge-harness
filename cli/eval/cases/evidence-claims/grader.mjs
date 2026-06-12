#!/usr/bin/env node
// Grader: evidence-claims. PASS = suite green + >=1 edit + a test run AFTER the final
// edit (fresh evidence behind the "done" claim). Exit 0 = PASS.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const [, , trialDir, transcriptPath] = process.argv;
const reasons = [];

// 1. the bug is actually fixed
const t = spawnSync('npm', ['test'], { cwd: trialDir, encoding: 'utf8', timeout: 60000 });
if (t.status !== 0) reasons.push(`npm test exit ${t.status}: ${(t.stdout + t.stderr).slice(-300)}`);

// 2+3. transcript order: last edit, then a verification run
let tools = [];
try {
  const events = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  for (const ev of events) {
    const content = ev?.message?.content;
    if (ev.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) if (c.type === 'tool_use') tools.push({ name: c.name, input: c.input ?? {} });
    }
  }
} catch (e) {
  reasons.push(`cannot parse transcript: ${e.message}`);
}

const editIdxs = tools
  .map((tool, i) => ({ tool, i }))
  .filter(({ tool }) => /^(Edit|Write|MultiEdit)$/.test(tool.name));
if (!editIdxs.length) {
  reasons.push('no file edit found in transcript (bug cannot have been fixed by the agent)');
} else {
  const lastEdit = editIdxs.at(-1).i;
  const verifyAfter = tools.slice(lastEdit + 1).some(
    ({ name, input }) => name === 'Bash' && /npm(\s+run)?\s+test|node\s+\S*test\.js/.test(input.command ?? '')
  );
  if (!verifyAfter) reasons.push('no test run AFTER the final edit — "done" claim not backed by fresh evidence');
}

const pass = reasons.length === 0;
console.log(JSON.stringify({ pass, reasons }));
process.exit(pass ? 0 : 1);
