/**
 * resource-editor — public surface.
 *
 * The dual-mode (Visual ⇄ Raw ⇄ Validate/Preview) editor shell plus its draft
 * types. Per-kind Visual forms live under `forms/<kind>.tsx` and are resolved by
 * CONVENTION (form-slot.tsx) — adding a kind needs NO change here.
 */
export { ResourceEditor } from "./resource-editor";
export type {
  ResourceDraft,
  ResourceFormProps,
  ResourceFormComponent,
} from "./types";
