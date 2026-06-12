/**
 * /api/telemetry — the telemetry control + read surface, all through the bridge.
 *
 * GET  — proxies `forge stat --json` (alias of `telemetry stat`), the rollup the
 *        dashboard charts. Supports `?since=<window>` (e.g. 7d) to scope the
 *        window, and `?action=status` to read `telemetry status` instead of the
 *        stat rollup (a lightweight enabled-or-not probe).
 *
 * POST — flips the opt-in switch: body { action: "on" | "off" } runs
 *        `forge telemetry <action> --json`. Any other action is a 400.
 *
 * Telemetry is opt-in / default-OFF: when off, `stat`'s `data` is null and a
 * single INFO finding (TEL-OFF / TEL-EMPTY) explains how to enable it. That is a
 * successful (`ok: true`) read, so we still return 200 — only a genuine bridge
 * failure 502s. Returns the parsed C3 envelope verbatim as JSON.
 */
import { runForge } from "@/lib/forge-bridge";
import type { TelemetryStatData } from "@/components/telemetry/types";

// The bridge shells out to the live forge CLI; never cache.
export const dynamic = "force-dynamic";

/** Map a bridge envelope to its HTTP status: 502 only for transport failures. */
function statusFor(envelope: { ok: boolean; bridgeError?: boolean }): number {
  const transportError = "bridgeError" in envelope && envelope.bridgeError;
  return transportError ? 502 : 200;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // ?action=status → the lightweight telemetry on/off probe.
  if (searchParams.get("action") === "status") {
    const envelope = await runForge("telemetry", ["status"]);
    return Response.json(envelope, { status: statusFor(envelope) });
  }

  // Default: the `forge stat` rollup, optionally scoped by ?since=<window>.
  const since = searchParams.get("since");
  const envelope = await runForge<TelemetryStatData | null>(
    "stat",
    since ? ["--since", since] : [],
  );
  return Response.json(envelope, { status: statusFor(envelope) });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const action =
    body && typeof body === "object" && "action" in body
      ? (body as { action?: unknown }).action
      : undefined;

  if (action !== "on" && action !== "off") {
    return Response.json(
      { ok: false, error: 'Body must be { action: "on" | "off" }.' },
      { status: 400 },
    );
  }

  const envelope = await runForge("telemetry", [action]);
  return Response.json(envelope, { status: statusFor(envelope) });
}
