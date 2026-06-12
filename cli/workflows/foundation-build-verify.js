// foundation-build-verify — the native Workflow script behind `orchestrate-delivery`.
//
// Turns the Foundation -> Build -> Verify dispatch shape (orchestrate-delivery step 3)
// from PROSE the model re-derived every run into deterministic CODE
// (docs/ORCHESTRATION-REALIGN-DESIGN.md §O1/§O3). The SKILL.md keeps the JUDGMENT layer
// (grounding probes, north-star/fork locking, functional verification, the gotcha
// ledger) and points here for the dispatch mechanics, with manual Agent-dispatch as the
// mandatory degradation path when no Workflow runtime exists.
//
// Deterministic guarantees enforced as CODE, not advice:
//   1. One-writer-per-file: two build units with intersecting `files` throw BEFORE any
//      agent spawns (assertDisjointFiles). `files: null` is the forced-sequential
//      sentinel and never collides.
//   2. The Foundation contract flows verbatim: the foundation agent returns
//      {contract} via structured output and the script string-injects it into every
//      build prompt.
//   3. The merge gate is code: the verify agent returns {approve, findings[]}; on
//      approve:false the script returns the findings and does NOT mark the unit
//      integrated.
//   4. T2 stops at draft: when tier === 'T2' the final apply stage NEVER runs — the
//      script returns {draft, humanApplyInstruction} (structural, like validate-loops R4).
//   5. Gotcha-ledger injection: the `gotchas` block is appended to EVERY agent prompt.
//
// SANDBOX CONSTRAINTS (asserted by validate-workflow-security): a Workflow script gets
// NO filesystem, network, or child_process surface, and must be DETERMINISTIC — no
// `node:` imports, no `fetch`/sockets, no `eval`/`Function`, and no wall-clock
// (`Date.now()` / `Math.random()` / `new Date()` with no args). The runtime supplies a
// `ctx` with `agent()`, `parallel()`, and `log()`; this script imports nothing.

/**
 * The Workflow-tool meta block (the documented Workflow-script format). The runtime
 * reads this literal to register the script, its parameters, and its output shape.
 * Kept as a plain object literal so validate-workflows can assert its presence.
 */
export const meta = {
  name: 'foundation-build-verify',
  description:
    'Dispatch a build as Foundation -> Build (parallel, one-writer-per-file) -> Verify, ' +
    'with a code merge gate and a structural T2 stop-at-draft. The execution complement ' +
    'to the orchestrate-delivery skill.',
  args: {
    title: { type: 'string', required: true },
    tier: { type: 'string', enum: ['T0', 'T1', 'T2'], required: true },
    foundation: {
      type: 'object',
      required: true,
      // returns a CONTRACT via structured output: { contract: string }
      properties: { prompt: { type: 'string', required: true } },
    },
    build: {
      type: 'array',
      required: true,
      // each: { label, prompt, files: string[]|null }  — files:null => forced sequential
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          files: { type: ['array', 'null'], required: true },
        },
      },
    },
    verify: {
      type: 'object',
      required: true,
      // independent; returns { approve: boolean, findings: [] }
      properties: { prompt: { type: 'string', required: true } },
    },
    gotchas: { type: 'array', items: { type: 'string' }, required: false },
  },
  output: {
    // T2: { draft, humanApplyInstruction }. Otherwise: { integrated, units, verify }.
    type: 'object',
  },
};

// ---------------------------------------------------------------------------
// PURE, NAMED guarantee #1 — one-writer-per-file (testable without a runtime).
// ---------------------------------------------------------------------------

/**
 * Assert one-writer-per-file across build units. THROWS before any agent spawns when
 * two units declare an intersecting `files` entry. A unit with `files: null` is the
 * forced-sequential sentinel — it owns no parallel file claim, so it never collides.
 *
 * Pure: no IO, no clock, no randomness — a unit test imports and calls it directly
 * (eval `fbv-rejects-shared-files`).
 *
 * @param {Array<{label?: string, files: string[]|null}>} units
 * @returns {true} when every unit's files are pairwise-disjoint
 * @throws {Error} naming the first shared file and the two colliding units
 */
export function assertDisjointFiles(units) {
  if (!Array.isArray(units)) {
    throw new Error('foundation-build-verify: build units must be an array');
  }
  /** @type {Map<string, string>} file -> first owning unit label */
  const owner = new Map();
  for (let i = 0; i < units.length; i++) {
    const u = units[i] || {};
    const label = typeof u.label === 'string' && u.label ? u.label : `unit#${i + 1}`;
    // files:null is the forced-sequential sentinel — it claims no parallel file.
    if (u.files === null || u.files === undefined) continue;
    if (!Array.isArray(u.files)) {
      throw new Error(`foundation-build-verify: unit "${label}" has a non-array, non-null files field`);
    }
    for (const f of u.files) {
      const key = normalizeFile(f);
      if (owner.has(key) && owner.get(key) !== label) {
        throw new Error(
          `foundation-build-verify: one-writer-per-file violation — "${f}" is claimed by both ` +
            `unit "${owner.get(key)}" and unit "${label}". Give the shared file to ONE unit or ` +
            `set files:null to force it sequential.`
        );
      }
      owner.set(key, label);
    }
  }
  return true;
}

/** Normalise a file path for collision comparison (trim, collapse ./, posix slashes). */
function normalizeFile(f) {
  return String(f || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

/**
 * Partition build units into the parallel batch (those owning a disjoint, non-null
 * `files` set) and the forced-sequential tail (`files: null`). Pure helper, exported so
 * the partition is testable and the dispatch order is inspectable.
 *
 * @param {Array<{label?: string, files: string[]|null}>} units
 * @returns {{ parallel: any[], sequential: any[] }}
 */
export function partitionUnits(units) {
  assertDisjointFiles(units);
  const parallel = [];
  const sequential = [];
  for (const u of units || []) {
    if (u && (u.files === null || u.files === undefined)) sequential.push(u);
    else parallel.push(u);
  }
  return { parallel, sequential };
}

// ---------------------------------------------------------------------------
// PURE prompt assembly — guarantee #2 (contract verbatim) + #5 (gotcha ledger).
// ---------------------------------------------------------------------------

/** Append the gotcha ledger block to a prompt (guarantee #5). Pure. */
export function withGotchas(prompt, gotchas) {
  const list = Array.isArray(gotchas) ? gotchas.filter((g) => typeof g === 'string' && g.trim()) : [];
  if (list.length === 0) return prompt;
  const block = ['', '## Carry-forward gotchas (do NOT re-bite these):', ...list.map((g) => `- ${g}`)].join('\n');
  return `${prompt}\n${block}`;
}

/** Inject the Foundation contract verbatim into a build prompt (guarantee #2). Pure. */
export function withContract(prompt, contract) {
  if (typeof contract !== 'string' || !contract.trim()) return prompt;
  const block = [
    '',
    '## Foundation contract (consume VERBATIM — do not invent your own):',
    contract,
  ].join('\n');
  return `${block}\n\n${prompt}`;
}

// ---------------------------------------------------------------------------
// The Workflow entrypoint — guarantees #3 (code merge gate) and #4 (T2 draft).
// `ctx` is supplied by the Workflow runtime: ctx.agent(spec) spawns one agent and
// resolves to its structured output; ctx.parallel(specs) runs many with
// isolation:'worktree'; ctx.log(msg) records a step. This script imports nothing.
// ---------------------------------------------------------------------------

/**
 * Run a Foundation -> Build -> Verify workflow.
 *
 * @param {object} args  see `meta.args`
 * @param {object} ctx   runtime-supplied: { agent, parallel, log }
 * @returns {Promise<object>} T2 => { tier, draft, humanApplyInstruction }; else
 *   { tier, integrated, units, verify }. On a failed merge gate => { integrated:false, findings }.
 */
export async function run(args, ctx) {
  const { title, tier, foundation, build, verify, gotchas = [] } = args || {};
  const log = ctx && typeof ctx.log === 'function' ? ctx.log : () => {};

  // Guarantee #1 — assert one-writer-per-file BEFORE spawning anything.
  const { parallel, sequential } = partitionUnits(build || []);
  log(`foundation-build-verify "${title}" [${tier}]: ${parallel.length} parallel + ${sequential.length} sequential unit(s)`);

  // --- Foundation: returns { contract } via structured output (guarantee #2). ---
  const foundationOut = await ctx.agent({
    role: 'foundation',
    prompt: withGotchas(foundation.prompt, gotchas),
    schema: { contract: 'string' },
  });
  const contract = foundationOut && typeof foundationOut.contract === 'string' ? foundationOut.contract : '';
  log('foundation contract established; injecting verbatim into build prompts');

  // --- Build: parallel batch (one writer per file) then the sequential tail. ---
  const buildResults = [];
  if (parallel.length > 0) {
    const specs = parallel.map((u) => ({
      role: 'build',
      label: u.label,
      files: u.files,
      // >1 parallel build agent => isolate in a worktree (design §O3 note).
      isolation: parallel.length > 1 ? 'worktree' : 'inline',
      prompt: withContract(withGotchas(u.prompt, gotchas), contract),
    }));
    const outs = await ctx.parallel(specs);
    for (let i = 0; i < parallel.length; i++) buildResults.push({ label: parallel[i].label, output: outs[i] });
  }
  for (const u of sequential) {
    const out = await ctx.agent({
      role: 'build',
      label: u.label,
      files: null,
      isolation: 'inline',
      prompt: withContract(withGotchas(u.prompt, gotchas), contract),
    });
    buildResults.push({ label: u.label, output: out });
  }

  // --- Verify: independent; returns { approve, findings } (guarantee #3). ---
  const verifyOut = await ctx.agent({
    role: 'verify',
    prompt: withGotchas(verify.prompt, gotchas),
    schema: { approve: 'boolean', findings: 'array' },
  });
  const approve = !!(verifyOut && verifyOut.approve === true);
  const findings = verifyOut && Array.isArray(verifyOut.findings) ? verifyOut.findings : [];

  // Guarantee #3 — a failed merge gate returns findings and does NOT integrate.
  if (!approve) {
    log('merge gate: verify returned approve:false — unit NOT integrated; returning findings');
    return { tier, integrated: false, units: buildResults, verify: { approve, findings } };
  }

  // Guarantee #4 — T2 NEVER applies: return the draft + the human-apply instruction.
  if (tier === 'T2') {
    log('T2: verify approved the draft, but apply is human-gated — returning draft, NOT applying');
    return {
      tier,
      draft: { title, units: buildResults, contract },
      humanApplyInstruction:
        `T2 (irreversible/security/migration): a human must apply this approved draft. ` +
        `The workflow drafted and verified it but will not auto-apply (autonomy ladder T2).`,
      verify: { approve, findings },
    };
  }

  // T0/T1 with an approved gate — integrated.
  log('merge gate: verify approved — unit integrated');
  return { tier, integrated: true, units: buildResults, verify: { approve, findings } };
}

export default { meta, run, assertDisjointFiles, partitionUnits, withGotchas, withContract };
