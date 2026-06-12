/**
 * GET /api/validate — proxies `forge validate --json` through the bridge.
 *
 * Query params:
 *   ?strict=1 (or =true) → runs `forge validate --strict --json`, surfacing the
 *   advisory-only findings (e.g. visible-emoji WARNs) that the non-strict pass
 *   suppresses. Anything else runs the plain validate.
 *
 * Returns the parsed C3 envelope verbatim as JSON. A failing validation is a
 * 200 with ok:false in the body (it's a result, not a transport error); only a
 * bridge/spawn failure maps to 502.
 */
import { runForge } from "@/lib/forge-bridge";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const strictParam = searchParams.get("strict");
  const strict = strictParam === "1" || strictParam === "true";

  const envelope = await runForge("validate", strict ? ["--strict"] : []);
  const transportError = "bridgeError" in envelope && envelope.bridgeError;
  return Response.json(envelope, { status: transportError ? 502 : 200 });
}
