/**
 * resource-editor — shared client types.
 *
 * The editor is the single dual-mode (Visual ⇄ Raw) shell for every resource
 * kind. The "Visual" tab is a per-kind FORM resolved by CONVENTION from
 * `forms/<kind>.tsx` (dynamic import — no central registry to edit); the "Raw"
 * tab is a Monaco editor over the WHOLE file text. Both views are projections of
 * one source of truth: the live `{ frontmatter, body }` draft.
 */
import type { ResourceKind } from "@/lib/types";

/** The editable draft — frontmatter object + body. Single source of truth. */
export interface ResourceDraft {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Props every per-kind Visual form receives. A form is a CONTROLLED component:
 * it renders inputs bound to `frontmatter` and calls `onChange` with the next
 * frontmatter (the body is owned by the Raw tab / shell, not the visual form —
 * forms edit STRUCTURED frontmatter only, keeping the body verbatim).
 */
export interface ResourceFormProps {
  kind: ResourceKind;
  id: string;
  /** Current frontmatter draft (controlled). */
  frontmatter: Record<string, unknown>;
  /** Emit the next frontmatter; the shell re-serializes + syncs the Raw tab. */
  onChange: (next: Record<string, unknown>) => void;
  /** True on the create route — forms may surface id/name hints accordingly. */
  isNew: boolean;
  /** Disable inputs while a write is in flight. */
  disabled?: boolean;
}

/** A per-kind Visual form component (the default export of forms/<kind>.tsx). */
export type ResourceFormComponent = React.ComponentType<ResourceFormProps>;
