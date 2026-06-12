"use client";

/**
 * forms/memory — Visual form for a curated memory entry (memory/*.md frontmatter).
 *
 * A memory entry is a confidence-scored, evidence-backed vault note (docs/METHOD.md
 * §8; enforced by lint/validate-memory-integrity.mjs). Its REQUIRED scalar
 * frontmatter is exactly: id, title, type, status, created, updated, confidence —
 * with value sanity the validator checks:
 *   type    ∈ decision | glossary | gotcha | learning | runbook
 *   status  ∈ active | superseded | deprecated
 *   confidence  a NUMBER in [0, 1]   (kept numeric here so the slider, the
 *               serialized YAML, and the validator's Number() all agree)
 *   created/updated  ISO dates (YYYY-MM-DD)
 *
 * This form edits those scalars plus a FLAT `tags` list. Everything it writes is
 * a scalar or scalar-array, so the frontmatter stays MINIMAL-DIFF-EDITABLE
 * (frontmatter-edit-core) and serializes byte-clean — it never introduces a
 * nested map that would force a whole-block rewrite.
 *
 * EDGES ARE BODY-OWNED: relations between entries are expressed ONLY as in-body
 * `[[wiki links]]` (the single edge source) — there is deliberately no
 * frontmatter `links:` field here.
 *
 * BODY-OWNED PARTS (Evidence + body [[wiki links]]): the props contract is
 * frontmatter-only (ResourceFormProps has no body), exactly like forms/skill. The
 * dated `## Evidence` section and the in-body `[[wiki links]]` the validator
 * resolves live in the body, edited verbatim in the Raw tab. This form surfaces
 * them as guidance, so the author jumps to Raw for the prose and its relations.
 *
 * KEY-ORDER PRESERVATION: it spreads the incoming frontmatter and overwrites only
 * the edited key (deleting on empty for OPTIONAL keys; required keys are always
 * written), so the bridge's minimal-diff sees a stable key order.
 */
import * as React from "react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { ResourceFormProps } from "../types";

/** type → directory + id-prefix the validator expects (advisory in the UI). */
const TYPE_OPTIONS = [
  { value: "decision", label: "decision", dir: "decisions/", prefix: "d-" },
  { value: "glossary", label: "glossary", dir: "glossary/", prefix: "gt-" },
  { value: "gotcha", label: "gotcha", dir: "gotchas/", prefix: "g-" },
  { value: "learning", label: "learning", dir: "learnings/", prefix: "l-" },
  { value: "runbook", label: "runbook", dir: "runbooks/", prefix: "rb-" },
] as const;

const STATUS_OPTIONS = [
  { value: "active", label: "active (shows in index)" },
  { value: "superseded", label: "superseded" },
  { value: "deprecated", label: "deprecated" },
] as const;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Coerce a stored confidence to a number in [0,1]; default 0.5 when absent. */
function asConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** Today as YYYY-MM-DD (the validator's ISO-date shape). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Field label + control row (matches forms/agent's Field). */
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

/** A small removable-chip token list backed by a frontmatter scalar array. */
function TokenList({
  values,
  disabled,
  placeholder,
  render,
  onAdd,
  onRemove,
}: {
  values: string[];
  disabled?: boolean;
  placeholder: string;
  render: (v: string) => string;
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
}) {
  const [draft, setDraft] = React.useState("");
  function commit() {
    const t = draft.trim();
    if (t === "") return;
    onAdd(t);
    setDraft("");
  }
  return (
    <div className="flex flex-col gap-1.5">
      {values.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1.5 rounded-md border border-primary/50 bg-primary/15 py-1 pr-1 pl-2 font-mono text-[11px] text-foreground"
            >
              {render(v)}
              <button
                type="button"
                disabled={disabled}
                aria-label={`remove ${v}`}
                onClick={() => onRemove(v)}
                className={cn(
                  "rounded px-1 text-muted-foreground transition-colors",
                  "hover:bg-destructive/20 hover:text-destructive",
                  "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-50",
                )}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          className="font-mono text-xs"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || draft.trim() === ""}
          onClick={commit}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

export default function MemoryForm({
  frontmatter,
  onChange,
  isNew,
  disabled,
}: ResourceFormProps) {
  const id = asString(frontmatter.id);
  const title = asString(frontmatter.title);
  const type = asString(frontmatter.type);
  const status = asString(frontmatter.status) || "active";
  const created = asString(frontmatter.created);
  const updated = asString(frontmatter.updated);
  const confidence = asConfidence(frontmatter.confidence);
  const tags = asStringArray(frontmatter.tags);

  const typeMeta = TYPE_OPTIONS.find((t) => t.value === type);

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

  function setConfidence(next: number) {
    // Round to 2dp so the YAML stays tidy (0.5, 0.75) and the slider is stable.
    const rounded = Math.round(Math.min(1, Math.max(0, next)) * 100) / 100;
    setKey("confidence", rounded);
  }

  function setTags(next: string[]) {
    // tags is OPTIONAL — render an explicit empty list `[]` (the schema seed
    // uses `tags: []`), but drop it only when the user has none AND it was never
    // present, to avoid churn. Simpler + clean: keep an empty `[]`.
    setKey("tags", next);
  }

  const confidencePct = Math.round(confidence * 100);
  const confidenceTone =
    confidence >= 0.75
      ? "text-emerald-500"
      : confidence >= 0.4
        ? "text-amber-500"
        : "text-destructive";

  return (
    <div className="flex flex-col gap-5">
      <Field label="id" hint={isNew ? "must match the file id" : undefined}>
        <Input
          value={id}
          disabled={disabled}
          placeholder={typeMeta ? `${typeMeta.prefix}0001-slug` : "type-prefix-0001"}
          className="font-mono text-xs"
          onChange={(e) => setKey("id", e.target.value)}
        />
      </Field>

      <Field label="title" hint="one line — what this tells a future reader">
        <Input
          value={title}
          disabled={disabled}
          placeholder="What this entry tells a future reader"
          onChange={(e) => setKey("title", e.target.value)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field
          label="type"
          hint={typeMeta ? `lives in ${typeMeta.dir}` : "required"}
        >
          <Select value={type} onValueChange={(v) => setKey("type", v as string)}>
            <SelectTrigger className="w-full" disabled={disabled}>
              <SelectValue placeholder="select a type" />
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="status" hint="lifecycle">
          <Select
            value={status}
            onValueChange={(v) => setKey("status", v as string)}
          >
            <SelectTrigger className="w-full" disabled={disabled}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {typeMeta && id && !id.startsWith(typeMeta.prefix) ? (
        <p className="-mt-2 font-mono text-[10px] text-amber-500">
          tip: a {type} id conventionally starts with{" "}
          <span className="text-foreground">{typeMeta.prefix}</span> (advisory —
          a WARN, not an error).
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-4">
        <Field label="created" hint="YYYY-MM-DD — written date">
          <div className="flex items-center gap-1.5">
            <Input
              value={created}
              disabled={disabled}
              placeholder="2026-06-06"
              className="font-mono text-xs"
              onChange={(e) => setKey("created", e.target.value)}
            />
            {!created ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => setKey("created", todayIso())}
              >
                today
              </Button>
            ) : null}
          </div>
        </Field>

        <Field label="updated" hint="YYYY-MM-DD">
          <div className="flex items-center gap-1.5">
            <Input
              value={updated}
              disabled={disabled}
              placeholder="2026-06-06"
              className="font-mono text-xs"
              onChange={(e) => setKey("updated", e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setKey("updated", todayIso())}
            >
              today
            </Button>
          </div>
        </Field>
      </div>

      {/* CONFIDENCE — numeric slider 0–1 (stored as a number, not a string). */}
      <Field
        label="confidence"
        hint="0–1 — rises on recurrence, falls on contradiction"
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={confidence}
            disabled={disabled}
            onChange={(e) => setConfidence(Number(e.target.value))}
            aria-label="confidence"
            className={cn(
              "h-2 flex-1 cursor-pointer appearance-none rounded-full bg-muted",
              "[&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary",
              "[&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          />
          <span
            className={cn(
              "w-12 text-right font-mono text-xs tabular-nums",
              confidenceTone,
            )}
          >
            {confidence.toFixed(2)}
          </span>
          <Badge variant="secondary" className="font-mono text-[10px]">
            {confidencePct}%
          </Badge>
        </div>
      </Field>

      <Field label="tags" hint="module / rule-family / invariant — what a recall grep matches">
        <TokenList
          values={tags}
          disabled={disabled}
          placeholder="add a tag"
          render={(v) => v}
          onAdd={(v) => {
            if (!tags.includes(v)) setTags([...tags, v]);
          }}
          onRemove={(v) => setTags(tags.filter((t) => t !== v))}
        />
      </Field>

      {/* Evidence + body wiki-links are body-owned (Raw tab), like forms/skill.
          Edges between entries are expressed ONLY as in-body [[wiki links]] —
          there is no frontmatter links: field. */}
      <div className="rounded-lg border border-dashed border-border p-3">
        <p className="font-mono text-[11px] text-muted-foreground/80">
          The dated{" "}
          <span className="text-foreground">## Evidence</span> section (required —
          docs/METHOD.md §4, §8) and the entry&apos;s relations live in the body
          as <span className="text-foreground">[[wiki links]]</span> (the single
          edge source). Edit them verbatim in the{" "}
          <span className="text-foreground">Raw</span> tab; the validator resolves
          each <span className="text-foreground">[[link]]</span> to a real entry
          and wants every entry to carry dated proof.
        </p>
      </div>
    </div>
  );
}
