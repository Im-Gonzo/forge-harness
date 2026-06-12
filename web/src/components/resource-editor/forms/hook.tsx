"use client";

/**
 * forms/hook — the HOOK lifecycle BOARD (Visual form for kind "hook").
 *
 * Hooks are matcher-groups inside a SHARED JSON file (hooks/hooks.json), not a
 * one-file-per-resource markdown like agents/skills — so this form does NOT use
 * the shell's generic write path (CRUD refuses kind "hook"). It is a self-driving
 * board over its OWN server surface (/api/hook-test):
 *
 *   • COLUMNS  — one per lifecycle event (SessionStart / PreToolUse / PostToolUse
 *                / Stop / …), each holding the hook CARDS that fire on it.
 *   • CARDS    — matcher · command · timeout · id, read from hooks.json. Clicking
 *                a card selects it for editing.
 *   • EDIT     — change the selected hook's fields; a field edit is a MINIMAL-DIFF
 *                JSON write (jsonc-parser, server-side) → forge validate → registry
 *                build. The body .mjs is editable in an embedded Monaco panel.
 *   • TEST     — pipe a SAMPLE stdin payload to the hook's script and show its
 *                allow / DENY verdict. READ-ONLY: it never mutates anything (e.g.
 *                the "planted secret" sample makes secret-scan DENY).
 *
 * It still honors the controlled-component contract (it mirrors the selected
 * hook's frontmatter through `onChange` so the shell's draft stays coherent), but
 * all WRITES happen through this board's buttons, not the shell's Save.
 */
import * as React from "react";
import dynamic from "next/dynamic";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

// Monaco is heavy + browser-only — lazy, client-side only (as the shell does).
const MonacoEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.default),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center font-mono text-xs text-muted-foreground">
        Loading editor…
      </div>
    ),
  },
);

// ── Board model (mirrors /api/hook-test 'read' response) ────────────────────

interface HookCard {
  id: string;
  event: string;
  index: number;
  matcher: string;
  description: string;
  command: string;
  timeout: number | null;
  async: boolean;
  scriptRel: string | null;
}

interface BoardData {
  events: string[];
  board: HookCard[];
}

interface TestResult {
  verdict: "deny" | "allow" | "error";
  reason: string | null;
  exitCode: number | null;
  payloadKey: string;
  stderr: string;
}

/** The sample stdin payloads the board can pipe to a hook (mirrors the route). */
const SAMPLE_PAYLOADS = [
  { key: "planted-secret", label: "planted secret (should DENY)" },
  { key: "clean-write", label: "clean Write (should allow)" },
  { key: "no-verify-bash", label: "git --no-verify (should DENY)" },
  { key: "session-start", label: "SessionStart event" },
] as const;

async function postHookTest<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/hook-test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = (await res.json()) as T & { ok?: boolean; error?: string };
  if (!res.ok || json.error) {
    throw new Error(json.error ?? `Request failed (${res.status}).`);
  }
  return json;
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
          <span className="ml-1.5 font-normal text-muted-foreground/60">{hint}</span>
        ) : null}
      </label>
      {children}
    </div>
  );
}

export default function HookForm({ id, onChange, disabled }: ResourceFormProps) {
  const [data, setData] = React.useState<BoardData | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string>(id);

  // Per-hook .mjs source (the selected card's script).
  const [mjsRel, setMjsRel] = React.useState<string | null>(null);
  const [mjsSource, setMjsSource] = React.useState<string>("");
  const [mjsDirty, setMjsDirty] = React.useState(false);

  // Pending field edits (controlled inputs), keyed by field name.
  const [edits, setEdits] = React.useState<Record<string, string>>({});

  const [busy, setBusy] = React.useState<null | string>(null); // a label while writing
  const [testResult, setTestResult] = React.useState<TestResult | null>(null);
  const [samplePayload, setSamplePayload] =
    React.useState<string>("planted-secret");

  const blocked = disabled || busy !== null;

  // ── Load the board (and the selected hook's mjs) ──────────────────────────
  // `load` is a PURE fetcher (no setState); `applyLoad` projects the result into
  // state. Splitting them keeps setState OUT of the effect's direct call path
  // (it runs only AFTER the await, behind a cancellation guard) — the codebase's
  // accepted fetch-in-effect shape (cf. forms/rule.tsx).
  const load = React.useCallback(async (focusId: string) => {
    return postHookTest<BoardData & { mjs: { rel: string; source: string } | null }>(
      { action: "read", id: focusId },
    );
  }, []);

  const applyLoad = React.useCallback(
    (json: BoardData & { mjs: { rel: string; source: string } | null }) => {
      setData({ events: json.events, board: json.board });
      setLoadError(null);
      if (json.mjs) {
        setMjsRel(json.mjs.rel);
        setMjsSource(json.mjs.source);
        setMjsDirty(false);
      } else {
        setMjsRel(null);
        setMjsSource("");
      }
      setEdits({}); // reset pending field edits to the freshly-read values
    },
    [],
  );

  React.useEffect(() => {
    let cancelled = false;
    load(selectedId)
      .then((json) => {
        if (!cancelled) applyLoad(json);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [load, applyLoad, selectedId]);

  const selected = React.useMemo(
    () => data?.board.find((c) => c.id === selectedId) ?? null,
    [data, selectedId],
  );

  // Mirror the selected hook into the shell's controlled frontmatter (coherence
  // only — the shell's Save is not the hook write path; this board's buttons are).
  React.useEffect(() => {
    if (!selected) return;
    onChange({
      id: selected.id,
      event: selected.event,
      matcher: selected.matcher,
      description: selected.description,
    });
  }, [selected, onChange]);

  function fieldValue(field: keyof HookCard): string {
    if (field in edits) return edits[field];
    const v = selected?.[field];
    if (v === null || v === undefined) return "";
    return String(v);
  }

  function setField(field: string, value: string) {
    setEdits((e) => ({ ...e, [field]: value }));
  }

  // ── Write a single field (minimal-diff JSON) ──────────────────────────────
  async function saveField(field: string) {
    if (!selected) return;
    let value: string | number | null = edits[field] ?? "";
    if (field === "timeout") {
      const n = Number(value);
      if (value === "" ) {
        value = null; // empty ⇒ delete the timeout key
      } else if (!Number.isFinite(n) || n < 0) {
        toast.error("timeout must be a number ≥ 0.");
        return;
      } else {
        value = n;
      }
    }
    setBusy(`Saving ${field}…`);
    try {
      const res = await postHookTest<{
        ok: boolean;
        changed: boolean;
        findings: { level: string }[];
      }>({ action: "edit-field", id: selected.id, field, value });
      const warns = (res.findings ?? []).filter((f) => f.level === "WARN").length;
      if (res.ok) {
        toast.success(
          `Saved ${field}${res.changed ? "" : " (no change)"}${
            warns ? ` · ${warns} warning${warns > 1 ? "s" : ""}` : ""
          }`,
        );
      } else {
        const errs = (res.findings ?? []).filter((f) => f.level === "ERROR").length;
        toast.error(`validate FAIL — ${errs} error${errs === 1 ? "" : "s"} (written; revert manually if needed).`);
      }
      // editing id changes the addressable id → re-focus the (possibly) new id.
      // Reload explicitly so an in-place field edit (same id) still re-reads the
      // fresh value; setSelectedId keeps the board focused on the right card.
      const nextFocus = field === "id" && value ? String(value) : selected.id;
      setSelectedId(nextFocus);
      applyLoad(await load(nextFocus));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // ── Save the .mjs body ────────────────────────────────────────────────────
  async function saveMjs() {
    if (!mjsRel) return;
    setBusy("Saving script…");
    try {
      const res = await postHookTest<{ ok: boolean; findings: { level: string }[] }>({
        action: "save-mjs",
        scriptRel: mjsRel,
        source: mjsSource,
      });
      if (res.ok) {
        toast.success(`Saved ${mjsRel}`);
        setMjsDirty(false);
      } else {
        const errs = (res.findings ?? []).filter((f) => f.level === "ERROR").length;
        toast.error(`validate FAIL — ${errs} error${errs === 1 ? "" : "s"}.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // ── Test vs sample stdin (no mutation) ────────────────────────────────────
  async function runTest() {
    if (!selected) return;
    setBusy("Testing…");
    setTestResult(null);
    try {
      const res = await postHookTest<TestResult>({
        action: "test",
        id: selected.id,
        payloadKey: samplePayload,
      });
      setTestResult(res);
      if (res.verdict === "deny") {
        toast.error(`DENY — the hook blocked the sample input.`);
      } else if (res.verdict === "error") {
        toast.error(`Hook errored (exit ${res.exitCode ?? "?"}).`);
      } else {
        toast.success(`ALLOW — the hook permitted the sample input.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4">
        <p className="font-mono text-xs text-destructive">
          Could not load the hooks board: {loadError}
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <p className="font-mono text-xs text-muted-foreground">Loading lifecycle board…</p>
    );
  }

  // Columns: only events that actually have at least one hook (keeps the board tight),
  // but always in the canonical lifecycle order returned by the API.
  const usedEvents = data.events.filter((ev) =>
    data.board.some((c) => c.event === ev),
  );

  return (
    <div className="flex flex-col gap-6">
      {/* ── Lifecycle board ─────────────────────────────────────────────── */}
      <div>
        <p className="mb-2 font-mono text-[11px] font-medium text-muted-foreground">
          lifecycle board{" "}
          <span className="font-normal text-muted-foreground/60">
            (event columns · click a card to edit · {data.board.length} hook
            {data.board.length === 1 ? "" : "s"})
          </span>
        </p>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {usedEvents.map((event) => {
            const cards = data.board.filter((c) => c.event === event);
            return (
              <div
                key={event}
                className="flex w-60 shrink-0 flex-col gap-2 rounded-lg border border-border bg-background/40 p-2"
              >
                <div className="flex items-center justify-between px-0.5">
                  <span className="font-mono text-[11px] font-medium text-foreground">
                    {event}
                  </span>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {cards.length}
                  </Badge>
                </div>
                {cards.map((card) => {
                  const active = card.id === selectedId;
                  return (
                    <button
                      key={card.id}
                      type="button"
                      onClick={() => setSelectedId(card.id)}
                      className={cn(
                        "flex flex-col gap-1 rounded-md border p-2 text-left transition-colors",
                        "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                        active
                          ? "border-primary/50 bg-primary/10"
                          : "border-border bg-card hover:bg-muted",
                      )}
                    >
                      <span className="truncate font-mono text-[11px] text-foreground">
                        {card.id}
                      </span>
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge variant="secondary" className="font-mono text-[10px]">
                          {card.matcher || "*"}
                        </Badge>
                        {card.timeout !== null ? (
                          <Badge variant="ghost" className="font-mono text-[10px]">
                            {card.timeout}s
                          </Badge>
                        ) : null}
                      </div>
                      {card.scriptRel ? (
                        <span className="truncate font-mono text-[10px] text-muted-foreground/70">
                          {card.scriptRel}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Selected hook editor ────────────────────────────────────────── */}
      {!selected ? (
        <div className="rounded-lg border border-dashed border-border p-4">
          <p className="font-mono text-xs text-muted-foreground">
            Select a hook card above to edit its fields, body, and run it against
            a sample input.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono text-[10px]">
              {selected.event}
            </Badge>
            <span className="truncate font-mono text-xs text-foreground">
              {selected.id}
            </span>
          </div>

          {/* Field editors — each saves independently (minimal-diff JSON). */}
          <Field label="matcher" hint="tool-name matcher · e.g. Write|Edit, Bash, *">
            <div className="flex gap-2">
              <Input
                value={fieldValue("matcher")}
                disabled={blocked}
                placeholder="*"
                onChange={(e) => setField("matcher", e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={blocked || !("matcher" in edits)}
                onClick={() => saveField("matcher")}
              >
                Save
              </Button>
            </div>
          </Field>

          <Field label="timeout" hint="seconds · empty removes the key">
            <div className="flex gap-2">
              <Input
                type="number"
                min={0}
                value={fieldValue("timeout")}
                disabled={blocked}
                placeholder="(none)"
                className="w-40"
                onChange={(e) => setField("timeout", e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={blocked || !("timeout" in edits)}
                onClick={() => saveField("timeout")}
              >
                Save
              </Button>
            </div>
          </Field>

          <Field label="id" hint="stable group id — renaming re-keys the card">
            <div className="flex gap-2">
              <Input
                value={fieldValue("id")}
                disabled={blocked}
                onChange={(e) => setField("id", e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={blocked || !("id" in edits)}
                onClick={() => saveField("id")}
              >
                Save
              </Button>
            </div>
          </Field>

          <Field label="command" hint="the shell command this hook runs (read-only)">
            <pre className="overflow-x-auto rounded-lg border border-border bg-background/50 p-2 font-mono text-[11px] text-muted-foreground">
              {selected.command || "(no command)"}
            </pre>
          </Field>

          {/* ── Test vs sample stdin ──────────────────────────────────── */}
          <div className="rounded-lg border border-border bg-background/40 p-3">
            <p className="mb-2 font-mono text-[11px] font-medium text-muted-foreground">
              test vs sample stdin{" "}
              <span className="font-normal text-muted-foreground/60">
                (pipes a payload to the script — does NOT mutate anything)
              </span>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={samplePayload}
                onValueChange={(v) => setSamplePayload(v as string)}
              >
                <SelectTrigger className="w-72" disabled={blocked}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SAMPLE_PAYLOADS.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={blocked || !selected.scriptRel}
                onClick={runTest}
              >
                {busy === "Testing…" ? "Testing…" : "Run test"}
              </Button>
              {testResult ? (
                <Badge
                  variant="outline"
                  className={cn(
                    "font-mono text-[10px]",
                    testResult.verdict === "deny"
                      ? "border-destructive/40 bg-destructive/15 text-destructive"
                      : testResult.verdict === "error"
                        ? "border-amber-500/40 bg-amber-500/15 text-amber-500"
                        : "border-emerald-500/40 bg-emerald-500/15 text-emerald-500",
                  )}
                >
                  {testResult.verdict.toUpperCase()}
                </Badge>
              ) : null}
            </div>
            {testResult?.reason ? (
              <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {testResult.reason}
              </p>
            ) : testResult && testResult.verdict === "allow" ? (
              <p className="mt-2 font-mono text-[11px] text-muted-foreground/70">
                The hook permitted the sample input (no deny emitted).
              </p>
            ) : null}
            {testResult?.stderr ? (
              <pre className="mt-2 max-h-24 overflow-auto rounded border border-border bg-background/50 p-2 font-mono text-[10px] text-muted-foreground/70">
                {testResult.stderr.trim()}
              </pre>
            ) : null}
          </div>

          {/* ── .mjs body (Monaco) ────────────────────────────────────── */}
          {mjsRel ? (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-mono text-[11px] font-medium text-muted-foreground">
                  body{" "}
                  <span className="font-normal text-muted-foreground/60">
                    {mjsRel}
                    {mjsDirty ? " · unsaved" : ""}
                  </span>
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked || !mjsDirty}
                  onClick={saveMjs}
                >
                  {busy === "Saving script…" ? "Saving…" : "Save script"}
                </Button>
              </div>
              <div className="h-72 overflow-hidden rounded-lg border border-border">
                <MonacoEditor
                  height="100%"
                  language="javascript"
                  theme="vs-dark"
                  value={mjsSource}
                  onChange={(v) => {
                    setMjsSource(v ?? "");
                    setMjsDirty(true);
                  }}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 12,
                    fontFamily: "var(--font-geist-mono), monospace",
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                    tabSize: 2,
                    readOnly: blocked,
                  }}
                />
              </div>
            </div>
          ) : (
            <p className="font-mono text-[11px] text-muted-foreground/70">
              No editable script resolved for this hook (its command does not point
              at a repo hooks/*.mjs file).
            </p>
          )}

          {/* description — group-level, editable */}
          <Field label="description" hint="what this hook group does">
            <div className="flex flex-col gap-2">
              <Textarea
                value={fieldValue("description")}
                disabled={blocked}
                rows={3}
                onChange={(e) => setField("description", e.target.value)}
              />
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked || !("description" in edits)}
                  onClick={() => saveField("description")}
                >
                  Save description
                </Button>
              </div>
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}
