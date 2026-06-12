/**
 * GET /api/registry — the artifact catalog + per-artifact detail, via the bridge.
 *
 *   GET /api/registry            → `forge registry ls`  (C3 envelope, data.artifacts[])
 *   GET /api/registry?uid=<uid>  → `forge registry show <uid>` (record fields flattened
 *                                  into data, plus data.changelog[])
 *
 * Read-only. Returns the parsed C3 envelope verbatim as JSON.
 *
 * Why the trailing FORGE_ROOT positional on `show`:
 *   The forge CLI's registry module resolves its rootDir from ctx OR, failing
 *   that, the LAST positional arg (manager/registry.mjs#normalize). When invoked
 *   as a child process the ctx is empty, so for `registry show <uid>` the uid
 *   itself is mistaken for rootDir and the lookup reads <uid>/.forge/registry.json
 *   (which never exists) — yielding `ok:false, record:null`. Passing FORGE_ROOT as
 *   an explicit trailing positional makes rootDir resolve correctly while the uid
 *   stays positional[0]. The bridge appends `--json` after our args. This stays
 *   entirely within the bridge's public runForge() contract (no forge edits).
 */
import { getRegistry } from "@/lib/forge-bridge";
import { runForge } from "@/lib/forge-bridge";
import { FORGE_ROOT } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const uid = new URL(request.url).searchParams.get("uid");

  if (uid) {
    // `registry show <uid> <FORGE_ROOT>` — see header note on the trailing root.
    const envelope = await runForge("registry", ["show", uid, FORGE_ROOT]);
    return Response.json(envelope, { status: envelope.ok ? 200 : 502 });
  }

  const envelope = await getRegistry();
  return Response.json(envelope, { status: envelope.ok ? 200 : 502 });
}
