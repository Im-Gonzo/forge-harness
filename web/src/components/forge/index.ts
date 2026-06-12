/**
 * Forge presentational primitives — small, pure, token-driven building blocks
 * modeled on the federated-catalog prototype + design system. No data-layer
 * imports; safe to use anywhere in the chrome.
 */
export { SourceChip } from "./source-chip";
export type { SourceChipProps } from "./source-chip";

export { StatusPill } from "./status-pill";
export type { StatusPillProps, StatusTone } from "./status-pill";

export { KindBadge } from "./kind-badge";
export type { KindBadgeProps, ResourceKind } from "./kind-badge";

export { TrustTag } from "./trust-tag";
export type { TrustTagProps, TrustTone } from "./trust-tag";

export { TailoredChip } from "./tailored-chip";
export type { TailoredChipProps } from "./tailored-chip";
