import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The nine federated resource kinds, each mapped to its `--kind-*` accent.
 * Anything outside this set falls back to a neutral, untinted badge.
 */
export type ResourceKind =
  | "rule"
  | "skill"
  | "agent"
  | "command"
  | "hook"
  | "bundle"
  | "memory"
  | "validator"
  | "mcp";

export interface KindBadgeProps {
  /** Resource kind. Unknown values render with the neutral fallback. */
  kind: string;
  className?: string;
}

/**
 * Outline-style classes per kind. Each leans on the Foundation `--kind-*`
 * tokens exposed as `text-kind-*` / `border-kind-*` / `bg-kind-*` utilities:
 * a tinted hairline border, the accent as text, and a faint accent wash.
 */
const KIND_ACCENT: Record<ResourceKind, string> = {
  rule: "border-kind-rule/40 text-kind-rule bg-kind-rule/10",
  skill: "border-kind-skill/40 text-kind-skill bg-kind-skill/10",
  agent: "border-kind-agent/40 text-kind-agent bg-kind-agent/10",
  command: "border-kind-command/40 text-kind-command bg-kind-command/10",
  hook: "border-kind-hook/40 text-kind-hook bg-kind-hook/10",
  bundle: "border-kind-bundle/40 text-kind-bundle bg-kind-bundle/10",
  memory: "border-kind-memory/40 text-kind-memory bg-kind-memory/10",
  validator: "border-kind-validator/40 text-kind-validator bg-kind-validator/10",
  mcp: "border-kind-mcp/40 text-kind-mcp bg-kind-mcp/10",
};

/** Neutral hairline badge for unknown / unset kinds. */
const NEUTRAL_ACCENT = "border-border text-muted-foreground bg-transparent";

function isKnownKind(kind: string): kind is ResourceKind {
  return kind in KIND_ACCENT;
}

/**
 * KindBadge — a lowercase mono badge tinted by resource kind.
 *
 * Built on the shadcn `Badge` (outline variant) so it inherits the shared
 * pill geometry, then overlays a kind accent via the `--kind-*` tokens.
 */
export function KindBadge({ kind, className }: KindBadgeProps) {
  const accent = isKnownKind(kind) ? KIND_ACCENT[kind] : NEUTRAL_ACCENT;
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-mono text-[length:var(--text-2xs)] lowercase tracking-normal",
        accent,
        className,
      )}
    >
      {kind}
    </Badge>
  );
}
