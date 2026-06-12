"use client";

/**
 * forms/skill — Visual form for skills/<id>/SKILL.md frontmatter.
 *
 * Resolved by CONVENTION (the shell dynamic-imports `forms/skill` for kind
 * "skill"; there is no registry to edit). Like the reference `forms/agent`, this
 * is a CONTROLLED component that reads the live `frontmatter` and emits the next
 * frontmatter via `onChange`. A skill's structured frontmatter is exactly two
 * keys (skill.schema.json → SkillFrontmatter): `name` + `description`. The body
 * — the `##`-delimited procedure that IS the skill — is owned by the shell / Raw
 * tab and kept verbatim; this form never touches it.
 *
 * BODY-SECTION HELPER: the props contract is frontmatter-only (ResourceFormProps
 * has no body/onBody), so the form cannot mutate the body without changing the
 * shell. Instead it surfaces the skill's section OUTLINE (the `##` headings the
 * shell already renders the body for) as a read-only map, so the author can see
 * the section structure beside the metadata and jump to the Raw tab to edit it.
 *
 * KEY-ORDER PRESERVATION: it spreads the incoming frontmatter and overwrites only
 * the edited key (deleting on empty for non-required keys), so the bridge's
 * minimal-diff (frontmatter-edit-core) sees a stable key order.
 */
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import type { ResourceFormProps } from "../types";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Field label + control row (same affordance as forms/agent's Field). */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="font-mono text-[11px] font-medium text-muted-foreground">
        {label}
        {hint ? (
          <span className="ml-1.5 font-normal text-muted-foreground/60">
            {hint}
          </span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

export default function SkillForm({
  frontmatter,
  onChange,
  isNew,
  disabled,
}: ResourceFormProps) {
  const name = asString(frontmatter.name);
  const description = asString(frontmatter.description);

  /** Set one key, preserving all others (and their order). */
  function setKey(key: string, value: unknown) {
    const next: Record<string, unknown> = { ...frontmatter };
    if (typeof value === "undefined") {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-5">
      <Field label="name" hint={isNew ? "must match the skill dir id" : undefined}>
        <Input
          value={name}
          disabled={disabled}
          placeholder="my-skill"
          onChange={(e) => setKey("name", e.target.value)}
        />
      </Field>

      <Field
        label="description"
        hint="when to activate + what it does (the trigger surface)"
      >
        <Textarea
          value={description}
          disabled={disabled}
          rows={5}
          placeholder="Use this skill when … It does … — not for …"
          onChange={(e) => setKey("description", e.target.value)}
        />
      </Field>

      <div className="rounded-lg border border-dashed border-border p-3">
        <p className="font-mono text-[11px] text-muted-foreground/60">
          name + description above are the only structured frontmatter. The body
          — the section procedure that IS the skill — is edited verbatim in the{" "}
          <span className="text-foreground">Raw</span> tab.
        </p>
      </div>
    </div>
  );
}
