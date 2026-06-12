"use client";

/**
 * forms/rule — the Visual form for a rule (rules/**\/*.md frontmatter).
 *
 * A rule scopes craft standards. Its editable frontmatter is small and FLAT:
 *   name         — the rule id (matches the file)
 *   description   — when/why it applies (read by the agent that enforces it)
 *   paths         — an OPTIONAL list of globs; absent ⇒ the rule is ALWAYS-ON.
 *                   validate-rules.mjs requires `paths`, if present, to be a
 *                   NON-EMPTY list of glob strings (a scalar `paths: "*.py"` is an
 *                   ERROR), so this form models it as an array and OMITS the key
 *                   entirely when the list is empty (clean always-on frontmatter).
 *
 * The signature feature is a LIVE "which files match" preview: as the glob list
 * changes (debounced), it POSTs the current globs to /api/rule-matches, which
 * walks FORGE_ROOT and returns the repo-relative files those globs scope. This
 * turns an abstract glob into a tangible file set before the rule is saved.
 *
 * CONTROLLED + KEY-ORDER-PRESERVING (like forms/agent): it spreads the incoming
 * frontmatter and overwrites only the edited key, so the bridge's minimal-diff
 * sees a stable key order and the body stays verbatim.
 */
import * as React from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type { ResourceFormProps } from "../types";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Common glob presets, one click to append (mirrors the rules/** conventions). */
const PRESETS: { label: string; glob: string }[] = [
  { label: "TS", glob: "**/*.ts" },
  { label: "TSX", glob: "**/*.tsx" },
  { label: "PY", glob: "**/*.py" },
  { label: "SQL", glob: "**/*.sql" },
  { label: "MD", glob: "**/*.md" },
];

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

interface MatchResult {
  patterns: string[];
  matches: string[];
  total: number;
  truncated: boolean;
  scanned: number;
}

/** Live "which files match" preview — debounced fetch of /api/rule-matches. */
function MatchPreview({ paths }: { paths: string[] }) {
  const [result, setResult] = React.useState<MatchResult | null>(null);
  const [state, setState] = React.useState<"idle" | "loading" | "error">(
    "idle",
  );

  // Stable key so the effect only re-fires when the GLOBS actually change.
  const key = React.useMemo(() => JSON.stringify(paths), [paths]);

  // The effect ONLY subscribes to an external system (the debounced fetch); it
  // never calls setState synchronously in its body (react-hooks/set-state-in-effect).
  // The no-globs case is handled in render (early return), so the effect simply
  // does not schedule a fetch when there is nothing to match.
  React.useEffect(() => {
    const globs = (JSON.parse(key) as string[])
      .map((g) => g.trim())
      .filter(Boolean);
    if (globs.length === 0) return;

    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState("loading");
      fetch("/api/rule-matches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: globs }),
        cache: "no-store",
        signal: controller.signal,
      })
        .then((res) => res.json())
        .then((json: MatchResult & { ok?: boolean; error?: string }) => {
          if (cancelled) return;
          if (json && json.ok !== false && Array.isArray(json.matches)) {
            setResult({
              patterns: json.patterns ?? globs,
              matches: json.matches,
              total: json.total ?? json.matches.length,
              truncated: Boolean(json.truncated),
              scanned: json.scanned ?? 0,
            });
            setState("idle");
          } else {
            setState("error");
          }
        })
        .catch((err: unknown) => {
          if (cancelled || (err as Error)?.name === "AbortError") return;
          setState("error");
        });
    }, 300);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [key]);

  const activeGlobs = (JSON.parse(key) as string[])
    .map((g) => g.trim())
    .filter(Boolean);

  if (activeGlobs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-3">
        <p className="font-mono text-[11px] text-muted-foreground">
          No <span className="text-foreground">paths</span> globs — this rule is{" "}
          <span className="text-foreground">always-on</span> (applies everywhere;
          the key is omitted).
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-background/50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-mono text-[11px] text-muted-foreground">
          which files match{" "}
          <span className="text-muted-foreground/60">(live, under FORGE_ROOT)</span>
        </p>
        {state === "loading" ? (
          <span className="font-mono text-[10px] text-muted-foreground/60">
            scanning…
          </span>
        ) : state === "error" ? (
          <Badge
            variant="outline"
            className="border-destructive/40 bg-destructive/15 font-mono text-[10px] text-destructive"
          >
            preview failed
          </Badge>
        ) : result ? (
          <Badge variant="secondary" className="font-mono text-[10px]">
            {result.total} match{result.total === 1 ? "" : "es"}
            {result.scanned ? ` / ${result.scanned} files` : ""}
          </Badge>
        ) : null}
      </div>

      {result && result.matches.length > 0 ? (
        <>
          <ul className="max-h-44 overflow-auto rounded-md border border-border/60 bg-background p-2">
            {result.matches.map((m) => (
              <li
                key={m}
                className="truncate font-mono text-[11px] leading-relaxed text-foreground/90"
                title={m}
              >
                {m}
              </li>
            ))}
          </ul>
          {result.truncated ? (
            <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/60">
              showing the first {result.matches.length} of {result.total} —
              refine the globs to narrow.
            </p>
          ) : null}
        </>
      ) : result ? (
        <p className="font-mono text-[11px] text-muted-foreground">
          No files under FORGE_ROOT match these globs yet.
        </p>
      ) : state === "loading" ? (
        <p className="font-mono text-[11px] text-muted-foreground/60">
          scanning the tree…
        </p>
      ) : null}
    </div>
  );
}

export default function RuleForm({
  frontmatter,
  onChange,
  isNew,
  disabled,
}: ResourceFormProps) {
  const name = asString(frontmatter.name);
  const description = asString(frontmatter.description);
  const paths = asStringArray(frontmatter.paths);

  const [draftGlob, setDraftGlob] = React.useState("");

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

  /** Write the globs back, OMITTING the key entirely when the list is empty
   *  (an empty `paths` is a validate ERROR; absent = valid always-on rule). */
  function setPaths(nextPaths: string[]) {
    setKey("paths", nextPaths.length > 0 ? nextPaths : undefined);
  }

  function addGlob(glob: string) {
    const g = glob.trim();
    if (g === "" || paths.includes(g)) return;
    setPaths([...paths, g]);
  }

  function removeGlob(glob: string) {
    setPaths(paths.filter((p) => p !== glob));
  }

  function commitDraft() {
    if (draftGlob.trim() === "") return;
    addGlob(draftGlob);
    setDraftGlob("");
  }

  return (
    <div className="flex flex-col gap-5">
      <Field label="name" hint={isNew ? "must match the file id" : undefined}>
        <Input
          value={name}
          disabled={disabled}
          placeholder="my-rule"
          onChange={(e) => setKey("name", e.target.value)}
        />
      </Field>

      <Field label="description" hint="when + why this rule applies">
        <Textarea
          value={description}
          disabled={disabled}
          rows={3}
          placeholder="Always-on language-agnostic coding style. The reviewer enforces it."
          onChange={(e) => setKey("description", e.target.value)}
        />
      </Field>

      <Field
        label="paths"
        hint={
          paths.length > 0
            ? `${paths.length} glob${paths.length === 1 ? "" : "s"} — scoped`
            : "empty = always-on (key omitted)"
        }
      >
        {/* Current globs as removable chips. */}
        {paths.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {paths.map((glob) => (
              <span
                key={glob}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/50 bg-primary/15 py-1 pr-1 pl-2 font-mono text-[11px] text-foreground"
              >
                {glob}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`remove ${glob}`}
                  onClick={() => removeGlob(glob)}
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

        {/* Add a glob — type + Enter, or a preset chip. */}
        <div className="flex items-center gap-1.5">
          <Input
            value={draftGlob}
            disabled={disabled}
            placeholder="**/*.ts"
            className="font-mono text-xs"
            onChange={(e) => setDraftGlob(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitDraft();
              }
            }}
            aria-label="add a paths glob"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || draftGlob.trim() === ""}
            onClick={commitDraft}
          >
            Add
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => {
            const active = paths.includes(preset.glob);
            return (
              <button
                key={preset.glob}
                type="button"
                disabled={disabled || active}
                onClick={() => addGlob(preset.glob)}
                title={preset.glob}
                className={cn(
                  "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  "disabled:pointer-events-none disabled:opacity-40",
                  "border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                + {preset.label}
              </button>
            );
          })}
        </div>
      </Field>

      {/* Live "which files match" preview. */}
      <MatchPreview paths={paths} />
    </div>
  );
}
