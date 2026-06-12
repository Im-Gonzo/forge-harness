/**
 * GET /api/status — proxies `forge status --json` through the bridge.
 * Returns the parsed C3 envelope verbatim as JSON.
 */
import { getStatus } from "@/lib/forge-bridge";

// The bridge shells out to the forge CLI against the live repo; never cache.
export const dynamic = "force-dynamic";

export async function GET() {
  const envelope = await getStatus();
  return Response.json(envelope, { status: envelope.ok ? 200 : 502 });
}
