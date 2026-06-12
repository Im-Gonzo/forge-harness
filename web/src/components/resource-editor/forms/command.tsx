"use client";

/**
 * forms/command — Visual form for commands/<id>.md frontmatter.
 *
 * Resolved by CONVENTION (the shell dynamic-imports `forms/command` for kind
 * "command"). Like the reference `forms/agent`, this is a CONTROLLED component
 * that reads the live `frontmatter` and emits the next frontmatter via
 * `onChange`; the body (the `/command` prose) is owned by the shell / Raw tab and
 * kept verbatim. A command's structured frontmatter (command.schema.json →
 * CommandFrontmatter) is `description` (required) + the optional `argument-hint`
 * and `allowed-tools`.
 *
 * allowed-tools SHAPE: on disk this is a COMMA-SEPARATED string (e.g.
 * "Bash, Read, Skill") — NOT a YAML array. This form reads/writes that exact
 * string form (parse on read, join on write) so the minimal-diff writer emits
 * the same bytes the harness already uses. Omitting all tools deletes the key
 * (inherit the full tool surface).
 *
 * KEY-ORDER PRESERVATION: it spreads the incoming frontmatter and overwrites only
 * the edited key (deleting on empty for the optional keys), so the bridge's
 * minimal-diff (frontmatter-edit-core) sees a stable key order.
 */
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import type { ResourceFormProps } from "../types";

/** Tools a slash-command may allow (Claude Code's built-in tool surface). */
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
  "Skill",
  "NotebookEdit",
] as const;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse the comma-separated `allowed-tools` string into a tool list. Whitespace
 * around each token is trimmed; empties are dropped. Order is preserved.
 */
function parseTools(v: unknown): string[] {
  return asString(v)
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
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

export default function CommandForm({
  frontmatter,
  onChange,
  isNew,
  disabled,
}: ResourceFormProps) {
  const description = asString(frontmatter.description);
  const argumentHint = asString(frontmatter["argument-hint"]);
  const tools = parseTools(frontmatter["allowed-tools"]);

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

  /** Optional string key: write trimmed value, or delete the key when empty. */
  function setOptionalString(key: string, raw: string) {
    setKey(key, raw.trim() === "" ? undefined : raw);
  }

  function toggleTool(tool: string) {
    const has = tools.includes(tool);
    const nextTools = has
      ? tools.filter((t) => t !== tool)
      : [...tools, tool];
    // allowed-tools is a comma-separated STRING on disk; omit the key when empty
    // (the command then inherits the full tool surface).
    setKey(
      "allowed-tools",
      nextTools.length > 0 ? nextTools.join(", ") : undefined,
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="description"
        hint="what the command does (shown in the / menu)"
      >
        <Textarea
          value={description}
          disabled={disabled}
          rows={4}
          placeholder="Read-only health check of … Reports only; fixes solely with --fix."
          onChange={(e) => setKey("description", e.target.value)}
        />
      </Field>

      <Field
        label="argument-hint"
        hint="optional — the $ARGUMENTS shape shown after the command"
      >
        <Input
          value={argumentHint}
          disabled={disabled}
          placeholder="[--fix] (apply safe repairs instead of reporting only)"
          onChange={(e) => setOptionalString("argument-hint", e.target.value)}
        />
      </Field>

      <Field
        label="allowed-tools"
        hint={`${tools.length} selected — empty = inherit all`}
      >
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

      {isNew ? (
        <p className="font-mono text-[11px] text-muted-foreground/60">
          The command id is the file name (commands/&lt;id&gt;.md); the body —
          edited in the Raw tab — is the prompt the slash-command runs.
        </p>
      ) : null}
    </div>
  );
}
