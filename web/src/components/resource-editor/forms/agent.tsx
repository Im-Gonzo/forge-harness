"use client";

/**
 * forms/agent — the REFERENCE Visual form (agents/*.md frontmatter).
 *
 * This is the canonical example every other per-kind form copies: a CONTROLLED
 * component that reads the live `frontmatter` and emits the next frontmatter via
 * `onChange`. It edits ONLY structured frontmatter (name, description, tools,
 * model) — never the body, which the shell keeps verbatim. It is resolved by
 * CONVENTION (the shell dynamic-imports `forms/agent` for kind "agent"); there is
 * no registry file to edit when a new `forms/<kind>.tsx` is added.
 *
 * KEY-ORDER PRESERVATION: it never reorders or drops keys it doesn't own — it
 * spreads the incoming frontmatter and overwrites only the edited key, so the
 * bridge's minimal-diff (frontmatter-edit-core) sees a stable key order.
 */
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { ResourceFormProps } from "../types";

/** The tools an agent may be granted (Claude Code's built-in tool surface). */
const TOOL_OPTIONS = [
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
  "NotebookEdit",
] as const;

/** Model intent — the three tiers plus "inherit" (omit the key → inherit). */
const MODEL_OPTIONS = [
  { value: "inherit", label: "inherit (from caller)" },
  { value: "haiku", label: "haiku" },
  { value: "sonnet", label: "sonnet" },
  { value: "opus", label: "opus" },
] as const;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Field label + control row. */
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

export default function AgentForm({
  frontmatter,
  onChange,
  isNew,
  disabled,
}: ResourceFormProps) {
  const name = asString(frontmatter.name);
  const description = asString(frontmatter.description);
  const tools = asStringArray(frontmatter.tools);
  // Absent model ⇒ "inherit"; "inherit" selection ⇒ omit the key.
  const model = asString(frontmatter.model) || "inherit";

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

  function toggleTool(tool: string) {
    const has = tools.includes(tool);
    const nextTools = has
      ? tools.filter((t) => t !== tool)
      : [...tools, tool];
    // Keep the key even when empty? An agent with no tools is unusual; omit the
    // key when empty so the frontmatter stays clean (inherit-all semantics).
    setKey("tools", nextTools.length > 0 ? nextTools : undefined);
  }

  function setModel(value: string) {
    // "inherit" ⇒ omit the key entirely (do not write model: inherit).
    setKey("model", value === "inherit" ? undefined : value);
  }

  return (
    <div className="flex flex-col gap-5">
      <Field label="name" hint={isNew ? "must match the file id" : undefined}>
        <Input
          value={name}
          disabled={disabled}
          placeholder="my-agent"
          onChange={(e) => setKey("name", e.target.value)}
        />
      </Field>

      <Field label="description" hint="when + how this agent is invoked">
        <Textarea
          value={description}
          disabled={disabled}
          rows={4}
          placeholder="Use PROACTIVELY when … READ-ONLY — never edits."
          onChange={(e) => setKey("description", e.target.value)}
        />
      </Field>

      <Field label="tools" hint={`${tools.length} selected — empty = inherit all`}>
        <div className="flex flex-wrap gap-1.5">
          {TOOL_OPTIONS.map((tool) => {
            const active = tools.includes(tool);
            return (
              <button
                key={tool}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => toggleTool(tool)}
                className={cn(
                  "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-50",
                  active
                    ? "border-primary/50 bg-primary/15 text-foreground"
                    : "border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {tool}
              </button>
            );
          })}
        </div>
      </Field>

      <Field label="model" hint="resource tier — inherit omits the key">
        <Select value={model} onValueChange={(v) => setModel(v as string)}>
          <SelectTrigger className="w-56" disabled={disabled}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODEL_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
