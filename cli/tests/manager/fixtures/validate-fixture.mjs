#!/usr/bin/env node
/**
 * validate-fixture — throwaway, zero-dependency fixture validator for EVAL-CLI-001.
 *
 * PURPOSE
 *   The CLI's `--json` envelope is synthesized at the PARENT runner by parsing each
 *   child validator's `LEVEL path:line message` line from stderr — the child is NEVER
 *   given a `--json` mode. This fixture is that unmodified child: it prints EXACTLY one
 *   canonical finding line and a one-line PASS/FAIL summary, and is byte-identical before
 *   and after the run (EVAL-CLI-001 asserts an empty before/after byte-diff of this file).
 *
 * CONTRACT (frozen — do not edit; downstream evals read this read-only)
 *   - STDERR: exactly one line, the canonical finding the parent parses:
 *
 *       WARN agents/x.md:12 dangling ref "y"
 *
 *     Format is `LEVEL<space>path:line<space>message`. The parent parses it into the C2
 *     finding {level:"WARN", path:"agents/x.md", line:12, message:'dangling ref "y"',
 *     source:"validate-fixture.mjs"} — `source` is the parent's record of THIS filename.
 *   - STDOUT: exactly one summary line mirroring lint/validate-agents.mjs:
 *
 *       validate-fixture: 1 file(s), 0 error(s), 1 warning(s) — PASS
 *
 *   - EXIT: 0 (the single finding is a WARN; only ERRORs — or --strict on a WARN — fail).
 *
 * Deterministic and arg-insensitive: same bytes out for any argv, so the parent's
 * before/after byte-diff of this file (and of its output) is stable.
 *
 * Zero dependencies; self-contained; fail-open (it can only succeed).
 */

const NAME = 'validate-fixture';

// The one canonical finding line EVAL-CLI-001 parses. Single-space delimited:
// LEVEL <space> path:line <space> message. Message itself contains the quoted ref.
const FINDING_LINE = 'WARN agents/x.md:12 dangling ref "y"';

function main() {
  // One finding to stderr (the parent's parse target).
  process.stderr.write(FINDING_LINE + '\n');
  // One human summary to stdout, mirroring validate-agents' final line.
  process.stdout.write(`${NAME}: 1 file(s), 0 error(s), 1 warning(s) — PASS\n`);
  // WARN-only => exit 0.
  process.exit(0);
}

main();
