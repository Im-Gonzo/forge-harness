// @ts-check
/**
 * hook-edit-core — PURE, framework-free primitives for the HOOK lifecycle board.
 *
 * Mirrors graph-edit-core.mjs / frontmatter-edit-core.mjs: ZERO dependence on
 * Next, `@/` aliases, node:fs, or any forge config — strings in, strings/objects
 * out — so the verification scripts (scripts/verify-hook-*.mjs) exercise the
 * EXACT bytes the route writes, not a copy. The route (route.ts) layers the
 * FORGE_ROOT IO + the validate → registry-build cycle on top.
 *
 * Four primitives:
 *   1. flattenHooks(file)        — hooks.json → a flat board model (event/index/
 *                                  group keyed by a stable id).
 *   2. findHookLocation(file,id) — the jsonc-parser JSON path to a group (and to
 *                                  its first command hook), for minimal-diff edits.
 *   3. editHookField(text,…)     — minimal-diff edit of ONE scalar field
 *                                  (timeout/matcher/id/description on a group, or
 *                                  command/timeout on its command hook) via
 *                                  jsonc-parser modify+applyEdits — touches only
 *                                  the bytes of that value, preserving key order
 *                                  and every other line verbatim.
 *   4. resolveHookScript(command, root) — map a hook `command` string
 *                                  (node "${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs") to
 *                                  an absolute script path under `root`, so the
 *                                  test-vs-stdin runner can spawn it.
 *
 * The actual spawn (test-vs-stdin) lives in the route (it needs node:child_process
 * + the real FORGE_ROOT); this module only RESOLVES which script to run and how.
 *
 * @module api/hook-test/hook-edit-core
 */
import { applyEdits, modify } from "jsonc-parser";

/**
 * @typedef {Object} HookCommand
 * @property {"command"} type
 * @property {string} command
 * @property {number} [timeout]
 * @property {boolean} [async]
 */
/**
 * @typedef {Object} HookGroup
 * @property {string} [matcher]
 * @property {string} [description]
 * @property {string} [id]
 * @property {HookCommand[]} hooks
 */
/**
 * @typedef {Object} FlatHook
 * @property {string} id      stable addressable id (declared id, or `${event}#${index}`)
 * @property {string} event   the lifecycle event (column) this group sits in
 * @property {number} index   the group's position in that event's array
 * @property {HookGroup} group
 */

/** Canonical lifecycle events, in BOARD COLUMN order (the schema's allowed set). */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "PreCompact",
  "Stop",
  "SubagentStop",
  "SessionEnd",
];

/**
 * The event map may be nested under "hooks" or be the top level itself.
 * @param {any} file parsed hooks.json
 * @returns {{map:Record<string,any>, nested:boolean}}
 */
function eventMapOf(file) {
  if (file && file.hooks && typeof file.hooks === "object" && !Array.isArray(file.hooks)) {
    return { map: file.hooks, nested: true };
  }
  return { map: file || {}, nested: false };
}

/**
 * Stable addressable id for a group (its declared id, or `${event}#${index}`).
 * @param {string} event the lifecycle event
 * @param {number} index the group's position in that event's array
 * @param {any} group the matcher group
 * @returns {string}
 */
export function hookId(event, index, group) {
  return (group && group.id) || `${event}#${index}`;
}

/**
 * Flatten a parsed hooks.json into the board model: a flat list of
 * {id, event, index, group}, in HOOK_EVENTS column order then array order.
 *
 * @param {any} file parsed hooks.json
 * @returns {FlatHook[]}
 */
export function flattenHooks(file) {
  const { map } = eventMapOf(file);
  /** @type {FlatHook[]} */
  const out = [];
  const events = Object.keys(map).filter(
    (k) => k !== "$schema" && Array.isArray(map[k]),
  );
  // Order known events by the canonical column order; unknown events go last.
  events.sort((a, b) => {
    const ia = HOOK_EVENTS.indexOf(a);
    const ib = HOOK_EVENTS.indexOf(b);
    if (ia === -1 && ib === -1) return a < b ? -1 : a > b ? 1 : 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  for (const event of events) {
    map[event].forEach(/** @param {any} group @param {number} index */ (group, index) => {
      out.push({ id: hookId(event, index, group), event, index, group });
    });
  }
  return out;
}

/**
 * Locate a hook group by its stable id and return the jsonc-parser JSON path
 * PREFIX (the path to the group object). `nested` says whether the event map is
 * under a top-level "hooks" key (so callers prepend "hooks").
 *
 * @param {any} file parsed hooks.json
 * @param {string} id the stable group id
 * @returns {{event:string,index:number,group:HookGroup,groupPath:(string|number)[]}|null}
 */
export function findHookLocation(file, id) {
  const { map, nested } = eventMapOf(file);
  const events = Object.keys(map).filter(
    (k) => k !== "$schema" && Array.isArray(map[k]),
  );
  for (const event of events) {
    const groups = map[event];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      if (hookId(event, index, group) === id) {
        const groupPath = nested
          ? ["hooks", event, index]
          : [event, index];
        return { event, index, group, groupPath };
      }
    }
  }
  return null;
}

/** Fields editable directly on the GROUP object. */
const GROUP_FIELDS = new Set(["matcher", "description", "id"]);
/** Fields editable on the group's FIRST command hook (`hooks[0]`). */
const COMMAND_FIELDS = new Set(["command", "timeout", "async"]);

/**
 * Minimal-diff edit of ONE field of the hook identified by `id`.
 *
 * Group-level fields (matcher / description / id) are edited on the group object;
 * command-level fields (command / timeout / async) are edited on the group's
 * first command hook (`hooks[0]`). The edit uses jsonc-parser modify+applyEdits,
 * so ONLY the target value's bytes change — key order and every other line
 * (including other events' hand-formatted groups) stay byte-identical.
 *
 * Passing `value === undefined` deletes the field (jsonc-parser removes the
 * property and its trailing comma).
 *
 * @param {string} text the full hooks.json text
 * @param {string} id the stable group id
 * @param {string} field the field to edit
 * @param {string|number|boolean|undefined} value the new value (undefined ⇒ delete)
 * @returns {string} the edited text (or `text` unchanged for a no-op)
 */
export function editHookField(text, id, field, value) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`editHookField: hooks.json is not valid JSON (${e instanceof Error ? e.message : e}).`);
  }
  const loc = findHookLocation(parsed, id);
  if (!loc) throw new Error(`editHookField: no hook group with id '${id}'.`);

  /** @type {(string|number)[]} */
  let jsonPath;
  if (GROUP_FIELDS.has(field)) {
    jsonPath = [...loc.groupPath, field];
  } else if (COMMAND_FIELDS.has(field)) {
    jsonPath = [...loc.groupPath, "hooks", 0, field];
  } else {
    throw new Error(`editHookField: field '${field}' is not editable.`);
  }

  const edits = modify(text, jsonPath, value, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  return applyEdits(text, edits);
}

/**
 * Resolve a hook `command` string to the absolute repo script it runs, so the
 * test-vs-stdin runner can spawn it. Understands the two forms the harness uses:
 *   node "${CLAUDE_PLUGIN_ROOT}/hooks/secret-scan.mjs"
 *   node $CLAUDE_PLUGIN_ROOT/hooks/secret-scan.mjs
 * and bare repo-relative script tokens (hooks|bin|lint|bootstrap|scripts)/….
 * `${CLAUDE_PLUGIN_ROOT}` resolves to `root` (the forge repo). Returns null when
 * no recognizable single script path is present (e.g. a non-node command).
 *
 * @param {string} command the hook command line
 * @param {string} root the forge repo root (CLAUDE_PLUGIN_ROOT)
 * @param {(...parts:string[])=>string} join a path-join (node:path.join), injected
 * @returns {{abs:string, rel:string}|null}
 */
export function resolveHookScript(command, root, join) {
  if (typeof command !== "string") return null;

  const pluginRe = /\$\{?CLAUDE_PLUGIN_ROOT\}?\/([^\s"']+)/;
  let m = pluginRe.exec(command);
  if (m) {
    const rel = m[1];
    return { abs: join(root, rel), rel };
  }

  const scriptRe =
    /(?:^|[\s"'(])((?:bootstrap|lint|bin|hooks|scripts)\/[^\s"')]+\.(?:mjs|js|cjs))/;
  m = scriptRe.exec(command);
  if (m) {
    const rel = m[1];
    return { abs: join(root, rel), rel };
  }

  return null;
}

/**
 * Interpret a hook's stdout + exit into an allow/deny VERDICT, per the Claude
 * Code PreToolUse contract (a deny is a JSON object on stdout with
 * hookSpecificOutput.permissionDecision === "deny"; everything else allows).
 * Also recognizes the legacy `{ decision: "block" }` shape.
 *
 * @param {string} stdout the hook's stdout
 * @param {number|null} code its exit code
 * @returns {{verdict:"deny"|"allow"|"error", reason:string|null, raw:any}}
 */
export function interpretHookResult(stdout, code) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) {
    // No structured output → the hook allowed (fail-open / explicit allow).
    return { verdict: "allow", reason: null, raw: null };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Recover the last JSON object printed (some hooks log lines first).
    const i = trimmed.lastIndexOf("{");
    if (i >= 0) {
      try {
        parsed = JSON.parse(trimmed.slice(i));
      } catch {
        /* fallthrough */
      }
    }
  }
  if (!parsed || typeof parsed !== "object") {
    // Non-JSON stdout from a hook is unusual; treat as allow but surface raw.
    return { verdict: "allow", reason: null, raw: trimmed };
  }
  const hso = parsed.hookSpecificOutput;
  const decision =
    (hso && hso.permissionDecision) || parsed.decision || null;
  const reason =
    (hso && hso.permissionDecisionReason) || parsed.reason || null;
  if (decision === "deny" || decision === "block") {
    return { verdict: "deny", reason: reason || null, raw: parsed };
  }
  if (code && code !== 0) {
    return { verdict: "error", reason: reason || `exit code ${code}`, raw: parsed };
  }
  return { verdict: "allow", reason: reason || null, raw: parsed };
}
