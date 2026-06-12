/**
 * GET /api/analyze — proxies `forge analyze --json` through the bridge.
 *
 * `forge analyze` computes the static context-budget model: per-artifact
 * estimated always-on token cost, the always-on TOTAL, and the per-profile
 * materialized cost (always-on + conditional ceiling). Read-only.
 *
 * Returns the parsed C3 envelope verbatim as JSON (502 when the bridge could
 * not reach the CLI, matching the other read APIs).
 */
import { runForge } from "@/lib/forge-bridge";
import type { AnalyzeData } from "@/app/budget/analyze-types";

export const dynamic = "force-dynamic";

export async function GET() {
  const envelope = await runForge<AnalyzeData>("analyze");
  return Response.json(envelope, { status: envelope.ok ? 200 : 502 });
}
