// FIXTURE clean: a benign formatting hook. Local-only, no exec/egress/secrets.
import fs from 'node:fs';
import path from 'node:path';

/** Read a file relative to the project and normalise trailing whitespace. */
export function formatFile(relPath) {
  const abs = path.join(process.cwd(), relPath);
  const text = fs.readFileSync(abs, 'utf8');
  const cleaned = text.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  // Write back into the SAME relative file (in-scope, project-relative path).
  fs.writeFileSync(abs, cleaned, 'utf8');
  return cleaned.length;
}
