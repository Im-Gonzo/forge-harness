"use client";

/**
 * forms/workflow — Visual form for workflows/<id>.md frontmatter.
 *
 * Resolved by CONVENTION (the shell dynamic-imports `forms/workflow` for kind
 * "workflow"). Like the reference `forms/command`, this is a CONTROLLED component
 * that reads the live `frontmatter` and emits the next frontmatter via
 * `onChange`; the workflow BODY (the prose describing each phase) is owned by the
 * shell / Raw tab and kept verbatim. A workflow's frontmatter is `name` +
 * `description` (both required) and the OPTIONAL ordered `phases` list.
 *
 * phases SHAPE: a YAML array of phase-name strings, kept ORDERED (the chip list
 * preserves insertion order — phases are a sequence, not a set). The key is
 * OMITTED entirely when the list is empty so a phase-less workflow has clean
 * frontmatter.
 *
 * KEY-ORDER PRESERVATION: it spreads the incoming frontmatter and overwrites only
 * the edited key (deleting on empty for the optional key), so the bridge's
 * minimal-diff (frontmatter-edit-core) sees a stable key order.
 */
import * as React from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { ResourceFormProps } from "../types";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Field label + control row (same affordance as forms/command's Field). */
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

export default function WorkflowForm({
  frontmatter,
  onChange,
  isNew,
  disabled,
}: ResourceFormProps) {
  const name = asString(frontmatter.name);
  const description = asString(frontmatter.description);
  const phases = asStringArray(frontmatter.phases);

  const [draftPhase, setDraftPhase] = React.useState("");

  /** Set one key, preserving all others (and their order). undefined ⇒ drop it. */
  function setKey(key: string, value: unknown) {
    const next: Record<string, unknown> = { ...frontmatter };
    if (typeof value === "undefined") {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(next);
  }

  /** Write the phases back, OMITTING the key entirely when the list is empty. */
  function setPhases(nextPhases: string[]) {
    setKey("phases", nextPhases.length > 0 ? nextPhases : undefined);
  }

  function addPhase(phase: string) {
    const p = phase.trim();
    if (p === "" || phases.includes(p)) return;
    setPhases([...phases, p]);
  }

  function removePhase(phase: string) {
    setPhases(phases.filter((x) => x !== phase));
  }

  function commitDraft() {
    if (draftPhase.trim() === "") return;
    addPhase(draftPhase);
    setDraftPhase("");
  }

  return (
    <div className="flex flex-col gap-5">
      <Field label="name" hint={isNew ? "must match the file id" : undefined}>
        <Input
          value={name}
          disabled={disabled}
          placeholder="review-changes"
          onChange={(e) => setKey("name", e.target.value)}
        />
      </Field>

      <Field
        label="description"
        hint="what the workflow orchestrates (one line)"
      >
        <Textarea
          value={description}
          disabled={disabled}
          rows={3}
          placeholder="Run the change-review pipeline end to end across its phases."
          onChange={(e) => setKey("description", e.target.value)}
        />
      </Field>

      <Field
        label="phases"
        hint={
          phases.length > 0
            ? `${phases.length} phase${phases.length === 1 ? "" : "s"} — ordered`
            : "optional — ordered phase names (key omitted when empty)"
        }
      >
        {/* Current phases as removable, ORDERED chips. */}
        {phases.length > 0 ? (
          <ol className="flex flex-wrap gap-1.5">
            {phases.map((phase, i) => (
              <li
                key={phase}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/50 bg-primary/15 py-1 pr-1 pl-2 font-mono text-[11px] text-foreground"
              >
                <span className="text-muted-foreground/60">{i + 1}.</span>
                {phase}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`remove ${phase}`}
                  onClick={() => removePhase(phase)}
                  className={cn(
                    "rounded px-1 text-muted-foreground transition-colors",
                    "hover:bg-destructive/20 hover:text-destructive",
                    "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                    "disabled:pointer-events-none disabled:opacity-50",
                  )}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        ) : null}

        {/* Add a phase — type + Enter, or the Add button. Order is preserved. */}
        <div className="flex items-center gap-1.5">
          <Input
            value={draftPhase}
            disabled={disabled}
            placeholder="plan"
            className="font-mono text-xs"
            onChange={(e) => setDraftPhase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft();
              }
            }}
            aria-label="add a workflow phase"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || draftPhase.trim() === ""}
            onClick={commitDraft}
          >
            Add
          </Button>
        </div>
      </Field>

      {isNew ? (
        <p className="font-mono text-[11px] text-muted-foreground/60">
          The workflow id is the file name (workflows/&lt;id&gt;.md); the body —
          edited in the Raw tab — describes the workflow and each phase.
        </p>
      ) : null}
    </div>
  );
}
