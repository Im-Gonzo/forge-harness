import { appendAudit } from './audit.js';

/** Thrown when an operation references a note id that does not exist (BR-002). */
export class NotFoundError extends Error {
  /** @param {number} id */
  constructor(id) {
    super(`note not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

const notes = new Map();
let nextId = 1;

/**
 * Create a note.
 * @param {string} title
 * @param {string} body
 * @returns {{id: number, title: string, body: string}}
 */
export function createNote(title, body) {
  const note = { id: nextId++, title, body };
  notes.set(note.id, note);
  appendAudit('note.create', { id: note.id });
  return note;
}

/**
 * Delete a note by id.
 * @param {number} id
 * @returns {void}
 */
export function deleteNote(id) {
  if (!notes.has(id)) throw new NotFoundError(id);
  notes.delete(id);
  appendAudit('note.delete', { id });
}

/**
 * List all notes.
 * @returns {Array<{id: number, title: string, body: string}>}
 */
export function getAll() {
  return [...notes.values()];
}

/**
 * Test-only: reset store state.
 * @returns {void}
 */
export function _reset() {
  notes.clear();
  nextId = 1;
}
