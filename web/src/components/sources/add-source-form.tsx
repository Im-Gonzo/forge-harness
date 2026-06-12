"use client";

/**
 * AddSourceForm — register a new federated source against the ACTIVE harness.
 *
 * Rides POST /api/sources { action:"add", id, url, ref?, kind? } (client → API
 * route → bridge → `forge source add … --apply`). forge-bridge is server-only,
 * so this never imports it — the action is always the HTTP round-trip, then a
 * router.refresh() to re-render the server-loaded table.
 *
 * id + url are required; ref defaults to "main" (CLI-side default too) and kind
 * defaults to "git". The CLI verb previews by default; the wrapper passes
 * --apply, so this form's submit IS the apply path.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  FolderGit2,
  Loader2,
  Lock,
  Pin,
  Plus,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TrustTag } from "@/components/forge";
import type { BridgeEnvelope, SourceKind } from "@/lib/types";

import { envelopeMessage } from "./source-helpers";

/**
 * The trust-gate a freshly-added source must clear before its resources become
 * readable. Purely a visual cue here (the gate runs server-side on sync/trust);
 * adding a source still just POSTs { action:"add" }.
 */
const TRUST_GATE = [
  { icon: Lock, label: "allowlist" },
  { icon: ScanSearch, label: "security scan" },
  { icon: ShieldCheck, label: "signature" },
  { icon: Pin, label: "pin ref" },
] as const;

/** Disabled while a submit is in flight (so the busy button can spin). */
export function AddSourceForm({ disabled }: { disabled?: boolean }) {
  const router = useRouter();

  const [id, setId] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [ref, setRef] = React.useState("main");
  const [kind, setKind] = React.useState<SourceKind>("git");
  const [busy, setBusy] = React.useState(false);

  const trimmedId = id.trim();
  const trimmedUrl = url.trim();
  const canSubmit = trimmedId !== "" && trimmedUrl !== "" && !busy && !disabled;

  const onSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      setBusy(true);
      try {
        const res = await fetch("/api/sources", {
          method: "POST",
          headers: { "content-type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            action: "add",
            id: trimmedId,
            url: trimmedUrl,
            ref: ref.trim() || undefined,
            kind,
          }),
        });
        const json = (await res.json()) as
          | BridgeEnvelope
          | { ok: false; error: string };
        if (!res.ok || !json.ok) {
          toast.error(
            "error" in json && typeof json.error === "string"
              ? json.error
              : envelopeMessage(
                  (json as BridgeEnvelope).findings,
                  "Failed to add source.",
                ),
          );
          return;
        }
        // Surface any non-fatal WARN (e.g. duplicate id skipped) but treat the
        // ok envelope as success.
        const warn = (json as BridgeEnvelope).findings?.find(
          (f) => f.level === "WARN",
        );
        if (warn) {
          toast.warning(warn.message);
        } else {
          toast.success(`Added source "${trimmedId}".`);
        }
        // Reset the entry fields (keep ref/kind defaults for the next add).
        setId("");
        setUrl("");
        setRef("main");
        setKind("git");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [canSubmit, trimmedId, trimmedUrl, ref, kind, router],
  );

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col overflow-hidden rounded-xl bg-card ring-1 ring-border"
    >
      {/* ── Header band ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <FolderGit2 className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[length:var(--text-2xs)] font-semibold uppercase tracking-wide text-foreground">
            Add source
          </p>
          <p className="font-mono text-[length:var(--text-2xs)] text-muted-foreground/70">
            federate a git repo or local path · read-only until it clears the
            trust gate
          </p>
        </div>
        <span className="hidden font-mono text-[length:var(--text-2xs)] text-muted-foreground/60 sm:inline">
          previews by default · this form applies
        </span>
      </div>

      {/* ── Entry fields ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,8rem)_minmax(0,7rem)_auto] lg:items-end">
        <Field label="id">
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="acme-skills"
            disabled={busy || disabled}
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field label="url / path">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/acme/skills.git"
            disabled={busy || disabled}
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field label="ref">
          <Input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="main"
            disabled={busy || disabled}
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field label="kind">
          <Select
            value={kind}
            onValueChange={(v) => setKind(v as SourceKind)}
            disabled={busy || disabled}
          >
            <SelectTrigger
              size="sm"
              className="w-full font-mono text-xs"
              aria-label="source kind"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>kind</SelectLabel>
                <SelectItem value="git" className="font-mono text-xs">
                  git
                </SelectItem>
                <SelectItem value="local" className="font-mono text-xs">
                  local
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Button type="submit" size="sm" disabled={!canSubmit}>
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
          Add
        </Button>
      </div>

      {/* ── Trust-gate footer (visual stepper; the gate runs on sync/trust) ── */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-border bg-muted/[0.12] px-4 py-3">
        <span className="font-mono text-[length:var(--text-2xs)] uppercase tracking-wide text-muted-foreground/70">
          trust gate
        </span>
        {TRUST_GATE.map((step, i) => (
          <React.Fragment key={step.label}>
            {i > 0 ? (
              <span aria-hidden className="text-muted-foreground/40">
                →
              </span>
            ) : null}
            <TrustTag label={step.label} icon={<step.icon />} />
          </React.Fragment>
        ))}
      </div>
    </form>
  );
}

/** A labelled vertical form field cell. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="font-mono text-[length:var(--text-2xs)] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
