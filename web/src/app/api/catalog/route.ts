/**
 * /api/catalog — the unified-catalog + admission surface for the active harness.
 *
 *   GET  [?dedup=1]                                          → `forge catalog build`
 *                                                              (or `catalog dedup` when ?dedup)
 *   POST { action:"audit", uid, agent, verdict, evidence? }  → `catalog audit … --apply`
 *   POST { action:"judge", uid, verdict, rationale? }        → `catalog judge … --apply`
 *   POST { action:"admit", uid, override? }                  → `catalog admit … --apply`
 *   POST { action:"revoke", uid }                            → `catalog revoke <uid> --apply`
 *
 * Mirrors /api/memory: the verbs run with NO explicit cwd, so the bridge spawns
 * them against the ACTIVE root (getActiveRoot — the library, or the selected
 * project's `.claude/`). No project path is threaded; the active scope is resolved
 * inside the bridge. Each verb returns the raw C3 envelope. Live state — never cached.
 *
 * The CLI mutating verbs PREVIEW by default and write only under `--apply`; these
 * POST actions are the APPLY path (the UI confirms before calling), so the bridge
 * wrappers pass `--apply` — the same `{ apply }` convention as /api/memory. `admit`
 * additionally takes the T2 `{ override }` (--override) for a gated activation.
 */
import {
  catalogAdmit,
  catalogAudit,
  catalogJudge,
  catalogRevoke,
  getCatalog,
  getCatalogDedup,
} from "@/lib/forge-bridge";

export const dynamic = "force-dynamic";

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // `?dedup=1` returns the dedup view (records + counts + conflicts); otherwise the
  // plain build view. Both are read-only live reads against the active root.
  const wantDedup = searchParams.has("dedup");
  const envelope = wantDedup ? await getCatalogDedup() : await getCatalog();
  return Response.json(envelope, { status: 200 });
}

// ──────────────────────────────────────────────────────────────────────────
// POST — actions (audit | judge | admit | revoke) against the ACTIVE root. Each
// applies (the CLI verbs preview by default; the wrappers pass --apply).
// ──────────────────────────────────────────────────────────────────────────

const AUDITOR_VERDICTS = new Set(["clean", "suspicious", "malicious"]);
const JUDGE_VERDICTS = new Set(["keep", "replace", "both", "quarantine"]);

export async function POST(request: Request): Promise<Response> {
  let body: {
    action?: unknown;
    uid?: unknown;
    agent?: unknown;
    verdict?: unknown;
    evidence?: unknown;
    rationale?: unknown;
    override?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad("Request body must be valid JSON.");
  }

  const action = body.action;
  const uid = body.uid;
  if (typeof uid !== "string" || !uid) {
    return bad("Body 'uid' (catalog record uid) is required.");
  }

  if (action === "audit") {
    const { agent, verdict, evidence } = body;
    if (typeof agent !== "string" || !agent) {
      return bad("Body 'agent' (auditor agent id) is required for audit.");
    }
    if (typeof verdict !== "string" || !AUDITOR_VERDICTS.has(verdict)) {
      return bad("Body 'verdict' must be clean | suspicious | malicious.");
    }
    if (evidence !== undefined && typeof evidence !== "string") {
      return bad("Body 'evidence' must be a string when provided.");
    }
    const envelope = await catalogAudit(
      uid,
      agent,
      verdict as "clean" | "suspicious" | "malicious",
      typeof evidence === "string" ? evidence : undefined,
    );
    return Response.json(envelope, { status: 200 });
  }

  if (action === "judge") {
    const { verdict, rationale } = body;
    if (typeof verdict !== "string" || !JUDGE_VERDICTS.has(verdict)) {
      return bad("Body 'verdict' must be keep | replace | both | quarantine.");
    }
    if (rationale !== undefined && typeof rationale !== "string") {
      return bad("Body 'rationale' must be a string when provided.");
    }
    const envelope = await catalogJudge(
      uid,
      verdict as "keep" | "replace" | "both" | "quarantine",
      typeof rationale === "string" ? rationale : undefined,
    );
    return Response.json(envelope, { status: 200 });
  }

  if (action === "admit") {
    const override = body.override === true;
    const envelope = await catalogAdmit(uid, { override });
    return Response.json(envelope, { status: 200 });
  }

  if (action === "revoke") {
    const envelope = await catalogRevoke(uid);
    return Response.json(envelope, { status: 200 });
  }

  return bad(
    `Unknown action '${String(action)}' (expected audit | judge | admit | revoke).`,
  );
}
