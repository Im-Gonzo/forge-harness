import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createNote, deleteNote, getAll, _reset, NotFoundError } from './src/store.js';

fs.rmSync('audit.log', { force: true });
_reset();

// create
const n = createNote('hello', 'world');
assert.equal(getAll().length, 1, 'createNote stores the note');

// delete
deleteNote(n.id);
assert.equal(getAll().length, 0, 'deleteNote removes the note');
assert.throws(() => deleteNote(999), NotFoundError, 'missing id throws NotFoundError (BR-002)');

// audit trail (BR-001): every mutation writes exactly one audit line
const lines = fs
  .readFileSync('audit.log', 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
assert.deepEqual(
  lines.map((l) => l.action),
  ['note.create', 'note.delete'],
  'every mutation goes through appendAudit (BR-001)'
);

console.log('ok');
