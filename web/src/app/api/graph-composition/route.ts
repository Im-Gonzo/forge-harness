/**
 * GET /api/graph-composition — the /graph route's composition-graph payload.
 *
 * Reads manifests/profiles.json + modules.json from disk (via the bridge) so
 * the client can render profiles → modules → components. Never cached: a
 * drag-to-assign edit must round-trip on refetch.
 *
 * NOTE: this is the GRAPH composition (profiles→modules→components), which is
 * UNRELATED to the per-project adopt COMPOSITION served at /api/composition
 * (Slice 2 / ADR-0019). It was renamed off /api/composition to free that path
 * for the adopt surface while leaving the /graph behaviour unchanged.
 */
import { readComposition } from "@/lib/forge-bridge";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { profiles, modules } = await readComposition();
    return Response.json(
      { ok: true, ts: new Date().toISOString(), profiles, modules },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { ok: false, ts: new Date().toISOString(), error: message },
      { status: 502 },
    );
  }
}
