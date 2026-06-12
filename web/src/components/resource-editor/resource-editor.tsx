"use client";

/**
 * ResourceEditor — the dual-mode (Visual ⇄ Raw) shell for one resource.
 *
 * Three tabs over ONE source of truth (the `draft` = { frontmatter, body }):
 *   • Visual  — a per-kind FORM resolved by CONVENTION (forms/<kind>.tsx) that
 *               edits STRUCTURED frontmatter; the body stays verbatim.
 *   • Raw     — a Monaco editor over the WHOLE file text. Edits here are parsed
 *               back into the draft (frontmatter via js-yaml, body verbatim).
 *   • Validate/Preview — live `forge validate` findings from the last write plus
 *               the additive-write DIFF (draft vs the file on disk).
 *
 * Visual ⇄ Raw stay in sync: a Visual edit re-renders the Raw text via the SAME
 * byte-faithful core the bridge writes with (minimal-diff on update, clean
 * serialize on create); a Raw edit re-parses into the draft. The body is NEVER
 * reflowed.
 *
 * Writes go through /api/resource/[kind]/[id] (POST create · PUT update · DELETE
 * remove). The response is the bridge's CrudResult — its validate findings land
 * in the Validate tab; advisory WARNs are non-blocking (ADR-0007).
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { toast } from "sonner";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { RunEvalButton } from "@/components/run-eval-button";
import type { CrudResult } from "@/lib/forge-bridge/crud";
import type { Finding, ResourceKind } from "@/lib/types";

import type { ResourceDraft } from "./types";
import { FormSlot } from "./form-slot";
import { FindingsList } from "./findings";
import { DiffView } from "./diff-view";
import { draftToText, textToDraft } from "./serialize";

// Monaco is a heavy, browser-only widget — load it lazily, client-side only.
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

interface ResourceEditorProps {
  kind: ResourceKind;
  /** The resource id. On the create route this is the user-chosen new id. */
  id: string;
  /** Initial draft from the bridge (readResource). Empty defaults on create. */
  initial: ResourceDraft;
  /** True on the create route (POST), false on the edit route (PUT). */
  isNew: boolean;
  /**
   * The verbatim file text on disk at load time — the baseline for minimal-diff
   * and the Preview diff. Undefined on create (no file yet).
   */
  originalText?: string;
}

type WriteState = "idle" | "saving" | "deleting";

export function ResourceEditor({
  kind,
  id,
  initial,
  isNew,
  originalText,
}: ResourceEditorProps) {
  const router = useRouter();

  const [draft, setDraft] = React.useState<ResourceDraft>(initial);
  const [tab, setTab] = React.useState("visual");
  const [writeState, setWriteState] = React.useState<WriteState>("idle");
  const [findings, setFindings] = React.useState<Finding[]>([]);
  const [lastOk, setLastOk] = React.useState<boolean | null>(null);
  const [rawError, setRawError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // On the create route the user can pick the new id (must match the file name).
  const [newId, setNewId] = React.useState(id);
  const effectiveId = isNew ? newId.trim() : id;

  const busy = writeState !== "idle";

  // The text projection of the current draft (byte-faithful to what the bridge
  // would write: minimal-diff vs originalText on update; clean on create).
  const draftText = React.useMemo(
    () => draftToText(draft, isNew ? undefined : originalText, kind),
    [draft, isNew, originalText, kind],
  );

  // Baseline the Preview diffs against: the file on disk (or "" on create).
  const baseline = originalText ?? "";

  const dirty = isNew ? true : draftText !== baseline;

  // Eval-bearing kinds carry a grader (every editable kind except 'hook'). The
  // grade is fired against the artifact on disk, so it's only offered once the
  // resource exists (edit route, not create).
  const canEval = !isNew && kind !== "hook";

  // ── Visual → draft ────────────────────────────────────────────────────────
  const onFrontmatterChange = React.useCallback(
    (next: Record<string, unknown>) => {
      setDraft((d) => ({ ...d, frontmatter: next }));
      setRawError(null);
    },
    [],
  );

  // ── Raw → draft (parse the full text back; body stays verbatim) ───────────
  // The Raw text is the source of truth while this tab is active; the parse is
  // best-effort and lenient (it mirrors the writer's supported shapes), so the
  // Visual tab re-projects from whatever the Raw edit yielded.
  const onRawChange = React.useCallback(
    (value: string | undefined) => {
      const text = value ?? "";
      try {
        setDraft(textToDraft(text, kind));
        setRawError(null);
      } catch (err) {
        setRawError(err instanceof Error ? err.message : String(err));
      }
    },
    [kind],
  );

  // ── Write actions ─────────────────────────────────────────────────────────
  async function handleSave() {
    if (rawError) {
      toast.error("Fix the frontmatter YAML before saving.");
      setTab("raw");
      return;
    }
    if (isNew && !effectiveId) {
      toast.error("An id is required to create the resource.");
      return;
    }
    setWriteState("saving");
    try {
      const url = `/api/resource/${kind}/${encodeURIComponent(effectiveId)}`;
      const res = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
        cache: "no-store",
      });
      const json = (await res.json()) as
        | CrudResult
        | { ok: false; error: string };

      if (!res.ok || "error" in json) {
        const message =
          "error" in json ? json.error : `Write failed (${res.status}).`;
        toast.error(message);
        setLastOk(false);
        return;
      }

      setFindings(json.findings ?? []);
      setLastOk(json.ok);
      setTab("validate");

      const errors = (json.findings ?? []).filter(
        (f) => f.level === "ERROR",
      ).length;
      const warns = (json.findings ?? []).filter(
        (f) => f.level === "WARN",
      ).length;

      if (json.ok) {
        toast.success(
          `${isNew ? "Created" : "Saved"} ${kind}:${effectiveId}${
            warns ? ` · ${warns} warning${warns > 1 ? "s" : ""}` : ""
          }`,
        );
        if (isNew) {
          // Land on the canonical edit route for the freshly created resource.
          router.push(`/resources/${kind}/${encodeURIComponent(effectiveId)}`);
        } else {
          router.refresh();
        }
      } else {
        toast.error(
          `Validation failed — ${errors} error${errors > 1 ? "s" : ""}. The file was written; see Validate.`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setLastOk(false);
    } finally {
      setWriteState("idle");
    }
  }

  async function handleDelete() {
    setConfirmOpen(false);
    setWriteState("deleting");
    try {
      const url = `/api/resource/${kind}/${encodeURIComponent(id)}?confirm=1`;
      const res = await fetch(url, { method: "DELETE", cache: "no-store" });
      const json = (await res.json()) as
        | CrudResult
        | { ok: false; error: string };

      if (!res.ok || "error" in json) {
        const message =
          "error" in json ? json.error : `Delete failed (${res.status}).`;
        toast.error(message);
        return;
      }
      setFindings(json.findings ?? []);
      setLastOk(json.ok);
      toast.success(`Deleted ${kind}:${id}`);
      router.push("/resources");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setWriteState("idle");
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Action bar */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-1 pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px]">
            {kind}
          </Badge>
          {isNew ? (
            <Input
              value={newId}
              disabled={busy}
              placeholder="new-id"
              onChange={(e) => setNewId(e.target.value)}
              className="h-7 w-56 font-mono text-xs"
              aria-label="new resource id"
            />
          ) : (
            <span className="truncate font-mono text-xs text-foreground">
              {id}
            </span>
          )}
          {rawError ? (
            <Badge
              variant="outline"
              className="border-destructive/40 bg-destructive/15 font-mono text-[10px] text-destructive"
            >
              YAML error
            </Badge>
          ) : dirty ? (
            <Badge variant="secondary" className="font-mono text-[10px]">
              unsaved
            </Badge>
          ) : null}
          {lastOk === true ? (
            <Badge
              variant="outline"
              className="border-emerald-500/40 bg-emerald-500/15 font-mono text-[10px] text-emerald-500"
            >
              validate PASS
            </Badge>
          ) : lastOk === false ? (
            <Badge
              variant="outline"
              className="border-destructive/40 bg-destructive/15 font-mono text-[10px] text-destructive"
            >
              validate FAIL
            </Badge>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {canEval ? (
            <RunEvalButton
              target={`${kind}:${id}`}
              variant="outline"
              size="sm"
            />
          ) : null}
          {!isNew ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmOpen(true)}
            >
              {writeState === "deleting" ? "Deleting…" : "Delete"}
            </Button>
          ) : null}
          <Button size="sm" disabled={busy || !dirty} onClick={handleSave}>
            {writeState === "saving"
              ? "Saving…"
              : isNew
                ? "Create"
                : "Save"}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as string)}
        className="flex min-h-0 flex-1 flex-col gap-0 pt-3"
      >
        <TabsList>
          <TabsTrigger value="visual">Visual</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
          <TabsTrigger value="validate">Validate / Preview</TabsTrigger>
        </TabsList>

        {/* Visual — per-kind form (conventional forms/<kind>.tsx) */}
        <TabsContent value="visual" className="min-h-0 flex-1 overflow-y-auto pt-4">
          <div className="max-w-2xl">
            <FormSlot
              kind={kind}
              id={effectiveId}
              frontmatter={draft.frontmatter}
              onChange={onFrontmatterChange}
              isNew={isNew}
              disabled={busy}
            />
            <div className="mt-6 border-t border-border pt-4">
              <p className="mb-2 font-mono text-[11px] text-muted-foreground">
                body{" "}
                <span className="text-muted-foreground/60">
                  (markdown — edit in the Raw tab; preserved verbatim)
                </span>
              </p>
              <pre className="max-h-48 overflow-auto rounded-lg border border-border bg-background/50 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {draft.body.trim() || "(empty body)"}
              </pre>
            </div>
          </div>
        </TabsContent>

        {/* Raw — Monaco over the whole file text */}
        <TabsContent value="raw" className="min-h-0 flex-1 pt-4">
          <div className="flex h-full min-h-0 flex-col">
            {rawError ? (
              <p className="mb-2 font-mono text-[11px] text-destructive">
                frontmatter YAML: {rawError}
              </p>
            ) : null}
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
              <MonacoEditor
                height="100%"
                language="markdown"
                theme="vs-dark"
                value={draftText}
                onChange={onRawChange}
                options={{
                  minimap: { enabled: false },
                  fontSize: 12,
                  fontFamily: "var(--font-geist-mono), monospace",
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  renderWhitespace: "boundary",
                  tabSize: 2,
                  readOnly: busy,
                }}
              />
            </div>
          </div>
        </TabsContent>

        {/* Validate / Preview — last validate findings + additive-write diff */}
        <TabsContent
          value="validate"
          className="min-h-0 flex-1 overflow-y-auto pt-4"
        >
          <div className="flex max-w-3xl flex-col gap-6">
            <section>
              <h3 className="mb-2 font-mono text-[11px] font-medium text-muted-foreground">
                Pending write — additive diff{" "}
                <span className="text-muted-foreground/60">
                  (draft vs file on disk)
                </span>
              </h3>
              <DiffView original={baseline} next={draftText} isNew={isNew} />
            </section>
            <section>
              <h3 className="mb-2 font-mono text-[11px] font-medium text-muted-foreground">
                forge validate{" "}
                <span className="text-muted-foreground/60">
                  (from the last write — WARN/INFO are advisory)
                </span>
              </h3>
              {lastOk === null ? (
                <p className="font-mono text-xs text-muted-foreground">
                  Save to run <span className="text-foreground">forge validate</span>{" "}
                  and see findings here.
                </p>
              ) : (
                <FindingsList findings={findings} />
              )}
            </section>
          </div>
        </TabsContent>
      </Tabs>

      {/* Delete confirmation (guarded — the API also requires confirm:true) */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {kind}:{id}?</DialogTitle>
            <DialogDescription>
              This removes the file and rebuilds the registry. This cannot be
              undone from the editor.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" size="sm">
                  Cancel
                </Button>
              }
            />
            <Button variant="destructive" size="sm" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
