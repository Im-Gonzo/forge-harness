/**
 * sources — small pure display helpers shared by the Sources workspace.
 *
 * No forge-bridge import (those are server-only); this is plain presentation
 * logic safe to pull into the "use client" boundary.
 */
import type { SourceKind, SourceTrust } from "@/lib/types";

/** A friendly label for a source kind (defaults the absent "" to "unknown"). */
export function kindLabel(kind: SourceKind | ""): string {
  if (kind === "git") return "git";
  if (kind === "local") return "local";
  return "unknown";
}

/** A friendly label for a trust level (defaults the absent "" to "untrusted"). */
export function trustLabel(trust: SourceTrust): string {
  if (trust === "reviewed") return "reviewed";
  // The list verb fail-opens absent trust to ""; treat it as the default state.
  return "untrusted";
}

/** Whether a source is already at the highest trust level (no Trust action). */
export function isReviewed(trust: SourceTrust): boolean {
  return trust === "reviewed";
}

/**
 * Best-effort short, locale-formatted timestamp; returns null for an empty /
 * unparseable value so callers can render an em-dash placeholder.
 */
export function formatTimestamp(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString();
}

/** First ERROR (else WARN) message from a bridge envelope, for a toast. */
export function envelopeMessage(
  findings: { level: string; message: string }[] | undefined,
  fallback: string,
): string {
  const finding =
    findings?.find((f) => f.level === "ERROR") ??
    findings?.find((f) => f.level === "WARN");
  return finding?.message ?? fallback;
}
