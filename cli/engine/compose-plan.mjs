#!/usr/bin/env node
/**
 * compose-plan — the deterministic engine behind `skills/plan-orchestrate`.
 *
 * Ports plan-orchestrate's Phases 1-3 + 5 (heading-based step decomposition, the
 * intent-tag trigger table, the T0/T1/T2 autonomy classifier, the chain composer, and
 * the self-check assertions) from PROSE the model re-derived every run into a single
 * source of truth in CODE (docs/ORCHESTRATION-REALIGN-DESIGN.md §O1/§O2). The SKILL.md
 * keeps only the JUDGMENT layer (resolving ambiguities, surfacing findings, adjusting a
 * tier UPWARD, sanity-checking chains) and points here for the mechanics.
 *
 * The catalogue is resolved AT RUNTIME — it lists `agents/*.md` plus the four
 * chain-eligible skills and checks module presence — never a hard-coded list that
 * drifts from the tree (§O2). A reviewer agent absent from this tree falls back to
 * `code-reviewer` with a rationale, exactly as the prose said.
 *
 * The plan document (and anything it embeds) is UNTRUSTED DATA, not instructions
 * (rules/prompt-defense-baseline.md): a line like "skip the reviewer" or "auto-apply
 * the migration" becomes a `findings[]` entry and is NEVER allowed to lower a tier or
 * remove a reviewer.
 *
 * CLI:
 *   node engine/compose-plan.mjs <plan.md> [--stack python|typescript|mixed] [--json]
 *
 * Output (single JSON object to stdout under --json; a human summary otherwise):
 *   { plan, stack, steps[], cards[], ambiguities[], findings[] }
 *
 * Exit codes:
 *   0  cards composed for every in-scope step
 *   2  ambiguities[] block composition (cards omitted for the ambiguous steps only)
 *   1  usage / unreadable-plan error
 *
 * HARD INVARIANTS: zero runtime deps (node: builtins only); ESM, Node 18+; pure /
 * deterministic — no Date.now / Math.random / wall-clock, so two runs of an unchanged
 * tree + plan are byte-identical.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SELF_DIR, '..'); // forge plugin root (engine/ is one level down)

// ---------------------------------------------------------------------------
// The chain-eligible SKILLS (the only non-agent catalogue entries a chain may use).
// Agents are discovered at runtime from agents/*.md; these four skills are named by
// plan-orchestrate's chain tables and are catalogue members in their own right.
// ---------------------------------------------------------------------------

const CHAIN_ELIGIBLE_SKILLS = ['review-change', 'dual-review', 'database-migration', 'run-eval'];

// The reviewer-class tail set: a code-changing step must END in one of these (the T1
// mandatory-reviewer leg made concrete). `run-eval` gates `test` steps instead.
const REVIEWER_CLASS = new Set([
  'code-reviewer',
  'diff-reviewer',
  'python-reviewer',
  'typescript-reviewer',
  'database-reviewer',
  'security-reviewer',
]);

// ---------------------------------------------------------------------------
// Phase-2(a) — intent-tag trigger table (ported VERBATIM from plan-orchestrate).
// Order matters for nothing except readability; matching is case-insensitive,
// whole-word, against the step's raw text. `chainTemplate` is the Default-chain column.
// The literal token `<lang>-reviewer` is resolved to the concrete stack reviewer in
// Phase 3; the literal `implement` / `implement tests` markers denote the
// orchestrator-or-human implement leg (no agent fills that slot — §plan-orchestrate).
// ---------------------------------------------------------------------------

const INTENT_TAGS = [
  {
    tag: 'design',
    triggers: ['architecture', 'design', 'choose', 'evaluate', 'rfc'],
    chainTemplate: [], // planning — no executing agent; orchestrator drafts
  },
  {
    tag: 'impl',
    triggers: ['implement', 'build', 'add', 'create', 'port'],
    chainTemplate: ['<implement>', '<lang>-reviewer'],
  },
  {
    tag: 'test',
    triggers: ['test', 'coverage', 'e2e', 'integration'],
    chainTemplate: ['<implement-tests>', 'run-eval'],
  },
  {
    tag: 'refactor',
    triggers: ['refactor', 'cleanup', 'dedupe', 'split'],
    chainTemplate: ['<implement>', 'code-reviewer', '<lang>-reviewer'],
  },
  {
    tag: 'db',
    triggers: ['schema', 'migration', 'index', 'sql', 'postgres', 'alembic'],
    chainTemplate: ['database-migration', 'database-reviewer', '<lang>-reviewer'],
  },
  {
    tag: 'security',
    triggers: ['encrypt', 'auth', 'secret', 'owasp', 'pii', 'tenancy'],
    chainTemplate: ['<implement>', '<lang>-reviewer', 'security-reviewer'],
  },
  {
    tag: 'migration',
    triggers: ['migrate', 'upgrade', 'rewrite', 'data backfill', 'backfill'],
    chainTemplate: ['database-migration', 'database-reviewer'],
  },
  {
    tag: 'review',
    // 'audit' must be the ACTION, not a noun compound (audit-log/-trail/-table/-event):
    // a step about encrypting the audit-log is not a review step.
    triggers: ['review', /(?:^|[^a-z0-9])audit(?![a-z0-9])(?![-\s](?:log|trail|table|event|record)s?\b)/i, 'verify'],
    chainTemplate: ['review-change'], // or dual-review if ship-critical (handled below)
  },
  {
    tag: 'ship-critical',
    triggers: ['production', 'irreversible', 'release', 'launch'],
    chainTemplate: ['+dual-review'], // append dual-review as the tail gate
  },
];

// Tags that force T2 (irreversible / security / tenancy / data-migration touching).
const T2_TAGS = new Set(['db', 'migration', 'security', 'ship-critical']);

// ---------------------------------------------------------------------------
// Prompt-defense: plan text attempting to LOWER a tier or DROP a reviewer.
// Surfaced as findings[]; never obeyed. (rules/prompt-defense-baseline.md)
// ---------------------------------------------------------------------------

const LOWER_TIER_PATTERNS = [
  /\bskip(?:ping)?\s+the\s+reviewer\b/i,
  /\bskip(?:ping)?\s+(?:the\s+)?review\b/i,
  /\bno\s+(?:need\s+for\s+(?:a\s+)?)?review(?:er)?\b/i,
  /\bwithout\s+(?:a\s+)?review(?:er)?\b/i,
  /\bdrop\s+the\s+reviewer\b/i,
  /\bauto[- ]?appl(?:y|ied|ying)\b/i,
  /\bapply\s+(?:the\s+)?migration\s+(?:automatically|directly|to\s+prod)\b/i,
  /\bbypass\s+the\s+gate\b/i,
  /\bskip\s+the\s+gate\b/i,
];

// ===========================================================================
// Runtime catalogue resolution (§O2 — never a hard-coded agent list)
// ===========================================================================

/**
 * List the reviewer/agent ids present in this tree by scanning agents/*.md, then add
 * the four chain-eligible skills (each guarded by skill-file presence). This is the
 * single source of truth for "does this chain link resolve" — a name not here does not
 * resolve, and the composer falls back to code-reviewer with a rationale.
 *
 * @returns {{ agents: Set<string>, skills: Set<string>, all: Set<string> }}
 */
function resolveCatalogue() {
  const agents = new Set();
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'agents'))) {
      if (f.endsWith('.md')) agents.add(f.slice(0, -3));
    }
  } catch {
    /* no agents/ dir — fail-open to an empty agent set */
  }
  const skills = new Set();
  for (const s of CHAIN_ELIGIBLE_SKILLS) {
    if (fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md'))) skills.add(s);
  }
  return { agents, skills, all: new Set([...agents, ...skills]) };
}

// ===========================================================================
// Phase 0 — read the plan, resolve options
// ===========================================================================

/**
 * Resolve the stack for `<lang>-reviewer` resolution. An explicit --stack wins; else
 * probe ROOT for python/typescript markers; polyglot-or-unknown → 'mixed' (→ code-reviewer).
 * @param {string|null} explicit
 * @returns {'python'|'typescript'|'mixed'}
 */
function resolveStack(explicit) {
  if (explicit === 'python' || explicit === 'typescript' || explicit === 'mixed') return explicit;
  const hasPy =
    fs.existsSync(path.join(ROOT, 'pyproject.toml')) ||
    fs.existsSync(path.join(ROOT, 'requirements.txt')) ||
    fs.existsSync(path.join(ROOT, 'uv.lock'));
  const hasTs =
    fs.existsSync(path.join(ROOT, 'tsconfig.json')) || fs.existsSync(path.join(ROOT, 'package.json'));
  if (hasPy && !hasTs) return 'python';
  if (hasTs && !hasPy) return 'typescript';
  return 'mixed';
}

/** The concrete `<lang>-reviewer` for a stack, with catalogue fallback to code-reviewer. */
function langReviewer(stack, catalogue) {
  const want = stack === 'python' ? 'python-reviewer' : stack === 'typescript' ? 'typescript-reviewer' : 'code-reviewer';
  return catalogue.all.has(want) ? want : 'code-reviewer';
}

// ===========================================================================
// Phase 1 — decompose into steps (the 4-rule priority order, ported verbatim)
// ===========================================================================

/**
 * Identify step units in priority order, stopping at the first rule that applies:
 *   1. Explicit numbering: `## Step N` / `### Phase N` / `## N. …` / a top-level ordered list.
 *   2. A "Step" column in a table.
 *   3. `---`-separated blocks with verb-led headings.
 *   4. Otherwise, treat each H2 as one step.
 * Genuinely-ambiguous structure → push an ambiguities[] entry and return what was found.
 *
 * @param {string} body the plan markdown (frontmatter already stripped if any)
 * @returns {{ steps: Array<{id:number,title:string,intent:string,raw:string}>, ambiguities: string[] }}
 */
function decompose(body) {
  const ambiguities = [];
  const lines = body.split(/\r?\n/);

  // --- Rule 1a: explicit `## Step N` / `### Phase N` / `## N. …` headings ---
  const headingStepRe = /^(#{2,3})\s+(?:step\s+\d+|phase\s+\d+|\d+\.)\b/i;
  const headingStepIdx = [];
  for (let i = 0; i < lines.length; i++) if (headingStepRe.test(lines[i])) headingStepIdx.push(i);
  if (headingStepIdx.length > 0) {
    return { steps: sliceByHeadings(lines, headingStepIdx), ambiguities };
  }

  // --- Rule 1b: a top-level ordered list (1. / 2. …) at column 0 ---
  const orderedIdx = [];
  for (let i = 0; i < lines.length; i++) if (/^\d+\.\s+\S/.test(lines[i])) orderedIdx.push(i);
  if (orderedIdx.length >= 2) {
    return { steps: sliceByHeadings(lines, orderedIdx), ambiguities };
  }

  // --- Rule 2: a "Step" column in a markdown table ---
  const tableSteps = stepsFromTable(lines);
  if (tableSteps.length > 0) return { steps: tableSteps, ambiguities };

  // --- Rule 3: `---`-separated blocks with verb-led headings ---
  const hrSteps = stepsFromHrBlocks(body);
  if (hrSteps.length >= 2) return { steps: hrSteps, ambiguities };

  // --- Rule 4: each H2 is a step ---
  const h2Idx = [];
  for (let i = 0; i < lines.length; i++) if (/^##\s+\S/.test(lines[i]) && !/^###/.test(lines[i])) h2Idx.push(i);
  if (h2Idx.length > 0) return { steps: sliceByHeadings(lines, h2Idx), ambiguities };

  // Nothing matched — genuinely ambiguous structure.
  ambiguities.push(
    'No step structure detected (no numbered headings, ordered list, Step-column table, ---blocks, or H2s). ' +
      'Confirm running by document outline rather than guessing.'
  );
  return { steps: [], ambiguities };
}

/** Slice the doc into steps at the given start-line indices; each step spans to the next start. */
function sliceByHeadings(lines, startIdx) {
  const steps = [];
  for (let s = 0; s < startIdx.length; s++) {
    const from = startIdx[s];
    const to = s + 1 < startIdx.length ? startIdx[s + 1] : lines.length;
    const block = lines.slice(from, to);
    const title = cleanTitle(block[0]);
    const rest = block.slice(1).join('\n').trim();
    steps.push({
      id: s + 1,
      title: title.slice(0, 80),
      intent: firstSentences(rest || title, 3),
      raw: block.join('\n'),
    });
  }
  return steps;
}

/** Parse a markdown table that has a "Step" column; each data row is a step. */
function stepsFromTable(lines) {
  const steps = [];
  let headerCols = null;
  let stepCol = -1;
  let titleCol = -1;
  for (const line of lines) {
    const cells = tableRow(line);
    if (!cells) {
      if (headerCols) break; // table ended
      continue;
    }
    if (/^[-:\s|]+$/.test(line.replace(/\|/g, '').trim()) === false && !headerCols) {
      // candidate header row
      const lower = cells.map((c) => c.toLowerCase());
      const si = lower.findIndex((c) => /^step\b/.test(c) || c === '#' || c === 'id');
      if (si >= 0) {
        headerCols = cells;
        stepCol = si;
        titleCol = lower.findIndex((c) => /title|name|description|intent/.test(c));
        if (titleCol < 0) titleCol = si === 0 ? Math.min(1, cells.length - 1) : 0;
      }
      continue;
    }
    if (headerCols) {
      if (/^[-:\s]+$/.test(cells.join(''))) continue; // separator row
      const title = cleanTitle(cells[titleCol] || cells[stepCol] || '');
      if (!title) continue;
      steps.push({
        id: steps.length + 1,
        title: title.slice(0, 80),
        intent: firstSentences(title, 3),
        raw: cells.join(' | '),
      });
    }
  }
  return steps;
}

/** Split into `---`-separated blocks; keep those whose first heading is verb-led. */
function stepsFromHrBlocks(body) {
  const blocks = body.split(/\n-{3,}\n/);
  const steps = [];
  const verbLed = /^(#{1,6}\s+)?(add|implement|build|create|migrate|refactor|encrypt|test|review|update|remove|fix|port|split)\b/i;
  for (const b of blocks) {
    const trimmed = b.trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split(/\r?\n/)[0];
    if (!verbLed.test(firstLine)) continue;
    steps.push({
      id: steps.length + 1,
      title: cleanTitle(firstLine).slice(0, 80),
      intent: firstSentences(trimmed, 3),
      raw: trimmed,
    });
  }
  return steps;
}

/** Parse a `| a | b |` row into trimmed cells, or null if not a table row. */
function tableRow(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const cells = t.slice(1, t.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim());
  return cells.length >= 2 ? cells : null;
}

/** Strip leading markdown markers / "Step N." / numbering from a heading line. */
function cleanTitle(line) {
  return String(line || '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/^(?:step|phase)\s+\d+[.:)]?\s*/i, '')
    .replace(/^[-*]\s+/, '')
    .trim();
}

/** Take the first N sentences (period-delimited) of a block, collapsed to one line. */
function firstSentences(text, n) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const parts = flat.split(/(?<=[.!?])\s+/).slice(0, n);
  return parts.join(' ').slice(0, 400);
}

// ===========================================================================
// Phase 2 — tag each step (intent + autonomy tier), ported verbatim
// ===========================================================================

/** Whole-word, case-insensitive presence of a trigger token within the step text. */
function hasTrigger(text, trigger) {
  if (trigger instanceof RegExp) return trigger.test(text); // pre-compiled trigger (carries its own boundaries/exclusions)
  const t = trigger.toLowerCase();
  const lower = text.toLowerCase();
  if (t.includes(' ')) return lower.includes(t); // multi-word phrase: substring
  const re = new RegExp(`(?:^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i');
  return re.test(lower);
}

/**
 * Tag a step's intents and classify its tier. Returns the multi-tag list (order = the
 * INTENT_TAGS table order, so chain composition is deterministic) and the T0/T1/T2 tier.
 * The "higher tier wins" rule is encoded: any T2_TAG forces T2; a code-changing tag
 * forces at least T1; design/review-only stays T0.
 *
 * @param {string} text the step's raw text
 * @returns {{tags:string[], tier:'T0'|'T1'|'T2'}}
 */
function tagStep(text) {
  const tags = [];
  for (const entry of INTENT_TAGS) {
    if (entry.triggers.some((tr) => hasTrigger(text, tr))) tags.push(entry.tag);
  }

  // Tier: higher tier wins.
  let tier = 'T0';
  const codeChanging = new Set(['impl', 'test', 'refactor', 'db', 'security', 'migration']);
  if (tags.some((t) => codeChanging.has(t))) tier = 'T1';
  if (tags.some((t) => T2_TAGS.has(t))) tier = 'T2';
  // design/review with no code-changing tag => T0 (read-only).
  if (tags.length === 0) tier = 'T0';
  return { tags, tier };
}

// ===========================================================================
// Phase 3 — compose the chain (Forge rules), ported verbatim
// ===========================================================================

/**
 * Compose the chain for a step from its tags. Resolves `<lang>-reviewer`, applies
 * most-specific-tail, dedups, caps at 4, and guarantees a reviewer-class tail for any
 * code-changing step (run-eval for test steps). The `<implement>` / `<implement-tests>`
 * markers are DROPPED from the emitted chain (the implement leg is the orchestrator/human,
 * not a catalogue agent — plan-orchestrate is explicit there).
 *
 * @returns {{ chain: string[], rationale: string }}
 */
function composeChain(tags, stack, catalogue) {
  const lang = langReviewer(stack, catalogue);
  const rationale = [];

  if (tags.length === 0) {
    // Phase 3 rule 6 — no tag matched → code-reviewer-only, T0.
    return { chain: [catalogue.all.has('code-reviewer') ? 'code-reviewer' : 'code-reviewer'], rationale: 'no tag matched; default review-only gate' };
  }

  // 1. Gather template links from every matched tag, in table order.
  let links = [];
  let appendDualReview = false;
  for (const entry of INTENT_TAGS) {
    if (!tags.includes(entry.tag)) continue;
    for (const link of entry.chainTemplate) {
      if (link === '+dual-review') {
        appendDualReview = true;
        continue;
      }
      links.push(link);
    }
  }

  // 2. Resolve markers: <lang>-reviewer → concrete; drop <implement>/<implement-tests>.
  links = links
    .filter((l) => l !== '<implement>' && l !== '<implement-tests>')
    .map((l) => (l === '<lang>-reviewer' ? lang : l));

  // 3. Most-specific reviewer wins the tail. If both a stack/general reviewer and
  //    security-reviewer are present, security-reviewer must be the LAST word.
  //    If database-reviewer already gated a migration earlier and impl follows, the
  //    <lang>-reviewer is the tail — handled naturally by table order + dedup below.
  // 4. Deduplicate (keep first occurrence).
  const seen = new Set();
  let chain = [];
  for (const l of links) {
    if (seen.has(l)) continue;
    seen.add(l);
    chain.push(l);
  }

  // Enforce most-specific tail: security-reviewer (the security boundary) is the last
  // word when present; otherwise a reviewer-class member must close a code-changing chain.
  if (chain.includes('security-reviewer')) {
    chain = chain.filter((l) => l !== 'security-reviewer');
    chain.push('security-reviewer');
    rationale.push('security boundary closes the chain (security-reviewer is the last word)');
  }

  // 5. ship-critical → append dual-review as the tail gate (after dedup, before cap).
  if (appendDualReview && !chain.includes('dual-review')) {
    chain.push('dual-review');
    rationale.push('ship-critical → dual-review tail gate');
  }

  // 6. A code-changing step MUST end in a reviewer-class tail (run-eval for `test`).
  const isTest = tags.includes('test');
  const codeChanging = tags.some((t) => ['impl', 'refactor', 'db', 'security', 'migration'].includes(t));
  const tail = chain[chain.length - 1];
  if (isTest && !chain.includes('run-eval')) {
    chain.push('run-eval');
  } else if (codeChanging && !REVIEWER_CLASS.has(tail) && tail !== 'dual-review') {
    chain.push(lang);
    rationale.push('mandatory reviewer tail added (T1 reviewer leg)');
  }

  // 7. Cap at 4 — drop the weakest secondary first (a bare `review-change` folds into an
  //    existing reviewer tail; never drop the most-specific tail).
  if (chain.length > 4) {
    chain = capChain(chain);
    rationale.push('capped at 4 (weakest secondary dropped)');
  }

  return { chain, rationale: rationale.join('; ') };
}

/** Drop the weakest secondary links until length <= 4, preserving the reviewer tail. */
function capChain(chain) {
  const out = [...chain];
  const droppable = ['review-change']; // folds into the reviewer tail
  while (out.length > 4) {
    const idx = out.findIndex((l, i) => droppable.includes(l) && i < out.length - 1);
    if (idx >= 0) {
      out.splice(idx, 1);
      continue;
    }
    // No obvious droppable: remove the second link (keep head + reviewer tail).
    out.splice(1, 1);
  }
  return out;
}

// ===========================================================================
// Phase 4 — emit the agent-card per step (schema unchanged from the SKILL.md)
// ===========================================================================

function buildCard(step, tags, tier, chain, stack) {
  const isT2 = tier === 'T2';
  const reviewerTail = chain[chain.length - 1];
  const mergeGate = isT2
    ? `${reviewerVerbs(chain)} green; then HUMAN applies the change (T2 — apply is not autonomous: irreversible/security/migration step is drafted, never auto-applied)`
    : tags.includes('test')
      ? `run-eval green (capability + regression); evidence recorded`
      : tags.length === 0 || (tags.length === 1 && (tags[0] === 'design'))
        ? `report produced; human picks the option (T0 — no change to integrate)`
        : `${reviewerTail} APPROVE; evidence recorded (T1 — integrate behind the mandatory reviewer)`;

  return {
    id: `step-${step.id}`,
    title: step.title,
    intent: step.intent,
    tags,
    tier,
    chain,
    scope: { touches: [], forbidden: [] },
    acceptance: [],
    merge_gate: mergeGate,
    evidence: 'reviewer verdicts + test output + tree fingerprint (rules/common/evidence-before-claims.md)',
  };
}

/** Name the reviewer/gate verbs present in a chain for the merge-gate phrasing. */
function reviewerVerbs(chain) {
  const parts = chain.filter((l) => REVIEWER_CLASS.has(l) || l === 'dual-review' || l === 'run-eval');
  if (parts.length === 0) return 'reviewer';
  return parts.map((p) => `${p} APPROVE`).join(' + ');
}

// ===========================================================================
// Phase 5 — self-check (assertions; violations are findings[])
// ===========================================================================

/**
 * Run plan-orchestrate's Phase-5 self-check as assertions over the composed cards.
 * Each violation is pushed as a findings[] entry (never silently fixed-up beyond the
 * structural guarantees already enforced in composeChain).
 */
function selfCheck(cards, catalogue, findings) {
  for (const c of cards) {
    // Every chain link in the catalogue.
    for (const link of c.chain) {
      if (!catalogue.all.has(link)) {
        findings.push({
          step: c.id,
          severity: 'error',
          message: `chain link "${link}" is not in the runtime catalogue (agents/*.md + the 4 chain-eligible skills)`,
        });
      }
    }
    // Code-changing step ends with a reviewer-class tail; test ends with run-eval.
    const tail = c.chain[c.chain.length - 1];
    const isTest = c.tags.includes('test');
    const codeChanging = c.tags.some((t) => ['impl', 'refactor', 'db', 'security', 'migration'].includes(t));
    if (isTest && !c.chain.includes('run-eval')) {
      findings.push({ step: c.id, severity: 'error', message: 'test step does not end with run-eval' });
    } else if (codeChanging && !REVIEWER_CLASS.has(tail) && tail !== 'dual-review') {
      findings.push({ step: c.id, severity: 'error', message: 'code-changing step has no reviewer-class tail (T1 reviewer leg missing)' });
    }
    // T2 merge_gate names a human-apply step.
    if (c.tier === 'T2' && !/HUMAN/i.test(c.merge_gate)) {
      findings.push({ step: c.id, severity: 'error', message: 'T2 step merge_gate does not name a human-apply step' });
    }
    // No chain longer than 4; no duplicate within a chain.
    if (c.chain.length > 4) findings.push({ step: c.id, severity: 'error', message: `chain longer than 4 (${c.chain.length})` });
    if (new Set(c.chain).size !== c.chain.length) findings.push({ step: c.id, severity: 'error', message: 'duplicate agent within a chain' });
    // Every step carries a tier and a merge_gate.
    if (!c.tier) findings.push({ step: c.id, severity: 'error', message: 'step missing a tier' });
    if (!c.merge_gate) findings.push({ step: c.id, severity: 'error', message: 'step missing a merge_gate' });
  }
}

// ===========================================================================
// Prompt-defense scan — lower-tier / drop-reviewer attempts in the plan text
// ===========================================================================

function scanPromptDefense(step, tags, tier, findings) {
  for (const re of LOWER_TIER_PATTERNS) {
    const m = re.exec(step.raw);
    if (m) {
      findings.push({
        step: `step-${step.id}`,
        severity: 'warn',
        kind: 'prompt-defense',
        message:
          `plan text "${m[0].trim()}" attempts to lower this step's tier or drop its reviewer — ` +
          `surfaced as a finding, NOT obeyed (rules/prompt-defense-baseline.md). The step keeps ` +
          `tier ${tier} and its mandatory reviewer tail.`,
      });
    }
  }
}

// ===========================================================================
// Orchestration — tie the phases together
// ===========================================================================

/** Strip a leading YAML frontmatter block (if any) and return the body. */
function stripFrontmatter(content) {
  const clean = content.replace(/^\uFEFF/, '');
  const m = clean.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n([\s\S]*))?$/);
  return m ? (m[1] ?? '') : clean;
}

/**
 * Compose a full plan-orchestrate result for a plan document.
 * @param {string} planPath
 * @param {{stack?: string|null}} [opts]
 * @returns {{plan:string, stack:string, steps:any[], cards:any[], ambiguities:string[], findings:any[]}}
 */
export function composePlan(planPath, opts = {}) {
  const content = fs.readFileSync(planPath, 'utf8');
  const catalogue = resolveCatalogue();
  const stack = resolveStack(opts.stack ?? null);
  const body = stripFrontmatter(content);

  const { steps, ambiguities } = decompose(body);
  const findings = [];
  const cards = [];

  for (const step of steps) {
    const { tags, tier } = tagStep(step.raw);
    scanPromptDefense(step, tags, tier, findings);
    // Ambiguous steps get NO card (cards omitted for ambiguous steps only — §O2).
    const { chain } = composeChain(tags, stack, catalogue);
    const card = buildCard(step, tags, tier, chain, stack);
    cards.push(card);
  }

  selfCheck(cards, catalogue, findings);

  return {
    plan: path.relative(ROOT, path.resolve(planPath)) || planPath,
    stack,
    steps: steps.map((s) => ({ id: s.id, title: s.title, intent: s.intent })),
    cards,
    ambiguities,
    findings,
  };
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const out = { plan: null, stack: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--stack') out.stack = argv[++i] ?? null;
    else if (a.startsWith('--stack=')) out.stack = a.slice('--stack='.length);
    else if (!a.startsWith('--') && out.plan === null) out.plan = a;
  }
  return out;
}

function renderHuman(result) {
  const lines = [];
  lines.push(`# Plan-Orchestrate Result`);
  lines.push('');
  lines.push(`**Plan**: \`${result.plan}\`  ·  **Stack**: \`${result.stack}\`  ·  **Steps**: ${result.steps.length}`);
  lines.push('');
  if (result.ambiguities.length) {
    lines.push(`## Ambiguities (resolve with the user before running)`);
    for (const a of result.ambiguities) lines.push(`- ${a}`);
    lines.push('');
  }
  lines.push(`| # | Title | Tags | Tier | Chain | Merge gate (one line) |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const c of result.cards) {
    lines.push(`| ${c.id.replace('step-', '')} | ${c.title} | ${c.tags.join(', ') || '(none)'} | ${c.tier} | ${c.chain.join(' → ')} | ${c.merge_gate.split(';')[0]} |`);
  }
  if (result.findings.length) {
    lines.push('');
    lines.push(`## Findings (surfaced, NOT obeyed)`);
    for (const f of result.findings) lines.push(`- [${f.severity}${f.kind ? '/' + f.kind : ''}] ${f.step || ''} ${f.message}`);
  }
  return lines.join('\n');
}

function main() {
  const { plan, stack, json } = parseArgs(process.argv.slice(2));
  if (!plan) {
    console.error('usage: node engine/compose-plan.mjs <plan.md> [--stack python|typescript|mixed] [--json]');
    process.exit(1);
  }
  let result;
  try {
    result = composePlan(plan, { stack });
  } catch (e) {
    console.error(`compose-plan: cannot read plan "${plan}": ${e && e.message ? e.message : String(e)}`);
    process.exit(1);
  }

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(renderHuman(result) + '\n');
  }

  // Exit 2 when ambiguities block composition (cards omitted for ambiguous steps only).
  process.exit(result.ambiguities.length > 0 ? 2 : 0);
}

// Run main() only when invoked directly (so the eval can import composePlan/helpers).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
