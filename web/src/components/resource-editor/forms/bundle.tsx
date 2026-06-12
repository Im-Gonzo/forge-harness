"use client";

/**
 * forms/bundle — the Visual form for a context-bundle (bundles/<id>.md).
 *
 * The richest per-kind form: a bundle has 16 required keys plus two optional
 * pointer keys, and three of them are ARRAYS OF MAPS (adrs, spec_sections,
 * invisible_20) with nested scalar arrays. Like every form it is a CONTROLLED
 * component — it reads the live `frontmatter`, coerces it to a typed BundleDraft
 * (forms/bundle/fields), and on every edit re-emits the frontmatter in CANONICAL
 * KEY ORDER via `composeBundleFrontmatter`, so the bridge's writer sees a stable
 * key order and the body stays verbatim.
 *
 * POINTER RESOLVE-STATUS: next to each skill/agent/adr/spec/br pointer the form
 * shows whether it resolves — harness pointers (skill/agent) against the live
 * registry (read-only /api/registry), corpus pointers (adr/spec/br/dod) by shape
 * (resolution is the target repo's job). See forms/bundle/resolve.
 *
 * SERIALIZATION NOTE (the load-bearing detail): a bundle's nested frontmatter
 * cannot be serialized by the generic write cores in a shape `forge validate`
 * accepts (serializeDocument JSON-flows arrays-of-maps; gray-matter block-expands
 * nested scalar arrays — the dependency-free validate-bundles reader rejects
 * both). forms/bundle/serialize-bundle reproduces the hand-authored, VALIDATOR-
 * PARSEABLE style (block mappings + inline nested scalar arrays); the round-trip
 * is proven in scripts/verify-bundle-crud.mjs.
 */

import * as React from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { RegistryArtifact } from "@/lib/types";
import { cn } from "@/lib/utils";

import type { ResourceFormProps } from "../types";
import {
  type AdrPointer,
  type BundleDraft,
  type Invisible20,
  type SpecSection,
  composeBundleFrontmatter,
  toBundleDraft,
  INVARIANT_RANGE,
} from "./bundle/fields";
import {
  type PointerStatus,
  type RegistryIndex,
  type ResolveStatus,
  buildRegistryIndex,
  resolveAdr,
  resolveAgent,
  resolveBrId,
  resolveDodRef,
  resolveSkill,
  resolveSpecSection,
} from "./bundle/resolve";

// ──────────────────────────────────────────────────────────────────────────
// Small presentational helpers
// ──────────────────────────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
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

function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mt-2 flex items-baseline gap-2 border-t border-border pt-4">
      <h3 className="font-mono text-[11px] font-semibold tracking-wide text-foreground">
        {children}
      </h3>
      {hint ? (
        <span className="font-mono text-[10px] text-muted-foreground/60">{hint}</span>
      ) : null}
    </div>
  );
}

/** The colour + glyph for each resolve status. */
const STATUS_STYLE: Record<ResolveStatus, { cls: string; glyph: string }> = {
  resolved: {
    cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-500",
    glyph: "resolved",
  },
  unresolved: {
    cls: "border-destructive/40 bg-destructive/15 text-destructive",
    glyph: "dangling",
  },
  external: {
    cls: "border-sky-500/40 bg-sky-500/15 text-sky-500",
    glyph: "external",
  },
  malformed: {
    cls: "border-amber-500/40 bg-amber-500/15 text-amber-500",
    glyph: "malformed",
  },
  empty: {
    cls: "border-border bg-transparent text-muted-foreground/60",
    glyph: "empty",
  },
};

/** A compact pill that shows a pointer's resolve status + detail on hover. */
function ResolvePill({ status }: { status: PointerStatus }) {
  const s = STATUS_STYLE[status.status];
  return (
    <span
      title={status.detail}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-[10px]",
        s.cls,
      )}
    >
      {s.glyph}
      {status.detail ? (
        <span className="max-w-[18rem] truncate text-[10px] opacity-70">
          {status.detail}
        </span>
      ) : null}
    </span>
  );
}

/** A small "+ add" / "remove" row control set. */
function RowButton({
  children,
  onClick,
  disabled,
  variant = "outline",
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "outline" | "ghost" | "destructive";
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={disabled}
      onClick={onClick}
      className="h-7 font-mono text-[11px]"
    >
      {children}
    </Button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// String-array editor (br_ids, conformance, modules, sections, refs)
// ──────────────────────────────────────────────────────────────────────────

function StringListEditor({
  values,
  onChange,
  placeholder,
  disabled,
  renderStatus,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  disabled?: boolean;
  /** Optional per-item resolve status (e.g. br_ids shape check). */
  renderStatus?: (value: string) => PointerStatus;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {values.map((value, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            className="h-8 font-mono text-xs"
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              onChange(next);
            }}
          />
          {renderStatus ? <ResolvePill status={renderStatus(value)} /> : null}
          <RowButton
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(values.filter((_, j) => j !== i))}
          >
            ✕
          </RowButton>
        </div>
      ))}
      <RowButton disabled={disabled} onClick={() => onChange([...values, ""])}>
        + add
      </RowButton>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// The form
// ──────────────────────────────────────────────────────────────────────────

export default function BundleForm({
  frontmatter,
  onChange,
  isNew,
  disabled,
}: ResourceFormProps) {
  const draft = React.useMemo(() => toBundleDraft(frontmatter), [frontmatter]);

  // ── Live registry index for harness-pointer resolution (read-only) ─────────
  const [index, setIndex] = React.useState<RegistryIndex>(() =>
    buildRegistryIndex([]),
  );
  const [registryLoaded, setRegistryLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/registry", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { data?: { artifacts?: RegistryArtifact[] } }) => {
        if (cancelled) return;
        setIndex(buildRegistryIndex(j?.data?.artifacts));
        setRegistryLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setRegistryLoaded(true); // resolved-with-no-data; pills show "dangling"
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Emit the next frontmatter from a mutated draft (canonical key order). */
  const emit = React.useCallback(
    (next: BundleDraft) => onChange(composeBundleFrontmatter(next)),
    [onChange],
  );

  /** Patch one top-level draft field and emit. */
  function set<K extends keyof BundleDraft>(key: K, value: BundleDraft[K]) {
    emit({ ...draft, [key]: value });
  }

  // ── invariants checkbox grid (1..10) ──────────────────────────────────────
  function toggleInvariant(n: number) {
    const has = draft.invariants.includes(n);
    const next = has
      ? draft.invariants.filter((x) => x !== n)
      : [...draft.invariants, n].sort((a, b) => a - b);
    set("invariants", next);
  }

  // ── adrs (array of maps) ───────────────────────────────────────────────────
  function patchAdr(i: number, patch: Partial<AdrPointer>) {
    const next = draft.adrs.map((a, j) => (j === i ? { ...a, ...patch } : a));
    set("adrs", next);
  }

  // ── spec_sections (array of maps with nested scalar array) ─────────────────
  function patchSpec(i: number, patch: Partial<SpecSection>) {
    const next = draft.spec_sections.map((s, j) =>
      j === i ? { ...s, ...patch } : s,
    );
    set("spec_sections", next);
  }

  // ── invisible_20 (array of maps with nested refs array) ────────────────────
  function patchInv(i: number, patch: Partial<Invisible20>) {
    const next = draft.invisible_20.map((v, j) =>
      j === i ? { ...v, ...patch } : v,
    );
    set("invisible_20", next);
  }

  const registryHint = registryLoaded
    ? `${index.skills.size} skills · ${index.agents.size} agents in registry`
    : "loading registry…";

  return (
    <div className="flex flex-col gap-5">
      {/* ── Identity ───────────────────────────────────────────────────────── */}
      <SectionTitle hint="bundle identity + lifecycle">identity</SectionTitle>

      <Field label="id" hint={isNew ? "must match the file id" : undefined}>
        <Input
          value={draft.id}
          disabled={disabled}
          placeholder="walking-skeleton"
          onChange={(e) => set("id", e.target.value)}
        />
      </Field>

      <Field label="title" hint="human-readable bundle title">
        <Textarea
          value={draft.title}
          disabled={disabled}
          rows={2}
          placeholder="Stand up the spine — the first end-to-end vertical slice"
          onChange={(e) => set("title", e.target.value)}
        />
      </Field>

      <div className="grid grid-cols-3 gap-3">
        <Field label="version">
          <Input
            type="number"
            min={1}
            value={String(draft.version)}
            disabled={disabled}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              set("version", Number.isInteger(n) && n >= 1 ? n : 1);
            }}
          />
        </Field>
        <Field label="status">
          <Input
            value={draft.status}
            disabled={disabled}
            placeholder="active"
            onChange={(e) => set("status", e.target.value)}
          />
        </Field>
        <Field label="work_type" hint="gated types ⇒ human_gate">
          <Input
            value={draft.work_type}
            disabled={disabled}
            placeholder="walking-skeleton"
            onChange={(e) => set("work_type", e.target.value)}
          />
        </Field>
      </div>

      {/* ── invariants (1..10 checkbox grid) ───────────────────────────────── */}
      <Field
        label="invariants"
        hint={`${draft.invariants.length} selected — a non-empty subset of 1..10`}
      >
        <div className="flex flex-wrap gap-1.5">
          {INVARIANT_RANGE.map((n) => {
            const active = draft.invariants.includes(n);
            return (
              <button
                key={n}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => toggleInvariant(n)}
                className={cn(
                  "h-8 w-8 rounded-md border font-mono text-xs transition-colors",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-50",
                  active
                    ? "border-primary/50 bg-primary/15 text-foreground"
                    : "border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {n}
              </button>
            );
          })}
        </div>
      </Field>

      {/* ── Pointers: skill / agent (harness — registry resolution) ────────── */}
      <SectionTitle hint={registryHint}>
        harness pointers — resolved against the registry
      </SectionTitle>

      <Field label="skill" hint="primary harness skill (.claude/skills/<id>/SKILL.md)">
        <div className="flex items-center gap-1.5">
          <Input
            value={draft.skill}
            disabled={disabled}
            placeholder=".claude/skills/load-bundle/SKILL.md"
            className="font-mono text-xs"
            onChange={(e) => set("skill", e.target.value)}
          />
          <ResolvePill status={resolveSkill(draft.skill, index)} />
        </div>
      </Field>

      <Field label="secondary_skill" hint="optional — blank omits the key">
        <div className="flex items-center gap-1.5">
          <Input
            value={draft.secondary_skill}
            disabled={disabled}
            placeholder=".claude/skills/new-bundle/SKILL.md"
            className="font-mono text-xs"
            onChange={(e) => set("secondary_skill", e.target.value)}
          />
          {draft.secondary_skill.trim() !== "" ? (
            <ResolvePill status={resolveSkill(draft.secondary_skill, index)} />
          ) : null}
        </div>
      </Field>

      <Field label="agent" hint="primary implementer agent (.claude/agents/<id>.md)">
        <div className="flex items-center gap-1.5">
          <Input
            value={draft.agent}
            disabled={disabled}
            placeholder=".claude/agents/code-reviewer.md"
            className="font-mono text-xs"
            onChange={(e) => set("agent", e.target.value)}
          />
          <ResolvePill status={resolveAgent(draft.agent, index)} />
        </div>
      </Field>

      <Field label="reviewer" hint="optional — blank omits the key">
        <div className="flex items-center gap-1.5">
          <Input
            value={draft.reviewer}
            disabled={disabled}
            placeholder=".claude/agents/diff-reviewer.md"
            className="font-mono text-xs"
            onChange={(e) => set("reviewer", e.target.value)}
          />
          {draft.reviewer.trim() !== "" ? (
            <ResolvePill status={resolveAgent(draft.reviewer, index)} />
          ) : null}
        </div>
      </Field>

      {/* ── adrs (array of maps; corpus — external resolution) ─────────────── */}
      <SectionTitle hint="pointers into the target project's corpus (shape-checked here)">
        adrs
      </SectionTitle>
      <div className="flex flex-col gap-3">
        {draft.adrs.map((adr, i) => (
          <div
            key={i}
            className="flex flex-col gap-1.5 rounded-lg border border-border p-3"
          >
            <div className="flex items-center gap-1.5">
              <Input
                value={adr.id}
                disabled={disabled}
                placeholder="ADR-0001"
                className="h-8 w-40 font-mono text-xs"
                onChange={(e) => patchAdr(i, { id: e.target.value })}
              />
              <Input
                value={adr.path}
                disabled={disabled}
                placeholder="docs/adr/ADR-0001-architecture-baseline.md"
                className="h-8 font-mono text-xs"
                onChange={(e) => patchAdr(i, { path: e.target.value })}
              />
              <ResolvePill status={resolveAdr(adr.id, adr.path)} />
              <RowButton
                variant="ghost"
                disabled={disabled}
                onClick={() => set("adrs", draft.adrs.filter((_, j) => j !== i))}
              >
                ✕
              </RowButton>
            </div>
            <Input
              value={adr.why ?? ""}
              disabled={disabled}
              placeholder="why (optional) — what this ADR fixes for the slice"
              className="h-8 text-xs"
              onChange={(e) =>
                patchAdr(i, { why: e.target.value === "" ? undefined : e.target.value })
              }
            />
          </div>
        ))}
        <RowButton
          disabled={disabled}
          onClick={() => set("adrs", [...draft.adrs, { id: "", path: "" }])}
        >
          + add adr
        </RowButton>
      </div>

      {/* ── spec_sections (array of maps with nested sections array) ──────── */}
      <SectionTitle hint="referenced spec files + the relevant sections">
        spec_sections
      </SectionTitle>
      <div className="flex flex-col gap-3">
        {draft.spec_sections.map((spec, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-lg border border-border p-3"
          >
            <div className="flex items-center gap-1.5">
              <Input
                value={spec.path}
                disabled={disabled}
                placeholder="docs/specs/architecture.md"
                className="h-8 font-mono text-xs"
                onChange={(e) => patchSpec(i, { path: e.target.value })}
              />
              <ResolvePill status={resolveSpecSection(spec.path)} />
              <RowButton
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  set("spec_sections", draft.spec_sections.filter((_, j) => j !== i))
                }
              >
                ✕
              </RowButton>
            </div>
            <div className="pl-3">
              <p className="mb-1 font-mono text-[10px] text-muted-foreground/60">
                sections
              </p>
              <StringListEditor
                values={spec.sections}
                disabled={disabled}
                placeholder="the spine: request -> write path -> persistence -> read"
                onChange={(sections) => patchSpec(i, { sections })}
              />
            </div>
          </div>
        ))}
        <RowButton
          disabled={disabled}
          onClick={() =>
            set("spec_sections", [...draft.spec_sections, { path: "", sections: [] }])
          }
        >
          + add spec section
        </RowButton>
      </div>

      {/* ── br_ids / conformance / modules (scalar arrays) ─────────────────── */}
      <SectionTitle>br_ids</SectionTitle>
      <StringListEditor
        values={draft.br_ids}
        disabled={disabled}
        placeholder="BR-CORE-001"
        onChange={(v) => set("br_ids", v)}
        renderStatus={(v) => resolveBrId(v)}
      />

      <SectionTitle hint="conformance assertions (usually spec-section refs)">
        conformance
      </SectionTitle>
      <StringListEditor
        values={draft.conformance}
        disabled={disabled}
        placeholder="docs/METHOD.md#2"
        onChange={(v) => set("conformance", v)}
      />

      <SectionTitle hint="code modules this bundle touches">modules</SectionTitle>
      <StringListEditor
        values={draft.modules}
        disabled={disabled}
        placeholder="the-spine-end-to-end"
        onChange={(v) => set("modules", v)}
      />

      {/* ── dod_ref ────────────────────────────────────────────────────────── */}
      <SectionTitle>dod_ref</SectionTitle>
      <Field label="dod_ref" hint="definition-of-done reference (path#anchor)">
        <div className="flex items-center gap-1.5">
          <Input
            value={draft.dod_ref}
            disabled={disabled}
            placeholder="docs/specs/architecture.md#walking-skeleton-definition-of-done"
            className="font-mono text-xs"
            onChange={(e) => set("dod_ref", e.target.value)}
          />
          <ResolvePill status={resolveDodRef(draft.dod_ref)} />
        </div>
      </Field>

      {/* ── invisible_20 (array of maps with nested refs array) ───────────── */}
      <SectionTitle hint="the non-obvious rules that must hold but are easy to miss">
        invisible_20
      </SectionTitle>
      <div className="flex flex-col gap-3">
        {draft.invisible_20.map((inv, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-lg border border-border p-3"
          >
            <div className="flex items-center gap-1.5">
              <Input
                value={inv.id}
                disabled={disabled}
                placeholder="INV-1"
                className="h-8 w-32 font-mono text-xs"
                onChange={(e) => patchInv(i, { id: e.target.value })}
              />
              <RowButton
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  set("invisible_20", draft.invisible_20.filter((_, j) => j !== i))
                }
              >
                ✕
              </RowButton>
            </div>
            <Textarea
              value={inv.rule}
              disabled={disabled}
              rows={2}
              placeholder="rule — Every state change goes through the ONE canonical write path."
              className="text-xs"
              onChange={(e) => patchInv(i, { rule: e.target.value })}
            />
            <Textarea
              value={inv.check ?? ""}
              disabled={disabled}
              rows={2}
              placeholder="check (optional) — the test that proves the rule holds."
              className="text-xs"
              onChange={(e) =>
                patchInv(i, {
                  check: e.target.value === "" ? undefined : e.target.value,
                })
              }
            />
            <div className="pl-3">
              <p className="mb-1 font-mono text-[10px] text-muted-foreground/60">
                refs
              </p>
              <StringListEditor
                values={inv.refs}
                disabled={disabled}
                placeholder="docs/adr/ADR-0003-single-write-path.md"
                onChange={(refs) => patchInv(i, { refs })}
              />
            </div>
          </div>
        ))}
        <RowButton
          disabled={disabled}
          onClick={() =>
            set("invisible_20", [
              ...draft.invisible_20,
              { id: "", rule: "", refs: [] },
            ])
          }
        >
          + add invisible-20 entry
        </RowButton>
      </div>

      {/* ── human_gate ─────────────────────────────────────────────────────── */}
      <SectionTitle hint="true for tenancy/RLS, core write-path, and v1->v2 migration work">
        human_gate
      </SectionTitle>
      <Field
        label="human_gate"
        hint="propose-then-STOP for a human before applying"
      >
        <Select
          value={draft.human_gate ? "true" : "false"}
          onValueChange={(v) => set("human_gate", v === "true")}
        >
          <SelectTrigger className="w-56" disabled={disabled}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="false">false — autonomous</SelectItem>
            <SelectItem value="true">true — human-gated</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
