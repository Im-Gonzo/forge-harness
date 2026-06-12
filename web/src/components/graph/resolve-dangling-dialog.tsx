"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { FindingsList } from "./findings-list";
import type { DanglingRef, RegistryArtifact, EditResponse } from "./types";

interface Props {
  target: DanglingRef | null;
  artifacts: RegistryArtifact[];
  onClose: () => void;
  onResolved: () => void;
}

/**
 * The EDITABLE action: resolve a selected dangling reference by either removing
 * it or redirecting it to an existing artifact. Posts to /api/graph-edit, which
 * edits the source file(s) → validate → registry build, then refetches.
 */
export function ResolveDanglingDialog({
  target,
  artifacts,
  onClose,
  onResolved,
}: Props) {
  const [mode, setMode] = useState<"remove" | "redirect">("redirect");
  const [toId, setToId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EditResponse | null>(null);

  // Redirect candidates: prefer artifacts of the ref's inferred kind, then all.
  const candidates = useMemo(() => {
    if (!target) return [];
    const preferred = artifacts.filter((a) => a.kind === target.refKind);
    const rest = artifacts.filter((a) => a.kind !== target.refKind);
    return [...preferred, ...rest];
  }, [artifacts, target]);

  const open = target !== null;

  function reset() {
    setMode("redirect");
    setToId("");
    setBusy(false);
    setResult(null);
  }

  async function submit() {
    if (!target) return;
    if (mode === "redirect" && !toId) {
      toast.error("Pick an artifact to redirect to.");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/graph-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "resolve-dangling",
          rawRef: target.rawRef,
          sites: target.sites,
          op: mode,
          toId: mode === "redirect" ? toId : undefined,
        }),
      });
      const json = (await res.json()) as EditResponse;
      setResult(json);
      if (!res.ok || json.error) {
        toast.error(json.error ?? "Edit failed.");
        return;
      }
      const errors = json.validate?.summary?.errors ?? 0;
      if (errors > 0) {
        toast.error(`Validate reported ${errors} error(s) — see findings.`);
        return; // keep dialog open so the user sees the blocking findings
      }
      toast.success(
        mode === "remove"
          ? `Removed \`${target.rawRef}\` from ${json.edited?.length ?? 0} file(s).`
          : `Redirected \`${target.rawRef}\` → ${toId}.`,
      );
      reset();
      onResolved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            Resolve dangling reference
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {target ? (
              <>
                <span className="text-destructive">`{target.rawRef}`</span>{" "}
                referenced from{" "}
                <span className="text-foreground">{target.from}</span> does not
                resolve to a known artifact.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {target ? (
          <div className="space-y-3 font-mono text-xs">
            <div>
              <p className="mb-1 text-muted-foreground">
                Sites ({target.sites.length}):
              </p>
              <ul className="space-y-0.5">
                {target.sites.map((s, i) => (
                  <li key={i} className="break-all">
                    • {s.path}
                    {s.line ? `:${s.line}` : ""}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Action:</span>
              <div className="inline-flex overflow-hidden rounded-md border border-border">
                <button
                  className="px-2.5 py-1 text-[11px]"
                  style={{
                    background:
                      mode === "redirect" ? "var(--muted)" : "transparent",
                  }}
                  onClick={() => setMode("redirect")}
                >
                  Redirect
                </button>
                <button
                  className="border-l border-border px-2.5 py-1 text-[11px]"
                  style={{
                    background:
                      mode === "remove" ? "var(--muted)" : "transparent",
                  }}
                  onClick={() => setMode("remove")}
                >
                  Remove
                </button>
              </div>
            </div>

            {mode === "redirect" ? (
              <div className="space-y-1">
                <p className="text-muted-foreground">
                  Redirect to an existing artifact:
                </p>
                <Select value={toId} onValueChange={(v) => setToId(v as string)}>
                  <SelectTrigger className="w-full font-mono text-xs">
                    <SelectValue placeholder="Choose an artifact…" />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {candidates.map((a) => (
                      <SelectItem
                        key={a.uid}
                        value={a.id}
                        className="font-mono text-xs"
                      >
                        {a.id}
                        <Badge
                          variant="outline"
                          className="ml-1 text-[9px]"
                        >
                          {a.kind}
                        </Badge>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">
                  The raw token is rewritten to this id at every site, then the
                  registry is rebuilt.
                </p>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                The reference is removed from each site (frontmatter pointer line
                deleted, or inline backticks dropped to plain text), then the
                registry is rebuilt.
              </p>
            )}

            {result?.validate?.summary ? (
              <FindingsList
                findings={result.findings ?? []}
                summary={result.validate.summary}
              />
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "Applying…" : mode === "remove" ? "Remove ref" : "Redirect ref"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
