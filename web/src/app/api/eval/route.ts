/**
 * /api/eval — the eval cockpit's server surface.
 *
 *   GET  → `forge eval-harness --report --json` (read-only coverage + grades).
 *   POST → `forge eval-harness <target> --json`, the SAFE deterministic GRADING
 *          pass (a pure code grader + ledger append — NEVER a model call).
 *          `target` is "--all" | "--changed" | a single artifact uid.
 *
 * The report is read-only: it lists coverage (artifacts with a golden set) and
 * each artifact's eval grade. Grades are "U" (unevaluated) until a live reviewer
 * run; the report never mutates eval results.
 *
 * The POST trigger is intentionally the grading pass only — it grades existing
 * transcripts and appends the ledger (cheap, deterministic). The model-calling
 * reviewer run across k worktrees is MANUAL by design and is NOT runnable here;
 * the UI surfaces that command as text instead of pretending to run it.
 */
import { runForge } from "@/lib/forge-bridge";
import type { EvalReportData } from "@/components/eval/types";

// The bridge shells out to the live forge CLI; never cache.
export const dynamic = "force-dynamic";

export async function GET() {
  const envelope = await runForge<EvalReportData>("eval-harness", ["--report"]);
  return Response.json(envelope, { status: envelope.ok ? 200 : 502 });
}

/** Whole-corpus / changed-only grading verbs the trigger accepts. */
const KNOWN_VERBS: ReadonlySet<string> = new Set(["--all", "--changed"]);

/**
 * A plausible artifact uid: "<kind>:<id>" where kind is a bare slug and id is a
 * path-ish slug (rule ids may nest with "/"). Deliberately strict so the value
 * can be passed to the CLI as a single positional arg with no shell surprises —
 * `runForge` spawns argv directly (no shell), but we still reject anything that
 * is not a verb or a clean uid to keep the trigger honest.
 */
const UID_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isValidTarget(target: unknown): target is string {
  if (typeof target !== "string") return false;
  if (KNOWN_VERBS.has(target)) return true;
  return UID_RE.test(target);
}

interface PostBody {
  target?: unknown;
}

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json(
      { ok: false, error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const target = body?.target;
  if (!isValidTarget(target)) {
    return Response.json(
      {
        ok: false,
        error:
          "target must be '--all', '--changed', or a '<kind>:<id>' artifact uid.",
      },
      { status: 400 },
    );
  }

  // The SAFE deterministic grading pass: grades existing transcripts + appends
  // the ledger. No model is ever called (see eval-harness.mjs).
  const envelope = await runForge<EvalReportData>("eval-harness", [target]);
  return Response.json(envelope, { status: envelope.ok ? 200 : 502 });
}
